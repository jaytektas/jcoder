import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type Mode = "ro" | "edit" | "auto";

export interface Config {
  /** OpenAI-compatible server root, without /v1. */
  baseUrl: string;
  /** Model id sent to the server; empty = first one /v1/models lists. */
  model: string;
  apiKey: string;
  /** Used when the server can't tell us its context size. */
  contextWindow: number;
  /** Ask the model to think (chat_template_kwargs.enable_thinking). */
  thinking: boolean;
  /** Print the model's thinking instead of a spinner. */
  showThinking: boolean;
  mode: Mode;
  /** Tool results longer than this are cut to head + tail. */
  maxToolChars: number;
  /** SearXNG server for the web_search tool; empty turns it off. */
  searchUrl: string;
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
  baseUrl: "http://127.0.0.1:8099",
  model: "",
  apiKey: "",
  contextWindow: 32768,
  thinking: true,
  showThinking: false,
  mode: "edit",
  maxToolChars: 24000,
  bashTimeout: 120,
  searchUrl: "http://127.0.0.1:8888",
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
  const cfg = { ...DEFAULTS, ...file };
  if (!exists || Object.keys(DEFAULTS).some((k) => !(k in file))) {
    try {
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...DEFAULTS, ...file }, null, 2) + "\n");
    } catch {}
  }
  return cfg;
}

/** Writes back only the settings the user can change from inside jcoder. */
export function saveConfig(cfg: Config): void {
  let file: Record<string, unknown> = {};
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {}
  for (const k of ["thinking", "showThinking", "mode"] as const) file[k] = cfg[k];
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(file, null, 2) + "\n");
}
