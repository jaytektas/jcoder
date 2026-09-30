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

/** A remote model the local one can ask for a second opinion (ask_model). */
export interface AskModel {
  name: string;
  /** OpenAI-compatible API root; chat/completions is added. */
  baseUrl: string;
  /** Empty = the tool is off. GEMINI_API_KEY in the environment works too. */
  apiKey: string;
  model: string;
}

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
  askModel: AskModel;
  /** Look for new releases on GitHub (at most once a day) and offer to install them. */
  checkUpdates: boolean;
  /** Seconds a bash command may run when the model doesn't say (it can ask for up to 600). */
  bashTimeout: number;
  /** Compact the conversation when the prompt passes this share of the window. */
  compactAt: number;
  /** Extra fields merged into every request (sampling params etc). */
  extraBody: Record<string, unknown>;
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
  searchUrl: "",
  checkUpdates: true,
  askModel: {
    name: "Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKey: "",
    model: "gemini-3.8-flash",
  },
  compactAt: 0.85,
  extraBody: {},
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
  const cfg = { ...DEFAULTS, ...file, askModel: { ...DEFAULTS.askModel, ...file.askModel } };
  if (!cfg.askModel.apiKey && process.env.GEMINI_API_KEY) cfg.askModel.apiKey = process.env.GEMINI_API_KEY;
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
