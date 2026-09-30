// jcoder — a coding agent for a local LLM server
// Copyright (C) 2026 Jason Roughley
// SPDX-License-Identifier: GPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option)
// any later version. It is distributed WITHOUT ANY WARRANTY; see the LICENSE
// file for details.

import readline from "node:readline/promises";
import { CONFIG_PATH, saveSettings, type Config } from "./config.js";
import { c } from "./ui.js";

/** Where the usual servers listen by default. */
const USUAL: [string, string][] = [
  ["llama.cpp", "http://127.0.0.1:8080"],
  ["LM Studio", "http://127.0.0.1:1234"],
  ["Ollama", "http://127.0.0.1:11434"],
  ["vLLM", "http://127.0.0.1:8000"],
];

type Probe = { ok: true; models: string[] } | { ok: false; why: string; needsKey?: boolean };

/** Asks a server for its models: the quickest proof it's an OpenAI-compatible server that answers. */
export async function probe(baseUrl: string, apiKey = ""): Promise<Probe> {
  try {
    const r = await fetch(`${baseUrl}/v1/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(2500),
    });
    if (r.status === 401 || r.status === 403) return { ok: false, why: "it wants an API key", needsKey: true };
    if (!r.ok) return { ok: false, why: `HTTP ${r.status}` };
    const j: any = await r.json();
    return { ok: true, models: (j.data ?? []).map((m: any) => m.id) };
  } catch (e: any) {
    const why = e.name === "TimeoutError" ? "no answer" : (e.cause?.code ?? e.cause?.message ?? e.message);
    return { ok: false, why: why === "ECONNREFUSED" ? "nothing listening" : String(why) };
  }
}

/** "192.168.1.20:8080" → "http://192.168.1.20:8080"; drops a trailing /v1 and slashes. */
export function normalizeUrl(input: string): string {
  let u = input.trim();
  if (!/^https?:\/\//i.test(u)) u = "http://" + u;
  return u.replace(/\/+$/, "").replace(/\/v1$/, "");
}

/**
 * Finds the model server: tries the usual ports, offers what answers, or
 * asks for an address (and a key if it wants one). Saves the answer in the
 * settings. Returns false if the user gave up.
 */
export async function setup(cfg: Config, reason?: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const say = (s = "") => process.stdout.write(s + "\n");
  try {
    say();
    say(c.bold("jcoder setup") + c.gray(" — finding your model server"));
    if (reason) say(c.yellow(reason));
    say();

    const candidates = [...USUAL];
    if (cfg.baseUrl && !candidates.some(([, u]) => u === cfg.baseUrl)) candidates.unshift(["your settings", cfg.baseUrl]);
    const results = await Promise.all(candidates.map(async ([name, url]) => ({ name, url, r: await probe(url, cfg.apiKey) })));
    const found = results.filter((x) => x.r.ok) as { name: string; url: string; r: { ok: true; models: string[] } }[];

    let chosen: { url: string; key: string } | null = null;
    if (found.length) {
      say("Found:");
      found.forEach((f, i) => say(`  ${i + 1}. ${f.url}  ${c.gray(`${f.name}${f.r.models[0] ? ` · ${f.r.models[0]}` : ""}`)}`));
      say();
      const a = (await rl.question(`Use which? ${c.gray("[1] or type another address")} `)).trim();
      const n = a === "" ? 1 : Number(a);
      if (Number.isInteger(n) && n >= 1 && n <= found.length) chosen = { url: found[n - 1].url, key: cfg.apiKey };
      else if (a) chosen = await ask(rl, say, a);
    } else {
      say(`No model server answered on the usual ports ${c.gray("(llama.cpp 8080, LM Studio 1234, Ollama 11434, vLLM 8000)")}.`);
      say(c.gray("Start one, or give its address — on this machine or another."));
      say();
      chosen = await ask(rl, say);
    }
    if (!chosen) return false;

    cfg.baseUrl = chosen.url;
    cfg.apiKey = chosen.key;
    cfg.model = "";
    saveSettings({ baseUrl: chosen.url, apiKey: chosen.key, model: "" });
    say(c.green(`Saved: ${chosen.url}`) + c.gray(`  (${CONFIG_PATH}; jcoder --setup to change it)`));
    say();
    return true;
  } finally {
    rl.close();
  }
}

/** Asks for an address until one answers; empty input gives up. */
async function ask(
  rl: readline.Interface,
  say: (s?: string) => void,
  first?: string,
): Promise<{ url: string; key: string } | null> {
  let input = first;
  for (;;) {
    if (input === undefined) input = (await rl.question(`Server address ${c.gray("(e.g. 192.168.1.20:8080, Enter to quit)")}: `)).trim();
    if (!input) return null;
    const url = normalizeUrl(input);
    let key = "";
    let r = await probe(url);
    if (!r.ok && r.needsKey) {
      key = (await rl.question("It wants an API key: ")).trim();
      r = await probe(url, key);
    }
    if (r.ok) {
      say(c.green(`✓ ${url} answers`) + c.gray(r.models[0] ? ` · ${r.models.join(", ")}` : ""));
      return { url, key };
    }
    say(c.red(`✗ ${url}: ${r.why}`));
    input = undefined;
  }
}
