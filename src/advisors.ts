// jcoder — a coding agent for a local LLM server
// Copyright (C) 2026 Jason Roughley
// SPDX-License-Identifier: GPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option)
// any later version. It is distributed WITHOUT ANY WARRANTY; see the LICENSE
// file for details.

/** A remote model the local one can ask for a second opinion. */
export interface Advisor {
  name: string;
  /** OpenAI-compatible API root; chat/completions is added. */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** How long to wait for an answer, ms. */
  timeoutMs: number;
}

/** What goes in the settings: a preset and a key, or everything spelled out. */
export interface AdvisorSetting {
  preset?: string;
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  /** Seconds to wait for this one's answer; default the advisorTimeout setting. */
  timeout?: number;
}

interface Preset {
  name: string;
  baseUrl: string;
  model: string;
  /** Where the key can also come from. */
  env: string;
  /** Where to get a key. */
  signup: string;
}

/**
 * Providers with an OpenAI-compatible API, most with a free tier. Addresses
 * and models were checked against each provider when added; a setting's own
 * model or baseUrl overrides them.
 */
export const PRESETS: Record<string, Preset> = {
  gemini: {
    name: "Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-3.8-flash",
    env: "GEMINI_API_KEY",
    signup: "https://aistudio.google.com/apikey",
  },
  groq: {
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "openai/gpt-oss-120b",
    env: "GROQ_API_KEY",
    signup: "https://console.groq.com/keys",
  },
  cerebras: {
    name: "Cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    model: "gpt-oss-120b",
    env: "CEREBRAS_API_KEY",
    signup: "https://cloud.cerebras.ai",
  },
  openrouter: {
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openrouter/free",
    env: "OPENROUTER_API_KEY",
    signup: "https://openrouter.ai/keys",
  },
  nvidia: {
    name: "NVIDIA",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    model: "moonshotai/kimi-k3",
    env: "NVIDIA_API_KEY",
    signup: "https://build.nvidia.com",
  },
  anthropic: {
    name: "Claude",
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-opus-5-5",
    env: "ANTHROPIC_API_KEY",
    signup: "https://platform.claude.com",
  },
};

/**
 * The advisors ready to use, in order: those in the settings, then any
 * preset whose key is in the environment and isn't in the settings already.
 * Entries without a key, address or model are left out.
 */
export function resolveAdvisors(settings: AdvisorSetting[], timeoutSecs: number): Advisor[] {
  const out: Advisor[] = [];
  const used = new Set<string>();
  for (const s of settings) {
    const p = s.preset ? PRESETS[s.preset.toLowerCase()] : undefined;
    if (s.preset) used.add(s.preset.toLowerCase());
    const a: Advisor = {
      name: s.name ?? p?.name ?? s.preset ?? "advisor",
      baseUrl: (s.baseUrl ?? p?.baseUrl ?? "").replace(/\/+$/, ""),
      apiKey: s.apiKey || (p ? (process.env[p.env] ?? "") : ""),
      model: s.model ?? p?.model ?? "",
      timeoutMs: Math.max(5, s.timeout ?? timeoutSecs) * 1000,
    };
    if (a.baseUrl && a.apiKey && a.model) out.push(a);
  }
  for (const [id, p] of Object.entries(PRESETS)) {
    const key = process.env[p.env];
    if (key && !used.has(id)) out.push({ name: p.name, baseUrl: p.baseUrl, apiKey: key, model: p.model, timeoutMs: Math.max(5, timeoutSecs) * 1000 });
  }
  return out;
}

/** notes: one line per advisor that didn't answer, with why. */
export type Answer = { ok: true; text: string; advisor: Advisor; notes: string[] } | { ok: false; notes: string[] };

/** Worth trying again or trying elsewhere: busy, rate-limited, down, or unreachable. */
const transient = (status: number) => status === 429 || status >= 500;

async function askOne(a: Advisor, question: string, signal: AbortSignal, timeoutMs: number): Promise<{ text?: string; status: number; why?: string }> {
  try {
    const r = await fetch(`${a.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${a.apiKey}` },
      body: JSON.stringify({ model: a.model, messages: [{ role: "user", content: question }] }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    });
    const body = await r.text();
    if (!r.ok) return { status: r.status, why: `HTTP ${r.status}${body ? `: ${body.replace(/\s+/g, " ").slice(0, 160)}` : ""}` };
    const text = JSON.parse(body).choices?.[0]?.message?.content ?? "";
    return text ? { text, status: 200 } : { status: 200, why: "an empty answer" };
  } catch (e: any) {
    if (signal.aborted) throw e;
    return { status: 0, why: e.name === "TimeoutError" ? `no answer in ${timeoutMs / 1000}s` : (e.cause?.code ?? e.message) };
  }
}

/**
 * Asks the preferred advisor, then the others in order when one fails. If
 * they all failed and some only for the moment (busy, rate-limited, down,
 * unreachable), those get another go after a pause: two more with a single
 * advisor, since there's nowhere else to go, one otherwise.
 */
export async function ask(
  advisors: Advisor[],
  question: string,
  preferred: string | undefined,
  signal: AbortSignal,
  /** once: one try each, no second round, at most this many ms (for a quick test). */
  once?: { maxMs: number },
): Promise<Answer> {
  const failed = new Map<string, string>(); // name -> latest reason
  const notes = () => [...failed].map(([name, why]) => `${name}: ${why}`);
  const first = advisors.find((a) => a.name.toLowerCase() === preferred?.toLowerCase());
  let todo = first ? [first, ...advisors.filter((a) => a !== first)] : advisors;
  const pauses = once ? [0] : [0, ...(todo.length === 1 ? [3000, 8000] : [5000])];
  for (const pause of pauses) {
    if (pause) await new Promise((res) => setTimeout(res, pause));
    const again: Advisor[] = [];
    for (const a of todo) {
      if (signal.aborted) return { ok: false, notes: [...notes(), "interrupted"] };
      const r = await askOne(a, question, signal, once ? Math.min(once.maxMs, a.timeoutMs) : a.timeoutMs);
      if (r.text) {
        failed.delete(a.name);
        return { ok: true, text: r.text, advisor: a, notes: notes() };
      }
      failed.set(a.name, r.why ?? "no answer");
      if (r.status === 0 || transient(r.status)) again.push(a);
    }
    if (!again.length) break;
    todo = again;
  }
  return { ok: false, notes: notes() };
}
