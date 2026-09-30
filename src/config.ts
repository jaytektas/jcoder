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
  /** Sub-agents at once: 0 turns the agent tool off, a number caps them (never above the server's slots), -1 follows the server's slots. */
  maxAgents: number;
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

const DEFAULTS: Config = {
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
