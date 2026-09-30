import type { Config } from "./config.js";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type Part = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
/** Plain text, or text and images. */
export type Content = string | Part[];

export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: Content }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: Content };

export function textOf(c: Content | null): string {
  if (c === null) return "";
  if (typeof c === "string") return c;
  return c.map((p) => (p.type === "text" ? p.text : "[image]")).join("\n");
}

export const imageCount = (c: Content | null) =>
  Array.isArray(c) ? c.filter((p) => p.type === "image_url").length : 0;

export interface ToolSchema {
  type: "function";
  function: { name: string; description: string; parameters: object };
}

export interface Usage {
  prompt: number;
  completion: number;
  cached: number;
  genPerSec?: number;
}

export interface Reply {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  finish: string | null;
  usage?: Usage;
}

export interface Handlers {
  onReasoning?(text: string): void;
  onContent?(text: string): void;
  /** A tool call's arguments grew; `chars` is their length so far. */
  onToolArgs?(name: string, chars: number): void;
  /** llama.cpp reading the prompt: tokens done of the total, the cached part included. */
  onPromptProgress?(done: number, total: number, cached: number): void;
}

function headers(cfg: Config): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.apiKey) h.Authorization = `Bearer ${cfg.apiKey}`;
  return h;
}

export async function listModels(cfg: Config): Promise<string[]> {
  const r = await fetch(`${cfg.baseUrl}/v1/models`, { headers: headers(cfg) });
  if (!r.ok) throw new Error(`GET /v1/models: HTTP ${r.status}`);
  const j: any = await r.json();
  return (j.data ?? []).map((m: any) => m.id);
}

/** llama.cpp reports its context size at /props; other servers don't. */
export async function serverContext(cfg: Config): Promise<number | undefined> {
  try {
    const r = await fetch(`${cfg.baseUrl}/props`, { headers: headers(cfg) });
    if (!r.ok) return undefined;
    const j: any = await r.json();
    const n = j.default_generation_settings?.n_ctx;
    return typeof n === "number" && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Splits <think>...</think> out of content, for servers that don't put the
 * thinking in reasoning_content. Tags can arrive split across chunks.
 */
class ThinkSplitter {
  private inThink = false;
  private buf = "";
  constructor(private h: Handlers, private out: { content: string; reasoning: string }) {}

  push(text: string) {
    this.buf += text;
    for (;;) {
      const tag = this.inThink ? "</think>" : "<think>";
      const i = this.buf.indexOf(tag);
      if (i >= 0) {
        this.emit(this.buf.slice(0, i));
        this.buf = this.buf.slice(i + tag.length);
        this.inThink = !this.inThink;
        continue;
      }
      // Hold back a tail that could be the start of a tag.
      let keep = 0;
      for (let k = Math.min(tag.length - 1, this.buf.length); k > 0; k--) {
        if (tag.startsWith(this.buf.slice(-k))) {
          keep = k;
          break;
        }
      }
      this.emit(this.buf.slice(0, this.buf.length - keep));
      this.buf = this.buf.slice(this.buf.length - keep);
      return;
    }
  }

  flush() {
    this.emit(this.buf);
    this.buf = "";
  }

  private emit(s: string) {
    if (!s) return;
    if (this.inThink) {
      this.out.reasoning += s;
      this.h.onReasoning?.(s);
    } else {
      this.out.content += s;
      this.h.onContent?.(s);
    }
  }
}

export async function chat(
  cfg: Config,
  messages: Message[],
  tools: ToolSchema[],
  h: Handlers,
  signal: AbortSignal,
  opts: { thinking?: boolean; toolChoice?: "auto" | "none"; maxTokens?: number } = {},
): Promise<Reply> {
  const body: Record<string, unknown> = {
    ...cfg.extraBody,
    model: cfg.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    // llama.cpp: report progress while it reads the prompt. Others ignore it.
    return_progress: true,
    chat_template_kwargs: { enable_thinking: opts.thinking ?? cfg.thinking },
  };
  if (tools.length) body.tools = tools;
  if (opts.toolChoice) body.tool_choice = opts.toolChoice;
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;

  const r = await fetch(`${cfg.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: headers(cfg),
    body: JSON.stringify(body),
    signal,
  });
  if (!r.ok || !r.body) {
    const text = await r.text().catch(() => "");
    throw new Error(`HTTP ${r.status}: ${text.slice(0, 500)}`);
  }

  const out: Reply = { content: "", reasoning: "", toolCalls: [], finish: null };
  const splitter = new ThinkSplitter(h, out);
  const decoder = new TextDecoder();
  let pending = "";

  const handle = (data: string) => {
    if (data === "[DONE]") return;
    const j = JSON.parse(data);
    if (j.error) throw new Error(j.error.message ?? JSON.stringify(j.error));
    const pp = j.prompt_progress;
    if (pp && typeof pp.total === "number") h.onPromptProgress?.(pp.cache + pp.processed, pp.total, pp.cache);
    if (j.usage) {
      out.usage = {
        prompt: j.usage.prompt_tokens ?? 0,
        completion: j.usage.completion_tokens ?? 0,
        cached: j.usage.prompt_tokens_details?.cached_tokens ?? j.timings?.cache_n ?? 0,
        genPerSec: j.timings?.predicted_per_second,
      };
    }
    const choice = j.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) out.finish = choice.finish_reason;
    const d = choice.delta ?? {};
    if (d.reasoning_content) {
      out.reasoning += d.reasoning_content;
      h.onReasoning?.(d.reasoning_content);
    }
    if (d.content) splitter.push(d.content);
    for (const tc of d.tool_calls ?? []) {
      const slot = (out.toolCalls[tc.index ?? 0] ??= {
        id: "",
        type: "function",
        function: { name: "", arguments: "" },
      });
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.function.name += tc.function.name;
      if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
      h.onToolArgs?.(slot.function.name, slot.function.arguments.length);
    }
  };

  const reader = r.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, nl).trim();
      pending = pending.slice(nl + 1);
      if (line.startsWith("data:")) handle(line.slice(5).trim());
    }
  }
  splitter.flush();
  out.toolCalls = out.toolCalls.filter(Boolean);
  out.toolCalls.forEach((tc, i) => (tc.id ||= `call_${Date.now()}_${i}`));
  return out;
}
