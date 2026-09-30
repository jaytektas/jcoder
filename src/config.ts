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
  compactAt: 0.85,
  extraBody: {},
};

export function loadConfig(): Config {
  let file: Partial<Config> = {};
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (e: any) {
    if (e.code !== "ENOENT") throw new Error(`${CONFIG_PATH}: ${e.message}`);
  }
  return { ...DEFAULTS, ...file };
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
