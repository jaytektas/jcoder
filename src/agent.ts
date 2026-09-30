import { chat, type Message, type Reply, type ToolCall } from "./client.js";
import type { Config } from "./config.js";
import { saveSession, type Session } from "./session.js";
import { SCHEMAS, TOOLS, type Approval, type ToolContext, type ToolResult } from "./tools.js";
import { c, indent, preview, readLine, Spinner, watchKeys, write } from "./ui.js";

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export class Agent {
  /** Tokens the next request's prompt will be, roughly: last prompt + last reply. */
  private used = 0;
  private lastCached = 0;
  private lastPrompt = 0;
  private lastSpeed?: number;
  private seen = new Map<string, number>();
  private allowed = new Set<string>();
  private spinner = new Spinner();
  private abort?: AbortController;
  private unwatch = () => {};
  /** Consecutive identical tool calls, to catch loops. */
  private repeat = { key: "", result: "", count: 0 };

  constructor(
    private cfg: Config,
    public session: Session,
    public contextWindow: number,
    private interactive: boolean,
  ) {}

  get messages(): Message[] {
    return this.session.messages;
  }

  /** Runs one user request to the end: model, tools, model, ... */
  async turn(text: string): Promise<void> {
    this.messages.push({ role: "user", content: text });
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.unwatch = this.interactive ? this.watch() : () => {};
    try {
      for (;;) {
        if (this.used > this.cfg.compactAt * this.contextWindow) await this.compact(signal, true);
        const reply = await this.generate(signal);
        if (!reply) break;
        this.messages.push({
          role: "assistant",
          content: reply.content || null,
          ...(reply.toolCalls.length ? { tool_calls: reply.toolCalls } : {}),
        });
        if (reply.finish === "length") {
          write(c.yellow("\n[the reply hit the server's length limit or the context is full]\n"));
          break;
        }
        if (!reply.toolCalls.length) break;
        await this.runTools(reply.toolCalls, signal);
        if (signal.aborted) break;
      }
    } catch (e: any) {
      if (!signal.aborted) write(c.red(`error: ${e.message}\n`));
    } finally {
      this.spinner.stop();
      this.unwatch();
      this.abort = undefined;
      saveSession(this.session);
    }
    if (signal.aborted) write(c.yellow("[stopped]\n"));
    if (this.used) write(c.gray(this.status()) + "\n");
  }

  /** Esc stops; Ctrl+T shows or hides the thinking from the next token on. */
  private watch(): () => void {
    return watchKeys(
      () => this.abort?.abort(),
      () => {
        this.cfg.showThinking = !this.cfg.showThinking;
        if (this.spinner.running) this.spinner.set("Thinking", this.cfg.showThinking ? "showing thinking" : "");
      },
    );
  }

  status(): string {
    const pct = Math.round((100 * this.used) / this.contextWindow);
    const parts = [`ctx ${k(this.used)}/${k(this.contextWindow)} (${pct}%)`];
    if (this.lastPrompt) parts.push(`cache ${Math.round((100 * this.lastCached) / this.lastPrompt)}%`);
    if (this.lastSpeed) parts.push(`${this.lastSpeed.toFixed(0)} tok/s`);
    return parts.join(" · ");
  }

  /** One model call, streamed to the screen. Returns null if interrupted. */
  private async generate(signal: AbortSignal): Promise<Reply | null> {
    let thinkTokens = 0;
    let shownThinking = false;
    let printed = "";
    let heldWs = "";
    const toText = () => {
      this.spinner.stop();
      if (shownThinking) {
        write("\n\n");
        shownThinking = false;
      }
    };
    this.spinner.start("Thinking");
    try {
      const reply = await chat(
        this.cfg,
        this.messages,
        SCHEMAS,
        {
          onReasoning: (t) => {
            thinkTokens++;
            if (this.cfg.showThinking) {
              this.spinner.stop();
              shownThinking = true;
              write(c.gray(t));
            } else {
              if (!this.spinner.running) {
                // Thinking was just hidden with Ctrl+T: end its text, bring the spinner back.
                if (shownThinking) write("\n");
                shownThinking = false;
                this.spinner.start("Thinking");
              }
              this.spinner.set("Thinking", `${k(thinkTokens)} tokens`);
            }
          },
          onContent: (t) => {
            // Trim leading whitespace, and hold back trailing whitespace
            // until more text follows, so replies don't end in blank lines.
            if (!printed && !heldWs) t = t.replace(/^\s+/, "");
            if (!t) return;
            toText();
            const body = t.replace(/\s+$/, "");
            if (body) {
              write(heldWs + body);
              printed += heldWs + body;
              heldWs = t.slice(body.length);
            } else heldWs += t;
          },
          onToolArgs: (name, chars) => {
            if (shownThinking) toText();
            if (!this.spinner.running) this.spinner.start(`Preparing ${name}`);
            this.spinner.set(`Preparing ${name}`, `${k(chars)} chars`);
          },
        },
        signal,
      );
      this.spinner.stop();
      if (shownThinking) write("\n");
      if (printed && !printed.endsWith("\n")) write("\n");
      if (printed) write("\n");
      if (reply.usage) {
        this.lastPrompt = reply.usage.prompt;
        this.lastCached = reply.usage.cached;
        this.used = reply.usage.prompt + reply.usage.completion;
        if (reply.usage.genPerSec) this.lastSpeed = reply.usage.genPerSec;
      }
      if (!reply.content && !reply.toolCalls.length && reply.reasoning)
        write(c.yellow("[the model only thought and gave no answer]\n"));
      return reply;
    } catch (e: any) {
      this.spinner.stop();
      if (printed || shownThinking) write("\n");
      if (signal.aborted) {
        // Keep the history well-formed: every user message gets an answer.
        this.messages.push({ role: "assistant", content: (printed ? printed + "\n" : "") + "[interrupted by the user]" });
        return null;
      }
      write(c.red(`error: ${e.message}\n`));
      this.messages.push({ role: "assistant", content: `[request failed: ${e.message}]` });
      return null;
    }
  }

  private async runTools(calls: ToolCall[], signal: AbortSignal): Promise<void> {
    for (const call of calls) {
      let result: ToolResult;
      if (signal.aborted) {
        result = { content: "Not run: the user interrupted.", error: true };
      } else {
        result = await this.runTool(call, signal);
      }
      this.messages.push({ role: "tool", tool_call_id: call.id, content: result.content });
    }
  }

  private async runTool(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
    const name = call.function.name;
    const tool = TOOLS[name];
    let args: any;
    try {
      args = JSON.parse(call.function.arguments || "{}");
    } catch {
      write(`${c.red("●")} ${name} ${c.red("(bad arguments)")}\n`);
      return { content: `Your arguments for ${name} were not valid JSON. Send them again.`, error: true };
    }
    if (!tool) {
      write(`${c.red("●")} ${name} ${c.red("(no such tool)")}\n`);
      return { content: `There is no tool called ${name}. Tools: ${Object.keys(TOOLS).join(", ")}.`, error: true };
    }
    write(`${c.blue("●")} ${c.bold(name)} ${tool.summary(args).split("\n")[0]}\n`);

    let result: ToolResult;
    if (this.cfg.mode === "ro" && tool.writes) {
      result = {
        content: `Read-only mode: ${name} is not allowed. Tell the user what you would do instead.`,
        error: true,
      };
    } else {
      const ctx: ToolContext = {
        cwd: this.session.cwd,
        mode: this.cfg.mode,
        signal,
        maxChars: this.cfg.maxToolChars,
        approve: (t, summary) => this.approve(t, summary),
        seen: this.seen,
      };
      try {
        result = await tool.run(args, ctx);
      } catch (e: any) {
        result = { content: `${name} failed: ${e.message}`, error: true };
      }
    }

    const shown = result.display ?? preview(result.content, 6);
    write(indent(result.error ? c.red(preview(shown, 8)) : c.gray(shown), "  ⎿ ").replace(/\n  ⎿ /g, "\n    ") + "\n");

    const key = name + call.function.arguments;
    if (key === this.repeat.key && result.content === this.repeat.result) this.repeat.count++;
    else this.repeat = { key, result: result.content, count: 1 };
    if (this.repeat.count >= 3)
      result.content += `\n\n[You have made this exact call ${this.repeat.count} times with the same result. Stop and try something different.]`;
    return result;
  }

  private async approve(tool: string, summary: string): Promise<Approval> {
    const mode = this.cfg.mode;
    if (mode === "auto" || this.allowed.has(tool)) return { ok: true };
    if (mode === "edit" && (tool === "write_file" || tool === "edit_file")) return { ok: true };
    if (!this.interactive) return { ok: false, reason: "not allowed in this mode (non-interactive)" };
    this.spinner.stop();
    this.unwatch();
    try {
      // bash's command is already on screen in the tool line.
      if (tool !== "bash") write(c.yellow(`  ${summary}\n`));
      const ans = (await readLine(c.yellow(`  allow ${tool}? [y]es / [n]o / [a]lways / or say what to do instead: `), false)) ?? "n";
      const a = ans.trim();
      if (a === "" || /^y(es)?$/i.test(a)) return { ok: true };
      if (/^a(lways)?$/i.test(a)) {
        this.allowed.add(tool);
        return { ok: true };
      }
      if (/^no?$/i.test(a)) return { ok: false };
      return { ok: false, reason: a };
    } finally {
      this.unwatch = this.watch();
    }
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
    this.spinner.start("Compacting");
    let summary = "";
    try {
      const reply = await chat(
        this.cfg,
        [...this.messages, { role: "user", content: ask }],
        SCHEMAS,
        { onContent: (t) => this.spinner.set("Compacting", `${k((summary += t).length)} chars`) },
        signal,
        { thinking: false, toolChoice: "none" },
      );
      summary = reply.content.trim();
    } finally {
      this.spinner.stop();
    }
    if (!summary) throw new Error("compaction produced no summary");
    const before = this.used;
    let content = `This conversation was compacted to save space. Summary of it so far:\n\n${summary}`;
    if (midTurn && lastUser) content += `\n\nThe user's latest request, word for word:\n${lastUser.content}\n\nCarry on with it.`;
    this.session.messages = [this.messages[0], { role: "user", content }];
    if (!midTurn) this.session.messages.push({ role: "assistant", content: "Got it. What next?" });
    this.used = Math.ceil((this.messages[0].content!.length + content.length) / 3.5);
    this.seen.clear();
    write(c.gray(`[compacted: ~${k(before)} → ~${k(this.used)} tokens]\n`));
    saveSession(this.session);
  }

  /** /compact from the prompt. */
  async compactNow(): Promise<void> {
    const ac = new AbortController();
    this.abort = ac;
    this.unwatch = this.interactive ? watchKeys(() => ac.abort()) : () => {};
    try {
      await this.compact(ac.signal, false);
    } catch (e: any) {
      write(ac.signal.aborted ? c.yellow("[stopped]\n") : c.red(`error: ${e.message}\n`));
    } finally {
      this.unwatch();
      this.abort = undefined;
    }
  }

  /** Estimate after loading a saved session; corrected by the first reply. */
  estimateUsed(): void {
    this.used = Math.ceil(JSON.stringify(this.messages).length / 3.5);
  }
}
