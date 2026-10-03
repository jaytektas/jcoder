// jcoder — a coding agent for a local LLM server
// Copyright (C) 2026 Jason Roughley
// SPDX-License-Identifier: GPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option)
// any later version. It is distributed WITHOUT ANY WARRANTY; see the LICENSE
// file for details.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type Mode = "ro" | "edit" | "auto";

/** How hard the model thinks: off, or a cap on its thinking tokens. */
export type Effort = "off" | "low" | "medium" | "high" | "max";
export const EFFORTS: Effort[] = ["off", "low", "medium", "high", "max"];
/** Thinking tokens allowed per reply; -1 = no limit. */
export const EFFORT_BUDGET: Record<Effort, number> = { off: 0, low: 512, medium: 2048, high: 8192, max: -1 };

import type { AdvisorSetting, DropPolicy } from "./advisors.js";

export interface Config {
  /** OpenAI-compatible server root, without /v1. */
  baseUrl: string;
  /** Model id sent to the server; empty = first one /v1/models lists. */
  model: string;
  apiKey: string;
  /** Used when the server can't tell us its context size. */
  contextWindow: number;
  /** off | low | medium | high | max: thinking off, or capped at 512 / 2048 / 8192 tokens, or unlimited. */
  effort: Effort;
  /** Print the model's thinking instead of a spinner. */
  showThinking: boolean;
  mode: Mode;
  /** Tool results longer than this are cut to head + tail. */
  maxToolChars: number;
  /** SearXNG server for the web_search tool; empty turns it off. */
  searchUrl: string;
  /** Remote models for ask_model: {preset, apiKey} or {name, baseUrl, apiKey, model}. See advisors.ts. */
  advisors: AdvisorSetting[];
  /** Seconds to wait for an advisor's answer before trying the next (each can set its own "timeout"). */
  advisorTimeout: number;
  /** An advisor that stops answering (timeout, unreachable, bad key, or busy 3 times running): keep trying ("never"); skip it until restart ("session"); for a "day", "week", "month" or "year" (sets its disabledUntil here); or for good ("permanent", sets its disabled here). */
  dropAdvisors: DropPolicy;
  /** Look for new releases on GitHub (at most once a day) and offer to install them. */
  checkUpdates: boolean;
  /** Other servers to run sub-agents on (say a fast small model on another machine), tried before the main one. */
  agentServers: AgentServer[];
  /** Run sub-agents on the main server too, when the agent servers are busy or there are none. */
  agentsOnMain: boolean;
  /** Sub-agents at once: 0 turns the agent tool off, a number caps them (never above the servers' slots), -1 follows the servers' slots. */
  maxAgents: number;
  /** Requests the main server runs at once, for sub-agents: 0 = what it reports (llama.cpp does), or 4 when it doesn't say. */
  slots: number;
  /** Tool calls a sub-agent may make: told to wrap up at two thirds, then stopped for its report. */
  agentMaxTools: number;
  /** Seconds a bash command may run when the model doesn't say (it can ask for up to 600). */
  bashTimeout: number;
  /** Compact the conversation when the prompt passes this share of the window. */
  compactAt: number;
  /** Extra fields merged into every request. */
  extraBody: Record<string, unknown>;
  /**
   * Sampling per model: key = model id, a pattern like "qwen*", or "*"; the
   * most specific match wins. "thinking" is sent when effort isn't off,
   * "noThinking" when it is; fields go to the server as written. A model
   * with no match gets the server's own settings.
   */
  sampling: Record<string, SamplingProfile>;
}

/** A server for sub-agents. Model, slots and context come from the server when left out. */
export interface AgentServer {
  name?: string;
  /** Server root, without /v1. */
  baseUrl: string;
  apiKey?: string;
  model?: string;
  /** Agents it runs at once; llama.cpp reports its slots. */
  slots?: number;
  disabled?: boolean;
}

export interface SamplingProfile {
  thinking?: Record<string, unknown>;
  noThinking?: Record<string, unknown>;
}

/** The sampling entry for a model, and which key matched: exact id, then the longest matching pattern, then "*". */
export function samplingFor(cfg: Config): { key: string; profile: SamplingProfile } | null {
  const model = cfg.model.toLowerCase();
  const entries = Object.entries(cfg.sampling ?? {});
  const exact = entries.find(([k]) => k.toLowerCase() === model);
  if (exact) return { key: exact[0], profile: exact[1] };
  const glob = (k: string) => new RegExp("^" + k.toLowerCase().replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
  const patterns = entries.filter(([k]) => k !== "*" && /[*?]/.test(k) && glob(k).test(model)).sort((a, b) => b[0].length - a[0].length);
  if (patterns.length) return { key: patterns[0][0], profile: patterns[0][1] };
  const any = entries.find(([k]) => k === "*");
  return any ? { key: "*", profile: any[1] } : null;
}

export const HOME = path.join(os.homedir(), ".jcoder");
export const CONFIG_PATH = process.env.JCODER_CONFIG || path.join(HOME, "config.json");

export const DEFAULTS: Config = {
  baseUrl: "http://127.0.0.1:8080",
  model: "",
  apiKey: "",
  contextWindow: 32768,
  effort: "high",
  showThinking: false,
  mode: "edit",
  maxToolChars: 24000,
  bashTimeout: 120,
  maxAgents: -1,
  slots: 0,
  agentMaxTools: 45,
  agentServers: [],
  agentsOnMain: true,
  searchUrl: "",
  checkUpdates: true,
  advisors: [],
  advisorTimeout: 90,
  dropAdvisors: "session",
  compactAt: 0.85,
  extraBody: {},
  sampling: {},
};

/**
 * Reads the settings file. It is written with every setting and its default
 * the first time, and settings added in later versions are filled in, so the
 * file always shows everything there is to change.
 */
export function loadConfig(): Config {
  let file: Partial<Config> = {};
  let exists = true;
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (e: any) {
    if (e.code !== "ENOENT") throw new Error(`${CONFIG_PATH}: ${e.message}`);
    exists = false;
  }
  const cfg = { ...DEFAULTS, ...file };
  if (!exists || Object.keys(DEFAULTS).some((k) => !(k in file))) {
    try {
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...DEFAULTS, ...file }, null, 2) + "\n");
    } catch {}
  }
  return cfg;
}

/** Writes the given settings into the file, leaving the rest as they are. */
export function saveSettings(values: Partial<Config>): void {
  let file: Record<string, unknown> = {};
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {}
  Object.assign(file, values);
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(file, null, 2) + "\n");
}

/** Writes back only the settings the user can change from inside jcoder. */
export function saveConfig(cfg: Config): void {
  let file: Record<string, unknown> = {};
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {}
  for (const k of ["effort", "showThinking", "mode", "checkUpdates"] as const) file[k] = cfg[k];
  delete file.thinking;
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(file, null, 2) + "\n");
}

/** Settings that take effect at once when changed with /setting; the rest at the next start. */
export const LIVE_SETTINGS = new Set<keyof Config>(["effort", "showThinking", "mode", "maxToolChars", "bashTimeout", "compactAt", "dropAdvisors", "maxAgents", "agentMaxTools", "extraBody", "sampling"]);

const CHOICES: Partial<Record<keyof Config, readonly string[]>> = {
  effort: EFFORTS,
  mode: ["ro", "edit", "auto"],
  dropAdvisors: ["never", "session", "day", "week", "month", "year", "permanent"],
};

/** The setting a name means: any case, with or without - and _ ("maxagents", "max_agents"). */
export function settingName(name: string): keyof Config | undefined {
  const n = name.toLowerCase().replace(/[-_]/g, "");
  return (Object.keys(DEFAULTS) as (keyof Config)[]).find((k) => k.toLowerCase() === n);
}

/** A setting's value typed by the user, checked against its kind: a value, or why it won't do. */
export function parseSetting(key: keyof Config, text: string): { value: unknown } | { error: string } {
  const def = DEFAULTS[key];
  const choices = CHOICES[key];
  if (choices) return choices.includes(text) ? { value: text } : { error: `${key} is one of: ${choices.join(", ")}` };
  if (typeof def === "boolean") {
    if (/^(true|on|yes|1)$/i.test(text)) return { value: true };
    if (/^(false|off|no|0)$/i.test(text)) return { value: false };
    return { error: `${key} is on or off` };
  }
  if (typeof def === "number") {
    const n = key === "maxAgents" && text === "off" ? 0 : Number(text);
    if (text === "" || !Number.isFinite(n)) return { error: `${key} is a number` };
    if (key === "maxAgents" && (!Number.isInteger(n) || n < -1)) return { error: "maxAgents is -1 (the server's slots), 0 (off) or a cap" };
    if (key === "compactAt" && !(n > 0 && n <= 1)) return { error: "compactAt is a share of the window, above 0 and up to 1 (e.g. 0.85)" };
    if (key === "slots" && (!Number.isInteger(n) || n < 0)) return { error: "slots is 0 (what the server reports) or a number" };
    if (key === "agentMaxTools" && (!Number.isInteger(n) || n < 1)) return { error: "agentMaxTools is a whole number above 0" };
    if (key !== "maxAgents" && key !== "slots" && n <= 0) return { error: `${key} is above 0` };
    return { value: n };
  }
  if (typeof def === "string") return { value: text === '""' ? "" : text };
  // Lists and objects are written as JSON.
  try {
    const v = JSON.parse(text);
    if (Array.isArray(def) !== Array.isArray(v) || typeof v !== "object" || v === null) throw new Error();
    return { value: v };
  } catch {
    return { error: `${key} is JSON: ${Array.isArray(def) ? "a list, [...]" : "an object, {...}"}` };
  }
}
