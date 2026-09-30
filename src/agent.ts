import { chat, imageCount, textOf, type Content, type Message, type Part, type Reply, type ToolCall } from "./client.js";
import type { Config } from "./config.js";
import type { Image } from "./images.js";
import { log, saveSession, storeContent, type Session } from "./session.js";
import { SCHEMAS, TOOLS, type Approval, type ToolContext, type ToolResult } from "./tools.js";
import { preview } from "./ui.js";
import type { View } from "./view.js";

export const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export class Agent {
  /** Tokens the next request's prompt will be, roughly: last prompt + last reply. */
  used = 0;
  private lastCached = 0;
  private lastPrompt = 0;
  private lastSpeed?: number;
  /** path -> mtime when the model last read or wrote it. */
  readonly seen = new Map<string, number>();
  private allowed = new Set<string>();
  private abort?: AbortController;
  /** Consecutive identical tool calls, to catch loops. */
  private repeat = { key: "", result: "", count: 0 };

  constructor(
    private cfg: Config,
    public session: Session,
    public contextWindow: number,
    private view: View,
  ) {}

  get messages(): Message[] {
    return this.session.messages;
  }

  get running(): boolean {
    return this.abort !== undefined;
  }

  stop(): void {
    this.abort?.abort();
  }

  toolContext(signal: AbortSignal): ToolContext {
    return {
      cwd: this.session.cwd,
      mode: this.cfg.mode,
      signal,
      maxChars: this.cfg.maxToolChars,
      bashTimeout: this.cfg.bashTimeout,
      searchUrl: this.cfg.searchUrl,
      approve: (t, summary) => this.approve(t, summary),
      seen: this.seen,
    };
  }

  /** Runs one user request to the end: model, tools, model, ... */
  async turn(text: string, images: Image[] = []): Promise<void> {
    const content: Content = images.length
      ? [{ type: "text", text }, ...images.map((i): Part => ({ type: "image_url", image_url: { url: i.url } }))]
      : text;
    this.messages.push({ role: "user", content });
    log(this.session, { type: "user", content: storeContent(content) });
    this.abort = new AbortController();
    const signal = this.abort.signal;
    const started = Date.now();
    try {
      for (;;) {
        if (this.used > this.cfg.compactAt * this.contextWindow) await this.compact(signal, true);
        const reply = await this.generate(signal);
        if (!reply) break;
        log(this.session, {
          type: "assistant",
          content: reply.content,
          reasoning: reply.reasoning || undefined,
          tool_calls: reply.toolCalls.length ? reply.toolCalls : undefined,
          finish: reply.finish,
          usage: reply.usage,
        });
        this.messages.push({
          role: "assistant",
          content: reply.content || null,
          ...(reply.toolCalls.length ? { tool_calls: reply.toolCalls } : {}),
        });
        if (reply.finish === "length") {
          this.view.notice("The reply hit the server's length limit, or the context is full.", "warn");
          break;
        }
        if (!reply.toolCalls.length) break;
        await this.runTools(reply.toolCalls, signal);
        if (signal.aborted) break;
      }
    } catch (e: any) {
      if (!signal.aborted) this.view.notice(`error: ${e.message}`, "error");
      log(this.session, { type: "error", message: e.message });
    } finally {
      this.abort = undefined;
      saveSession(this.session);
    }
    this.view.turnDone({
      seconds: (Date.now() - started) / 1000,
      status: this.used ? this.status() : "",
      stopped: signal.aborted,
    });
  }

  status(): string {
    const parts = [`ctx ${k(this.used)}/${k(this.contextWindow)} (${this.usedPct}%)`];
    if (this.lastPrompt) parts.push(`cache ${Math.round((100 * this.lastCached) / this.lastPrompt)}%`);
    if (this.lastSpeed) parts.push(`${this.lastSpeed.toFixed(0)} tok/s`);
    return parts.join(" · ");
  }

  get usedPct(): number {
    return Math.round((100 * this.used) / this.contextWindow);
  }

  /** One model call, streamed to the view. Returns null if interrupted or failed. */
  private async generate(signal: AbortSignal): Promise<Reply | null> {
    let thinkTokens = 0;
    let printed = "";
    this.view.busy("Thinking");
    try {
      const reply = await chat(
        this.cfg,
        this.messages,
        SCHEMAS,
        {
          onReasoning: (t) => {
            thinkTokens++;
            if (this.cfg.showThinking) this.view.thinking(t);
            this.view.busy("Thinking", `${k(thinkTokens)} tokens`);
          },
          onContent: (t) => {
            printed += t;
            this.view.text(t);
            this.view.busy("Writing");
          },
          onToolArgs: (name, chars) => this.view.busy(`Preparing ${name}`, `${k(chars)} chars`),
        },
        signal,
      );
      this.view.endMessage();
      if (reply.usage) {
        this.lastPrompt = reply.usage.prompt;
        this.lastCached = reply.usage.cached;
        this.used = reply.usage.prompt + reply.usage.completion;
        if (reply.usage.genPerSec) this.lastSpeed = reply.usage.genPerSec;
      }
      if (!reply.content && !reply.toolCalls.length && reply.reasoning)
        this.view.notice("The model only thought and gave no answer.", "warn");
      return reply;
    } catch (e: any) {
      this.view.endMessage();
      if (signal.aborted) {
        // Keep the history well-formed: every user message gets an answer.
        this.messages.push({ role: "assistant", content: (printed ? printed + "\n" : "") + "[interrupted by the user]" });
        log(this.session, { type: "interrupted", content: printed });
        return null;
      }
      this.view.notice(`error: ${e.message}`, "error");
      this.messages.push({ role: "assistant", content: `[request failed: ${e.message}]` });
      log(this.session, { type: "error", message: e.message });
      return null;
    }
  }

  private async runTools(calls: ToolCall[], signal: AbortSignal): Promise<void> {
    for (const call of calls) {
      const result: ToolResult = signal.aborted
        ? { content: "Not run: the user interrupted.", error: true }
        : await this.runTool(call, signal);
      this.messages.push({ role: "tool", tool_call_id: call.id, content: result.content });
      log(this.session, {
        type: "tool",
        id: call.id,
        name: call.function.name,
        content: storeContent(result.content),
        error: result.error || undefined,
      });
    }
  }

  private async runTool(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
    const name = call.function.name;
    const tool = TOOLS[name];
    let args: any;
    try {
      args = JSON.parse(call.function.arguments || "{}");
    } catch {
      this.view.tool(name, "");
      this.view.result("bad arguments", true);
      return { content: `Your arguments for ${name} were not valid JSON. Send them again.`, error: true };
    }
    if (!tool) {
      this.view.tool(name, "");
      this.view.result("no such tool", true);
      return { content: `There is no tool called ${name}. Tools: ${Object.keys(TOOLS).join(", ")}.`, error: true };
    }
    this.view.tool(name, tool.summary(args));
    this.view.busy(`Running ${name}`);

    let result: ToolResult;
    if (this.cfg.mode === "ro" && tool.writes) {
      result = { content: `Read-only mode: ${name} is not allowed. Tell the user what you would do instead.`, error: true };
    } else {
      try {
        result = await tool.run(args, this.toolContext(signal));
      } catch (e: any) {
        result = { content: `${name} failed: ${e.message}`, error: true };
      }
    }
    this.view.result(result.display ?? preview(textOf(result.content), 6), !!result.error);

    const key = name + call.function.arguments;
    const text = textOf(result.content);
    if (key === this.repeat.key && text === this.repeat.result) this.repeat.count++;
    else this.repeat = { key, result: text, count: 1 };
    if (this.repeat.count >= 3 && typeof result.content === "string")
      result.content += `\n\n[You have made this exact call ${this.repeat.count} times with the same result. Stop and try something different.]`;
    return result;
  }

  private async approve(tool: string, summary: string): Promise<Approval> {
    const mode = this.cfg.mode;
    if (mode === "auto" || this.allowed.has(tool)) return { ok: true };
    if (mode === "edit" && (tool === "write_file" || tool === "edit_file")) return { ok: true };
    const a = await this.view.approve(tool, summary);
    if (a.always) this.allowed.add(tool);
    return a;
  }

  /**
   * Replaces the history with a summary. It sends the same tools and history
   * as a normal turn so the server can reuse its cache for all of it.
   */
  async compact(signal: AbortSignal, midTurn: boolean): Promise<void> {
    const lastUser = [...this.messages].reverse().find((m) => m.role === "user");
    const ask =
      "Stop working for a moment. The conversation is about to be cut to save space. " +
      "Write a summary that lets you carry on without it: the user's goal and requests, " +
      "decisions made, files changed and how, the current state (what works, what fails, exact errors), " +
      "and the next steps. Be specific: paths, function names, commands. No tool calls.";
    this.view.busy("Compacting");
    let chars = 0;
    const reply = await chat(
      this.cfg,
      [...this.messages, { role: "user", content: ask }],
      SCHEMAS,
      { onContent: (t) => this.view.busy("Compacting", `${k((chars += t.length))} chars`) },
      signal,
      { thinking: false, toolChoice: "none" },
    );
    const summary = reply.content.trim();
    if (!summary) throw new Error("compaction produced no summary");
    const before = this.used;
    let text = `This conversation was compacted to save space. Summary of it so far:\n\n${summary}`;
    let images: Part[] = [];
    if (midTurn && lastUser) {
      text += `\n\nThe user's latest request, word for word:\n${textOf(lastUser.content)}\n\nCarry on with it.`;
      if (Array.isArray(lastUser.content)) images = lastUser.content.filter((p) => p.type === "image_url");
    }
    const content: Content = images.length ? [{ type: "text", text }, ...images] : text;
    log(this.session, { type: "compact", tokensBefore: this.used, summary });
    this.session.messages = [this.messages[0], { role: "user", content }];
    if (!midTurn) this.session.messages.push({ role: "assistant", content: "Got it. What next?" });
    this.estimateUsed();
    this.seen.clear();
    this.view.notice(`Compacted: ~${k(before)} → ~${k(this.used)} tokens`);
    saveSession(this.session);
  }

  /** /compact from the prompt. */
  async compactNow(): Promise<void> {
    this.abort = new AbortController();
    const signal = this.abort.signal;
    try {
      await this.compact(signal, false);
    } catch (e: any) {
      this.view.notice(signal.aborted ? "Compaction stopped." : `error: ${e.message}`, signal.aborted ? "warn" : "error");
    } finally {
      this.abort = undefined;
    }
  }

  /** Estimate after loading a saved session; corrected by the first reply. */
  estimateUsed(): void {
    // ~3.5 characters a token; an image is at most --image-max-tokens (1024 here).
    let chars = JSON.stringify(SCHEMAS).length;
    let images = 0;
    for (const m of this.messages) {
      chars += textOf(m.content).length;
      images += imageCount(m.content);
      if (m.role === "assistant" && m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
    }
    this.used = Math.ceil(chars / 3.5) + images * 1024;
  }
}
