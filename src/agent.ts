// jcoder — a coding agent for a local LLM server
// Copyright (C) 2026 Jason Roughley
// SPDX-License-Identifier: GPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option)
// any later version. It is distributed WITHOUT ANY WARRANTY; see the LICENSE
// file for details.

import { chat, serverSlots, imageCount, textOf, type Content, type Message, type Part, type Reply, type ToolCall, type ToolSchema } from "./client.js";
import { saveSettings, type Config } from "./config.js";
import type { Image } from "./images.js";
import { DROP_DAYS, dropped, PRESETS, resolveAdvisors, type Advisor } from "./advisors.js";
import { agentPrompt } from "./prompt.js";
import { log as writeLog, saveSession, storeContent, type Session } from "./session.js";
import { Jobs } from "./jobs.js";
import { schemas, TOOLS, type Approval, type Todo, type ToolContext, type ToolResult } from "./tools.js";
import { preview } from "./ui.js";
import type { AgentStatus, View } from "./view.js";

export const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** A bar for reading the prompt, but only when there's enough uncached to take a while. */
function readingProgress(view: View, label: string) {
  return (done: number, total: number, cached: number) => {
    if (total - cached < 2000 || done >= total) return;
    view.busy(label, `${k(done)}/${k(total)} tokens`, done / total);
  };
}

/** Limits how many sub-agents run at once, to the server's slots. */
class Gate {
  private waiting: (() => void)[] = [];
  private running = 0;
  constructor(private size: () => number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    while (this.running >= Math.max(1, this.size())) await new Promise<void>((r) => this.waiting.push(r));
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }
}

/**
 * What a sub-agent shows: not its output, which is for the main model, but
 * one status line in the parent's view. Its permission questions go to the
 * user labelled with its name; it can't ask anything else.
 */
class SubView implements View {
  private st: AgentStatus;
  private timer?: NodeJS.Timeout;
  constructor(
    private parent: View,
    private id: string,
    description: string,
  ) {
    this.st = { description, label: "Starting", detail: "", tools: 0, started: Date.now() };
    parent.agentUpdate(id, { ...this.st });
  }
  private update() {
    // Tokens stream fast; the status line needn't.
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      this.parent.agentUpdate(this.id, { ...this.st });
    }, 150);
  }
  busy(label: string, detail = "") {
    this.st.label = label;
    this.st.detail = detail;
    this.update();
  }
  thinking() {}
  text() {}
  endMessage() {}
  tool(name: string, summary: string) {
    this.st.tools++;
    this.st.last = `${name} ${summary.split("\n")[0]}`;
    this.update();
  }
  result() {}
  notice(text: string, tone?: "info" | "warn" | "error") {
    if (tone === "error") this.parent.notice(`agent "${this.st.description}": ${text}`, tone);
  }
  approve(tool: string, summary: string) {
    return this.parent.approve(tool, `(agent "${this.st.description}") ${summary}`);
  }
  async ask() {
    return null;
  }
  todos() {}
  agentUpdate() {}
  turnDone() {}
  close() {
    clearTimeout(this.timer);
  }
  get tools() {
    return this.st.tools;
  }
}

/** A sub-agent is told to wrap up at SUB_SOFT tool calls and stopped for its report at SUB_HARD. */
const SUB_SOFT = 30;
const SUB_HARD = 45;
/** The same tool on the same target this many times in a row gets a nudge to stop redoing it. */
const REDO_LIMIT = 4;

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
  /** The same tool on the same target in a row, whatever the content: redoing one thing. */
  private redo = { key: "", count: 0 };
  /** Tool calls in the current turn, for a sub-agent's budget. */
  private calls = 0;
  readonly jobs = new Jobs();
  todos: Todo[] = [];
  /** Fixed for the session: the tool list is part of the prompt the server caches. */
  readonly tools: ToolSchema[];
  readonly advisors: Advisor[];
  private agents = 0;
  private gate = new Gate(() => serverSlots);

  constructor(
    private cfg: Config,
    public session: Session,
    public contextWindow: number,
    private view: View,
    /** Set for a sub-agent: its name, and the conversation whose log gets its record. */
    private sub?: { description: string; parent: Session },
  ) {
    this.advisors = resolveAdvisors(cfg.advisors, cfg.advisorTimeout);
    this.tools = schemas({ advisors: this.advisors, searchUrl: cfg.searchUrl }, !!sub);
  }

  /** A sub-agent's record goes into its parent's log, marked with its name. */
  private log(event: Record<string, unknown>) {
    if (this.sub) writeLog(this.sub.parent, { ...event, agent: this.sub.description });
    else writeLog(this.session, event);
  }

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
      jobs: this.jobs,
      advisors: this.advisors,
      dropAdvisor: this.cfg.dropAdvisors === "never" ? undefined : (a, why) => this.dropAdvisor(a, why),
      ask: (q, options) => this.view.ask(q, options),
      setTodos: (items) => {
        this.todos = items;
        this.view.todos(items);
      },
      approve: (t, summary) => this.approve(t, summary),
      seen: this.seen,
      runAgent: this.sub ? undefined : (description, task) => this.runAgent(description, task, signal),
    };
  }

  /** Stops asking an advisor that ignores us: until restart, or for good in the settings. */
  private dropAdvisor(a: Advisor, why: string) {
    if (dropped.has(a.name)) return;
    dropped.add(a.name);
    const policy = this.cfg.dropAdvisors;
    const days = DROP_DAYS[policy];
    if (policy !== "permanent" && !days) {
      this.view.notice(`Not asking ${a.name} again this session (${why}).`, "warn");
      return;
    }
    // Saved in the settings, on its entry: a preset entry, a named one, or a
    // new entry for a preset that came from the environment.
    const mark = days ? { disabledUntil: new Date(Date.now() + days * 86_400_000).toISOString() } : { disabled: true };
    const list = [...this.cfg.advisors];
    const at = list.findIndex((s) => (s.name ?? (s.preset ? PRESETS[s.preset.toLowerCase()]?.name : "") ?? "").toLowerCase() === a.name.toLowerCase());
    if (at >= 0) list[at] = { ...list[at], ...mark };
    else {
      const preset = Object.entries(PRESETS).find(([, p]) => p.name === a.name)?.[0];
      list.push(preset ? { preset, ...mark } : { name: a.name, baseUrl: a.baseUrl, model: a.model, ...mark });
    }
    this.cfg.advisors = list;
    saveSettings({ advisors: list });
    this.view.notice(
      days
        ? `Not asking ${a.name} until ${new Date(mark.disabledUntil!).toLocaleString()} (${why}); its disabledUntil in the settings.`
        : `Advisor ${a.name} turned off in the settings (${why}). Remove its "disabled" to bring it back.`,
      "warn",
    );
  }

  /** A sub-agent with a fresh context does `task` and reports back. */
  private runAgent(description: string, task: string, signal: AbortSignal): Promise<ToolResult> {
    const id = `${this.session.id}-agent${++this.agents}`;
    return this.gate.run(async () => {
      if (signal.aborted) return { content: "Not run: the user interrupted.", error: true };
      const cwd = this.session.cwd;
      const session: Session = { id, cwd, model: this.cfg.model, messages: [{ role: "system", content: agentPrompt(cwd) }], updated: "" };
      const view = new SubView(this.view, id, description);
      const agent = new Agent(this.cfg, session, this.contextWindow, view, { description, parent: this.session });
      agent.allowed = this.allowed; // "don't ask again" covers its agents too
      const stop = () => agent.stop();
      signal.addEventListener("abort", stop);
      const started = Date.now();
      this.log({ type: "agent", description, task });
      try {
        const report = await agent.turn(task);
        const secs = Math.round((Date.now() - started) / 1000);
        const summary = `"${description}" · ${secs}s · ${view.tools} tool call${view.tools === 1 ? "" : "s"}`;
        if (signal.aborted) return { content: "The user interrupted the agent.", display: `stopped after ${summary}`, error: true };
        if (!report.trim()) return { content: "The agent finished without a report.", display: `no report · ${summary}`, error: true };
        return { content: `Report from the agent ("${description}"):\n\n${report}`, display: `${summary}\n${preview(report, 4)}` };
      } finally {
        signal.removeEventListener("abort", stop);
        view.close();
        this.view.agentUpdate(id, null);
      }
    });
  }

  /** Runs one user request to the end: model, tools, model, ... Resolves with the final reply. */
  async turn(text: string, images: Image[] = []): Promise<string> {
    let final = "";
    const content: Content = images.length
      ? [{ type: "text", text }, ...images.map((i): Part => ({ type: "image_url", image_url: { url: i.url } }))]
      : text;
    this.messages.push({ role: "user", content });
    this.log({ type: "user", content: storeContent(content) });
    this.abort = new AbortController();
    const signal = this.abort.signal;
    const started = Date.now();
    this.calls = 0;
    try {
      for (;;) {
        if (this.used > this.cfg.compactAt * this.contextWindow) await this.compact(signal, true);
        const reply = await this.generate(signal);
        if (!reply) break;
        final = reply.content;
        this.log({
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
        if (this.sub && this.calls >= SUB_HARD) {
          // Out of budget: no more tools, just the report.
          const ask = `You've used ${this.calls} tool calls, the limit for a sub-agent. Stop now and write your report: what's done, what isn't, and what you found.`;
          this.messages.push({ role: "user", content: ask });
          this.log({ type: "user", content: ask });
          const last = await this.generate(signal, true);
          if (last) {
            final = last.content;
            this.messages.push({ role: "assistant", content: last.content || null });
            this.log({ type: "assistant", content: last.content, reasoning: last.reasoning || undefined, usage: last.usage });
          }
          break;
        }
      }
    } catch (e: any) {
      if (!signal.aborted) this.view.notice(`error: ${e.message}`, "error");
      this.log({ type: "error", message: e.message });
    } finally {
      this.abort = undefined;
      if (!this.sub) saveSession(this.session);
    }
    this.view.turnDone({
      seconds: (Date.now() - started) / 1000,
      status: this.used ? this.status() : "",
      stopped: signal.aborted,
    });
    return final;
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
  private async generate(signal: AbortSignal, noTools = false): Promise<Reply | null> {
    let thinkTokens = 0;
    let printed = "";
    this.view.busy("Thinking");
    try {
      const reply = await chat(
        this.cfg,
        this.messages,
        this.tools,
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
          onPromptProgress: readingProgress(this.view, "Reading"),
        },
        signal,
        noTools ? { toolChoice: "none" } : {},
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
        this.log({ type: "interrupted", content: printed });
        return null;
      }
      this.view.notice(`error: ${e.message}`, "error");
      this.messages.push({ role: "assistant", content: `[request failed: ${e.message}]` });
      this.log({ type: "error", message: e.message });
      return null;
    }
  }

  private async runTools(calls: ToolCall[], signal: AbortSignal): Promise<void> {
    const interrupted: ToolResult = { content: "Not run: the user interrupted.", error: true };
    for (let i = 0; i < calls.length; ) {
      // Agent calls side by side run at the same time; everything else in turn.
      let j = i + 1;
      if (calls[i].function.name === "agent") while (j < calls.length && calls[j].function.name === "agent") j++;
      const batch = calls.slice(i, j);
      const results = await Promise.all(batch.map((c) => (signal.aborted ? interrupted : this.runTool(c, signal))));
      batch.forEach((c, n) => this.record(c, results[n]));
      i = j;
    }
  }

  private record(call: ToolCall, result: ToolResult) {
    {
      this.messages.push({ role: "tool", tool_call_id: call.id, content: result.content });
      this.log({
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
    // Paths inside the project read shorter relative to it.
    const cwd = this.session.cwd;
    this.view.tool(name, tool.summary(args).replaceAll(cwd + "/", "").replaceAll(cwd, "."));
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

    this.calls++;
    const target = args.path ?? args.command ?? args.url ?? args.pattern;
    const redoKey = target === undefined ? "" : `${name}:${target}`;
    if (redoKey && redoKey === this.redo.key) this.redo.count++;
    else this.redo = { key: redoKey, count: 1 };
    if (this.redo.count >= REDO_LIMIT && typeof result.content === "string") {
      const what = name === "write_file" ? `rewritten ${target}` : name === "edit_file" ? `edited ${target}` : `run ${name} on ${String(target).slice(0, 80)}`;
      result.content += `\n\n[You've ${what} ${this.redo.count} times in a row. Stop redoing it: it's done unless something is actually broken. Move on, or finish.]`;
    }
    if (this.sub && this.calls === SUB_SOFT && typeof result.content === "string")
      result.content += `\n\n[That's ${SUB_SOFT} tool calls. Wrap up: finish only what's essential, then write your report. At ${SUB_HARD} your tools stop.]`;

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
      "and the next steps. Be specific: paths, function names, commands. About 800 to 1200 words. No tool calls.";
    this.view.busy("Compacting: reading", "", 0);
    // Writing: the bar fills towards the length asked for (~1500 tokens) and
    // waits at 95% if the summary runs long.
    const EXPECTED = 1500;
    let tokens = 0;
    const reply = await chat(
      this.cfg,
      [...this.messages, { role: "user", content: ask }],
      this.tools,
      {
        onPromptProgress: readingProgress(this.view, "Compacting: reading"),
        onContent: () => this.view.busy("Compacting: summarising", `${k(++tokens)} tokens`, Math.min(0.95, tokens / EXPECTED)),
      },
      signal,
      { effort: "off", toolChoice: "none", maxTokens: 4096 },
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
    if (this.todos.length)
      text += `\n\nYour to-do list:\n${this.todos.map((t) => `[${t.status === "done" ? "x" : t.status === "in_progress" ? ">" : " "}] ${t.text}`).join("\n")}`;
    const running = this.jobs.list().filter((j) => !j.exit);
    if (running.length) text += `\n\nBackground jobs still running:\n${running.map((j) => `${j.id}: ${j.command}`).join("\n")}`;
    const content: Content = images.length ? [{ type: "text", text }, ...images] : text;
    this.log({ type: "compact", tokensBefore: this.used, summary });
    this.session.messages = [this.messages[0], { role: "user", content }];
    if (!midTurn) this.session.messages.push({ role: "assistant", content: "Got it. What next?" });
    this.estimateUsed();
    this.seen.clear();
    this.view.notice(`Compacted: ~${k(before)} → ~${k(this.used)} tokens`);
    if (!this.sub) saveSession(this.session);
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
    let chars = JSON.stringify(this.tools).length;
    let images = 0;
    for (const m of this.messages) {
      chars += textOf(m.content).length;
      images += imageCount(m.content);
      if (m.role === "assistant" && m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
    }
    this.used = Math.ceil(chars / 3.5) + images * 1024;
  }
}
