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
import path from "node:path";
import { Box, Static, Text, render, useApp, useInput, useWindowSize } from "ink";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import wrapAnsi from "wrap-ansi";
import { Agent, k, toolLine } from "./agent.js";
import { prepare } from "./attach.js";
import { listModels, serverContext, textOf, type ToolCall } from "./client.js";
import { COMMANDS } from "./complete.js";
import { DEFAULTS, EFFORT_BUDGET, EFFORTS, LIVE_SETTINGS, parseSetting, samplingFor, saveConfig, saveSettings, settingName, type Config, type Effort, type Mode } from "./config.js";
import { Editor } from "./editor.js";
import { clipboardImage, type Image } from "./images.js";
import { renderLines, renderMarkdown, type CodeState } from "./markdown.js";
import { DEFAULT_TEMPLATE, notes, systemPrompt, templatePath, USER_TEMPLATE } from "./prompt.js";
import { listSessions, logPath, newSession, openSession, readLog, title, type Session } from "./session.js";
import type { Approval, Todo } from "./tools.js";
import { LOGO_WIDTH, logo } from "./logo.js";
import { ask as askAdvisors, dropped, inactive, PRESETS } from "./advisors.js";
import { checkForUpdate, install, selfUpdate, skipVersion, VERSION } from "./update.js";
import type { AgentStatus, View } from "./view.js";
import { duration, preview } from "./ui.js";

const MODES: Mode[] = ["edit", "auto", "ro"];
const MODE_LABEL: Record<Mode, [string, string]> = {
  edit: ["yellow", "⏵ edit · asks before commands"],
  auto: ["red", "⏵⏵ auto · asks nothing"],
  ro: ["green", "read-only"],
};
/**
 * Wraps text ourselves, trimming the spaces at line ends, and one column
 * short of the space it has. Ink's own wrapping keeps a trailing space, so a
 * full line comes out one column too wide; the terminal wraps it, Ink's
 * count of lines to erase is then off by one, and every redraw leaves a copy
 * of the live text in the scrollback.
 */
/** Terminal width, from a context so blocks can also be measured off screen. */
const Width = createContext(80);

function wrapTo(t: string, width: number): string {
  // Line by line, so each keeps its own indent; the space a line broke at
  // starts the next row, so drop it there.
  return t
      .split("\n")
      .map((line) =>
        wrapAnsi(line, width, { hard: true, trim: false })
          .split("\n")
          .map((row, i) => (i ? row.replace(/^((?:\x1b\[[0-9;]*m)*) /, "$1") : row).replace(/[ \t]+$/, ""))
          .join("\n"),
      )
      .join("\n");
}

const textWidth = (columns: number, indent: number) => Math.max(20, columns - indent - 1);

// ---------- blocks ----------

/**
 * Everything printed into the scrollback is a block: a prefix, then text we
 * wrap ourselves. Its height is known before it's drawn, which keeps the
 * input on the bottom row (see the budget in App).
 */
interface Block {
  prefix?: string;
  prefixColor?: string;
  text: string;
  color?: string;
  italic?: boolean;
  bg?: string;
  marginTop?: number;
}

const prefixWidth = (b: Block) => [...(b.prefix ?? "")].length;

function blockRows(b: Block, columns: number): number {
  return (b.marginTop ?? 0) + wrapTo(b.text, textWidth(columns, prefixWidth(b))).split("\n").length;
}

function BlockView({ b }: { b: Block }) {
  const columns = useContext(Width);
  return (
    <Box marginTop={b.marginTop ?? 0}>
      {b.prefix && (
        <Text color={b.prefixColor} backgroundColor={b.bg}>
          {b.prefix}
        </Text>
      )}
      <Box flexShrink={1}>
        <Text color={b.color} italic={b.italic} backgroundColor={b.bg}>
          {wrapTo(b.text, textWidth(columns, prefixWidth(b)))}
        </Text>
      </Box>
    </Box>
  );
}

const E = "\x1b[";
const ansi = { bold: (t: string) => `${E}1m${t}${E}22m`, cyan: (t: string) => `${E}36m${t}${E}39m`, gray: (t: string) => `${E}90m${t}${E}39m`, magenta: (t: string) => `${E}35m${t}${E}39m` };

const blocks = {
  /** A piece of a reply; `text` is already rendered markdown. */
  reply: (text: string, first: boolean): Block => ({ prefix: first ? "● " : "  ", text, marginTop: first ? 1 : 0 }),
  thought: (text: string, first: boolean): Block => ({ prefix: first ? "∴ " : "  ", prefixColor: "gray", text, color: "gray", italic: true, marginTop: first ? 1 : 0 }),
  user: (text: string): Block => ({ prefix: "❯ ", prefixColor: "gray", text, bg: "#303030", marginTop: 1 }),
  tool: (name: string, summary: string): Block => ({ prefix: "● ", prefixColor: "green", text: `${ansi.bold(name)} ${summary.split("\n")[0]}`, marginTop: 1 }),
  // A display with its own colours (a diff) keeps them; plain ones are gray.
  result: (display: string, error: boolean): Block => ({ prefix: "  └  ", prefixColor: "gray", text: display, color: error ? "red" : display.includes("\x1b[") ? undefined : "gray" }),
  /** A run of quiet tool calls, as one line: "Ran 2 shell commands, read 3 files". */
  group: (text: string, failed: number): Block => ({
    prefix: "  ",
    text: `${text}${failed ? ` · \x1b[31m${failed} failed\x1b[39m` : ""} ${ansi.gray("(ctrl+o to expand)")}`,
    color: "gray",
    marginTop: 1,
  }),
  notice: (text: string, tone: "info" | "warn" | "error"): Block => ({ prefix: "  ", text, color: tone === "error" ? "red" : tone === "warn" ? "yellow" : "gray" }),
};

const tilde = (p: string) => (process.env.HOME && p.startsWith(process.env.HOME) ? "~" + p.slice(process.env.HOME.length) : p);
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// One clock for every spinner on screen. A timer each would redraw the screen
// once per spinner per tick, out of step with each other.
const spinWatchers = new Set<(f: number) => void>();
let spinFrame = 0;
let spinTimer: NodeJS.Timeout | undefined;
function useSpinFrame(): number {
  const [frame, setFrame] = useState(spinFrame);
  useEffect(() => {
    spinWatchers.add(setFrame);
    spinTimer ??= setInterval(() => {
      spinFrame++;
      for (const w of spinWatchers) w(spinFrame);
    }, 120);
    return () => {
      spinWatchers.delete(setFrame);
      if (!spinWatchers.size) {
        clearInterval(spinTimer);
        spinTimer = undefined;
      }
    };
  }, []);
  return frame;
}

/**
 * A box's height, kept current as anything inside it changes. Ink's
 * useBoxMetrics sets state after every frame, changed or not, and React keeps
 * each of those updates until the component renders again: App waiting at a
 * question with a spinner going piled up two a frame until the heap ran out.
 * This sets state only when the height changes. It listens where
 * useBoxMetrics does, Ink's root node, which calls its layout listeners after
 * every frame.
 */
function useHeight(ref: { current: any }): number | undefined {
  const [height, setHeight] = useState<number>();
  const last = useRef<number>(undefined);
  useEffect(() => {
    const measure = () => {
      const h = ref.current?.yogaNode?.getComputedLayout().height;
      if (h === undefined || h === last.current) return;
      last.current = h;
      setHeight(h);
    };
    measure();
    let root = ref.current;
    while (root?.parentNode) root = root.parentNode;
    if (root?.nodeName !== "ink-root") return;
    const listeners: Set<() => void> = (root.internal_layoutListeners ??= new Set());
    listeners.add(measure);
    return () => void listeners.delete(measure);
  }, [ref]);
  return height;
}

interface Item {
  id: number;
  b: Block;
}

interface Pick {
  title: string;
  options: string[];
  resolve(i: number | null): void;
}

interface Question {
  question: string;
  options: string[];
  typing: boolean;
  resolve(answer: string | null): void;
}

interface Ask {
  tool: string;
  summary: string;
  /** Picking "no, tell it": typing a reason. */
  typing: boolean;
  resolve(a: Approval): void;
}

// ---------- rendering pieces ----------

function bar(fraction: number, width = 20): string {
  const f = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(f * width);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)} ${Math.floor(f * 100)}%`;
}

function Spinner({ label, detail, since, progress }: { label: string; detail: string; since: number; progress?: number }) {
  const frame = useSpinFrame();
  const secs = Math.floor((Date.now() - since) / 1000);
  // One Text, so a narrow terminal wraps the line instead of squashing it.
  return (
    <Box marginTop={1}>
      <Text wrap="wrap">
        <Text color="magenta">
          {SPIN[frame % SPIN.length]} {label}…{" "}
        </Text>
        {progress !== undefined && <Text color="magenta">{bar(progress)} </Text>}
        <Text color="gray">({[duration(secs), detail, "esc to interrupt"].filter(Boolean).join(" · ")})</Text>
      </Text>
    </Box>
  );
}

/** One running sub-agent: what it's for, what it's doing, how long, how many tools. */
function AgentLine({ st }: { st: AgentStatus }) {
  const frame = useSpinFrame();
  const secs = Math.floor((Date.now() - st.started) / 1000);
  const time = duration(secs);
  // What it last ran stays on show while it thinks about the result, so
  // the line says where it is in its work, not just a token count.
  const now = st.label.startsWith("Running") ? "" : [st.label.toLowerCase(), st.detail].filter(Boolean).join(" ");
  const doing = [st.last, now].filter(Boolean).join(" · ");
  return (
    <Text wrap="truncate-end">
      <Text color="blue">
        {"  "}
        {SPIN[frame % SPIN.length]} {st.description}
      </Text>
      {st.server && <Text color="cyan"> on {st.server}</Text>}
      <Text color="gray">
        {"  "}
        {time} · {st.tools} tool{st.tools === 1 ? "" : "s"} · {doing}
      </Text>
    </Text>
  );
}

function Picker({ title, options, onPick }: { title: string; options: string[]; onPick(i: number | null): void }) {
  const [sel, setSel] = useState(0);
  useInput((input, key) => {
    if (key.upArrow) setSel((sel - 1 + options.length) % options.length);
    else if (key.downArrow) setSel((sel + 1) % options.length);
    else if (key.return) onPick(sel);
    else if (key.escape) onPick(null);
    else if (/^[1-9]$/.test(input) && Number(input) <= options.length) onPick(Number(input) - 1);
  });
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
      <Text bold>{title}</Text>
      {options.map((o, i) => (
        <Text key={i} color={i === sel ? "cyan" : undefined}>
          {i === sel ? "❯ " : "  "}
          {i + 1}. {o}
        </Text>
      ))}
      <Text color="gray">↑↓ or number, enter to choose, esc to cancel</Text>
    </Box>
  );
}

// ---------- quiet tools and the transcript ----------

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const times = (n: number) => (n === 1 ? "once" : `${n} times`);
/** Tools that only look or run: shown as one summary line per run of them, in full under ctrl+o. */
const QUIET: Record<string, (n: number) => string> = {
  bash: (n) => `ran ${plural(n, "shell command")}`,
  bash_output: (n) => `checked a job ${times(n)}`,
  bash_stop: (n) => `stopped ${plural(n, "job")}`,
  read_file: (n) => `read ${plural(n, "file")}`,
  grep: (n) => `searched for ${plural(n, "pattern")}`,
  glob: (n) => `listed files ${times(n)}`,
  web_search: (n) => `searched the web ${times(n)}`,
  web_fetch: (n) => `fetched ${plural(n, "page")}`,
};

interface Group {
  counts: Map<string, number>;
  failed: number;
}

function groupText(g: Group | null): string {
  if (!g) return "";
  const t = [...g.counts].map(([name, n]) => QUIET[name](n)).join(", ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** One tool call as the transcript keeps it. */
interface Entry {
  name: string;
  summary: string;
  display: string;
  full: string;
  error: boolean;
}

const MAX_ENTRY_LINES = 300;

function transcriptLines(entries: Entry[], width: number): string[] {
  const out: string[] = [];
  for (const e of entries) {
    out.push("");
    const [head, ...rest] = e.summary.replace(/\t/g, "    ").split("\n");
    out.push(...wrapTo(`\x1b[32m●\x1b[39m ${ansi.bold(e.name)} ${head}`, width).split("\n"));
    for (const l of rest) out.push(...wrapTo(`  ${l}`, width).split("\n"));
    // Edits and the like show what they showed; the rest everything they returned.
    const body = (QUIET[e.name] ? e.full : e.display) || "(no output)";
    const lines = body.replace(/\s+$/, "").replace(/\t/g, "    ").split("\n");
    const shown = lines.slice(0, MAX_ENTRY_LINES);
    if (lines.length > MAX_ENTRY_LINES) shown.push(`… ${lines.length - MAX_ENTRY_LINES} more lines`);
    const bar = e.error ? "\x1b[31m│\x1b[39m " : ansi.gray("│ ");
    for (const l of shown) for (const row of wrapTo(l, width - 4).split("\n")) out.push(`  ${bar}${e.error ? `\x1b[31m${row}\x1b[39m` : row}`);
  }
  return out;
}

/** Every tool call so far, in full: ctrl+o opens it, scrolled to the end. */
function Transcript({ entries, rows, columns, running, onClose }: { entries: Entry[]; rows: number; columns: number; running: boolean; onClose(): void }) {
  const lines = useMemo(() => transcriptLines(entries, Math.max(20, columns - 1)), [entries.length, columns]);
  const height = Math.max(5, rows - 3);
  const max = Math.max(0, lines.length - height);
  const [top, setTop] = useState(max);
  useInput((input, key) => {
    if (key.escape || input === "q" || (key.ctrl && input === "o")) onClose();
    else if (key.upArrow || input === "k") setTop((t) => Math.max(0, t - 1));
    else if (key.downArrow || input === "j") setTop((t) => Math.min(max, t + 1));
    else if (key.pageUp || input === "b") setTop((t) => Math.max(0, t - height));
    else if (key.pageDown || input === " ") setTop((t) => Math.min(max, t + height));
    else if (key.home || input === "g") setTop(0);
    else if (key.end || input === "G") setTop(max);
  });
  const view = lines.slice(top, top + height);
  const where = lines.length ? `lines ${top + 1}–${top + view.length} of ${lines.length}` : "no tool calls yet";
  return (
    <Box flexDirection="column">
      <Text>{[...view, ...Array(Math.max(0, height - view.length)).fill("")].join("\n")}</Text>
      <Text color="gray">
        {`transcript · ${plural(entries.length, "tool call")} · ${where} · ↑↓ pgup pgdn g G · esc to close${running ? " · still working" : ""}`}
      </Text>
    </Box>
  );
}

// ---------- the app ----------

interface Props {
  cfg: Config;
  session: Session;
  contextWindow: number;
  resumed: boolean;
}

function App(props: Props) {
  const { cfg } = props;
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const [items, setItems] = useState<Item[]>([]);
  const [live, setLive] = useState("");
  const [liveThought, setLiveThought] = useState("");
  const [busy, setBusy] = useState<{ label: string; detail: string; since: number; progress?: number } | null>(null);
  const [pick, setPick] = useState<Pick | null>(null);
  // Permission questions queue up: several agents can ask at once.
  const [asks, setAsks] = useState<Ask[]>([]);
  const ask = asks[0] ?? null;
  const answerAsk = (a: Approval) => {
    ask?.resolve(a);
    setAsks((q) => q.slice(1));
  };
  const [agents, setAgents] = useState<Map<string, AgentStatus>>(new Map());
  const [question, setQuestion] = useState<Question | null>(null);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [queue, setQueue] = useState<string[]>([]);
  const [btw, setBtw] = useState<{ question: string; answer: string; status: string; stop: AbortController } | null>(null);
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const [exitArmed, setExitArmed] = useState(false);
  const [, setTick] = useState(0);
  const rerender = () => setTick((t) => t + 1);

  // Keeping the input on the bottom row: the live area gets a minimum height
  // equal to the rows between the end of the output and the bottom of the
  // screen (the budget), with its content pushed to the bottom. Each block
  // printed above uses up its height of the budget; when the live area grows
  // past the budget the screen scrolls and the budget grows with it. It stays
  // one row short of the screen: a frame as tall as the terminal makes Ink
  // clear the whole terminal, scrollback and all.
  const maxBudget = Math.max(5, rows - 1);
  const [budget, setBudget] = useState(maxBudget);
  const liveRef = useRef<any>(null);
  const liveHeight = useHeight(liveRef);
  useEffect(() => {
    if (liveHeight !== undefined && liveHeight > budget) setBudget(Math.min(maxBudget, liveHeight));
  }, [liveHeight]);
  const lastRows = useRef(rows);
  useEffect(() => {
    // A taller window has more room below; a shorter one less.
    const d = rows - lastRows.current;
    lastRows.current = rows;
    if (d) setBudget((b) => Math.max(0, Math.min(maxBudget, b + d)));
  }, [rows]);

  const nextId = useRef(0);
  const pushRaw = (b: Block) => {
    const height = blockRows(b, columns);
    setBudget((x) => Math.max(0, x - height));
    setItems((xs) => [...xs, { id: nextId.current++, b }]);
  };

  // Quiet tool calls gather into a group, shown live while it grows and
  // printed as one line when anything else is printed.
  const group = useRef<Group | null>(null);
  const [groupLive, setGroupLive] = useState<{ text: string; current: string } | null>(null);
  const transcript = useRef<Entry[]>([]);
  const pending = useRef<{ name: string; summary: string }>({ name: "tool", summary: "" });
  const [showTranscript, setShowTranscript] = useState(false);
  const flushGroup = () => {
    const g = group.current;
    if (!g) return;
    group.current = null;
    setGroupLive(null);
    pushRaw(blocks.group(groupText(g), g.failed));
  };
  const push = (b: Block) => {
    flushGroup();
    pushRaw(b);
  };
  const notice = (text: string, tone: "info" | "warn" | "error" = "info") => push(blocks.notice(text, tone));

  // Streaming state lives in refs: chunks arrive faster than React renders.
  // Every complete line goes straight into the scrollback (Static); only the
  // line still being written is redrawn. A live area taller than the screen
  // can't be redrawn cleanly and leaves copies behind in the scrollback.
  const s = useRef({
    text: "",
    thought: "",
    replyStarted: false,
    thoughtStarted: false,
    inCode: null as CodeState,
    /** Blank lines held back until more text follows, so a reply never ends in them. */
    blanks: 0,
    pasted: [] as Image[],
  });

  const flushThought = (all: boolean) => {
    const st = s.current;
    const i = all ? st.thought.length : st.thought.lastIndexOf("\n");
    if (i < 0) return;
    let done = st.thought.slice(0, i);
    st.thought = st.thought.slice(i + 1);
    if (!st.thoughtStarted) done = done.replace(/^\s+/, "");
    if (all) done = done.replace(/\s+$/, "");
    if (!done && !st.thoughtStarted) return;
    if (done || !all) push(blocks.thought(done, !st.thoughtStarted));
    st.thoughtStarted = true;
  };

  const flushText = (all: boolean) => {
    const st = s.current;
    const i = all ? st.text.length : st.text.lastIndexOf("\n");
    if (i < 0) return;
    let done = st.text.slice(0, i);
    st.text = st.text.slice(i + 1);
    if (!st.replyStarted) done = done.replace(/^\s+/, "");
    if (all) done = done.replace(/\s+$/, "");
    if (!done && (!st.replyStarted || all)) return;
    if (!done) {
      st.blanks++;
      return;
    }
    // A chunk can bring several lines at once: its trailing blank lines are
    // held back like any other, in case the reply ends there.
    const trailing = /\n*$/.exec(done)![0].length;
    done = done.slice(0, done.length - trailing);
    if (done) {
      const [rendered, inCode] = renderLines(done, st.inCode);
      st.inCode = inCode;
      push(blocks.reply("\n".repeat(st.blanks) + rendered, !st.replyStarted));
      st.blanks = 0;
      st.replyStarted = true;
    }
    st.blanks += trailing;
  };

  const view: View = {
    busy(label, detail = "", progress) {
      setBusy((b) => ({ label, detail, progress, since: b?.since ?? Date.now() }));
    },
    thinking(chunk) {
      s.current.thought += chunk;
      flushThought(false);
      setLiveThought(s.current.thought);
    },
    text(chunk) {
      const st = s.current;
      if (st.thought) {
        flushThought(true);
        setLiveThought("");
      }
      st.text += chunk;
      flushText(false);
      setLive(st.text);
    },
    endMessage() {
      const st = s.current;
      flushThought(true);
      flushText(true);
      st.text = st.thought = "";
      st.replyStarted = st.thoughtStarted = false;
      st.inCode = null;
      st.blanks = 0;
      setLive("");
      setLiveThought("");
    },
    tool(name, summary) {
      pending.current = { name, summary };
      if (QUIET[name]) setGroupLive({ text: groupText(group.current), current: `${name} ${summary.split("\n")[0]}` });
      else push(blocks.tool(name, summary));
    },
    result(display, error, full) {
      const { name, summary } = pending.current;
      transcript.current.push({ name, summary, display, full: full ?? display, error });
      if (!QUIET[name]) return push(blocks.result(display, error));
      const g = (group.current ??= { counts: new Map(), failed: 0 });
      g.counts.set(name, (g.counts.get(name) ?? 0) + 1);
      if (error) g.failed++;
      setGroupLive({ text: groupText(g), current: "" });
    },
    notice,
    approve(tool, summary) {
      return new Promise((resolve) => setAsks((q) => [...q, { tool, summary, typing: false, resolve }]));
    },
    ask(q, options) {
      return new Promise((resolve) => setQuestion({ question: q, options, typing: options.length === 0, resolve }));
    },
    todos(items) {
      setTodos(items);
    },
    agentUpdate(id, status) {
      setAgents((m) => {
        const next = new Map(m);
        if (status) next.set(id, status);
        else next.delete(id);
        return next;
      });
    },
    turnDone({ seconds, status, stopped }) {
      setBusy(null);
      if (stopped) push({ prefix: "  └  ", prefixColor: "red", text: "Interrupted · tell it what to do instead", color: "red" });
      push({ text: `✓ Done in ${duration(seconds)}${status ? ` · ${status}` : ""}`, color: "gray", marginTop: 1 });
    },
  };
  const viewRef = useRef(view);
  viewRef.current = view;
  // The agent holds a stable object that forwards to the latest closures.
  const stableView = useRef<View>(
    new Proxy({} as View, { get: (_, key) => (viewRef.current as any)[key] }),
  ).current;

  const [ctxWindow, setCtxWindow] = useState(props.contextWindow);
  const agentRef = useRef<Agent>(null as any);
  if (!agentRef.current) {
    agentRef.current = new Agent(cfg, props.session, props.contextWindow, stableView);
    agentRef.current.inbox = () => takeRef.current();
    if (props.resumed) agentRef.current.estimateUsed();
  }
  const agent = agentRef.current;
  const cwd = agent.session.cwd;

  const newAgent = (session: Session, resumed: boolean) => {
    setTodos([]);
    agentRef.current = new Agent(cfg, session, ctxWindow, stableView);
    agentRef.current.inbox = () => takeRef.current();
    if (resumed) agentRef.current.estimateUsed();
    rerender();
  };

  const showUser = (text: string) => push(blocks.user(text));

  /**
   * A resumed conversation, shown as it was: messages, thinking (when shown),
   * tool calls and their results, from the log, which has everything
   * including what compaction summarised away. Without a log, from the
   * messages.
   */
  const replay = (session: Session) => {
    let events = readLog(session).filter((e) => !e.agent);
    if (!events.some((e) => e.type === "user"))
      events = session.messages.slice(1).map((m) =>
        m.role === "tool" ? { type: "tool", id: m.tool_call_id, content: m.content } : { type: m.role, ...m },
      );
    const calls = new Map<string, ToolCall>();
    const reply = (t: string) => t.trim() && push(blocks.reply(renderMarkdown(t.trim()), true));
    for (const e of events) {
      if (e.type === "user") {
        // Attached files went to the model, not on the screen.
        const files: string[] = [];
        const t = textOf(e.content).replace(/\n\n<file path="([^"]*)">[\s\S]*?\n<\/file>/g, (_: string, f: string) => (files.push(f), ""));
        showUser(t);
        if (files.length) push(blocks.result(`attached ${files.join(", ")}`, false));
      } else if (e.type === "assistant") {
        if (cfg.showThinking && e.reasoning?.trim()) push(blocks.thought(e.reasoning.trim(), true));
        reply(e.content ?? "");
        for (const c of e.tool_calls ?? []) calls.set(c.id, c);
      } else if (e.type === "tool") {
        const call = calls.get(e.id);
        let args: unknown = {};
        try {
          args = JSON.parse(call?.function.arguments || "{}");
        } catch {}
        const name = e.name ?? call?.function.name ?? "tool";
        view.tool(name, toolLine(name, args, session.cwd));
        view.result(e.display ?? preview(textOf(e.content), 6), !!e.error, textOf(e.content));
      } else if (e.type === "interrupted") {
        reply(e.content ?? "");
        push({ prefix: "  └  ", prefixColor: "red", text: "Interrupted", color: "red" });
      } else if (e.type === "error") notice(`error: ${e.message}`, "error");
      else if (e.type === "compact") notice("Compacted: the model sees a summary of everything above.");
    }
    flushGroup();
  };

  // Banner, once.
  useEffect(() => {
    const n = notes(cwd);
    const art = logo(columns);
    const lines = [
      ...(art
        ? [
            "",
            art,
            `${" ".repeat(LOGO_WIDTH - 9)}\x1b[1m\x1b[38;5;214mc o d e r\x1b[39m\x1b[22m`,
            "",
            ansi.gray(`  jcoder ${VERSION} · ${cfg.model} · ctx ${k(ctxWindow)}`),
          ]
        : [`${ansi.bold(ansi.magenta("◆ jcoder"))} ${ansi.gray(VERSION)}  ${ansi.gray(`${cfg.model} · ctx ${k(ctxWindow)}`)}`]),
      ansi.gray(`  ${tilde(cwd)}`),
      ...(n.length ? [ansi.gray(`  notes: ${n.map((x) => tilde(x.file)).join(", ")}`)] : []),
      ansi.gray("  / for commands · @ for files · ctrl+v pastes an image · esc stops the model"),
    ];
    push({ text: lines.join("\n") });
    if (props.resumed) replay(props.session);
    if (cfg.checkUpdates) void update(false);
  }, []);

  /** Looks for a newer release and asks what to do; quiet unless asked or there's news. */
  const update = async (asked: boolean) => {
    try {
      const rel = await checkForUpdate(asked);
      if (!rel) {
        if (asked) notice(`jcoder ${VERSION} is the latest.`);
        return;
      }
      const can = selfUpdate();
      const later = ["Not now", `Skip ${rel.version}`, "Stop checking for updates"];
      const i = await choose(
        `jcoder ${rel.version} is available (you have ${VERSION}).${can.ok ? "" : ` It can't install itself: ${can.why}.`}`,
        can.ok ? ["Install it now", ...later] : later,
      );
      const choice = i === null ? "Not now" : (can.ok ? ["Install it now", ...later] : later)[i];
      if (choice === `Skip ${rel.version}`) {
        skipVersion(rel.version);
        notice(`Won't ask about ${rel.version} again. /update installs it any time.`);
      } else if (choice === "Stop checking for updates") {
        cfg.checkUpdates = false;
        saveConfig(cfg);
        notice("Update checks off. /update still checks, or set checkUpdates in the settings.");
      } else if (choice === "Install it now") {
        notice(`Installing jcoder ${rel.version} in the background…`);
        await install(rel.url);
        notice(`Updated to jcoder ${rel.version}. Restart jcoder to use it.`, "warn");
      }
    } catch (e: any) {
      if (asked) notice(`Update failed: ${e.message}`, "error");
    }
  };

  // ---------- running turns ----------

  const run = async (line: string) => {
    const pasted = s.current.pasted;
    s.current.pasted = [];
    showUser(line);
    const ctx = agentRef.current.toolContext(new AbortController().signal);
    const prep = await prepare(line, pasted, ctx);
    for (const e of prep.errors) notice(e, "error");
    if (prep.notes.length) push(blocks.result(`attached ${prep.notes.join(", ")}`, false));
    setBusy({ label: "Thinking", detail: "", since: Date.now() });
    await agentRef.current.turn(prep.text, prep.images);
    setBusy(null);
  };

  // Between tool calls the running turn takes everything queued, as one message.
  async function takeQueued() {
    const lines = queueRef.current;
    if (!lines.length) return null;
    queueRef.current = [];
    setQueue((q) => q.slice(lines.length));
    const pasted = s.current.pasted;
    s.current.pasted = [];
    for (const line of lines) showUser(line);
    const prep = await prepare(lines.join("\n\n"), pasted, agentRef.current.toolContext(new AbortController().signal));
    for (const e of prep.errors) notice(e, "error");
    if (prep.notes.length) push(blocks.result(`attached ${prep.notes.join(", ")}`, false));
    return { text: prep.text, images: prep.images };
  }
  const takeRef = useRef(takeQueued);
  takeRef.current = takeQueued;

  // Messages typed while nothing runs, or after the last tool call, wait here and go one at a time.
  useEffect(() => {
    if (busy || pick || !queue.length || agentRef.current.running) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    void run(next);
  }, [queue, busy, pick]);

  const choose = (title: string, options: string[]) =>
    new Promise<number | null>((resolve) => setPick({ title, options, resolve }));

  const setEffort = (e: Effort) => {
    cfg.effort = e;
    saveConfig(cfg);
    const b = EFFORT_BUDGET[e];
    notice(`Effort ${e}: ${e === "off" ? "no thinking" : b < 0 ? "thinking without a limit" : `thinking up to ${k(b)} tokens a reply`}.`);
  };

  const setMode = (m: Mode) => {
    cfg.mode = m;
    saveConfig(cfg);
    rerender();
  };

  const command = async (line: string) => {
    const [cmd, ...rest] = line.slice(1).split(/\s+/);
    const arg = rest.join(" ").trim();
    const a = agentRef.current;
    switch (cmd) {
      case "help":
      case "?":
        push({
          prefix: "  ",
          marginTop: 1,
          text: [
            ...COMMANDS.map((c) => ansi.cyan(`/${c.name}${c.args ? " " + c.args : ""}`.padEnd(22)) + ansi.gray(c.desc)),
            "",
            ansi.gray("@path          attach a file (its text, an image, or a directory listing)"),
            ansi.gray("ctrl+v         paste an image from the clipboard"),
            ansi.gray("\\ + enter      new line (alt+enter and ctrl+j too)"),
            ansi.gray("shift+tab      cycle mode · ctrl+t show/hide thinking"),
            ansi.gray("ctrl+o         every tool call in full (the transcript)"),
            ansi.gray("esc            close /btw, else stop the model · ctrl+d quit"),
            ansi.gray(`settings: ${tilde(path.join(path.dirname(USER_TEMPLATE), "config.json"))}`),
          ].join("\n"),
        });
        break;
      case "btw": {
        if (!arg) {
          notice("Usage: /btw <question> — asked on the side, without stopping the model.", "warn");
          break;
        }
        btw?.stop.abort();
        const stop = new AbortController();
        const update = (f: (b: NonNullable<typeof btw>) => Partial<NonNullable<typeof btw>>) =>
          setBtw((b) => (b && b.stop === stop ? { ...b, ...f(b) } : b));
        setBtw({ question: arg, answer: "", status: "waiting for the server", stop });
        let thought = 0;
        try {
          const answer = await a.btw(
            arg,
            {
              onReasoning: () => update(() => ({ status: `thinking · ${++thought} tokens` })),
              onContent: (t) => update((b) => ({ answer: b.answer + t, status: "" })),
            },
            stop.signal,
          );
          update(() => ({ answer, status: answer.trim() ? "" : "no answer" }));
        } catch (e: any) {
          if (!stop.signal.aborted) update(() => ({ status: `failed: ${e.message}` }));
        }
        break;
      }
      case "exit":
      case "quit":
        exit();
        break;
      case "clear":
        newAgent(newSession(cwd, cfg.model, systemPrompt(cwd)), false);
        notice("New conversation.");
        break;
      case "resume": {
        const list = listSessions(cwd).slice(0, 9);
        if (!list.length) {
          notice("No earlier conversations here.");
          break;
        }
        const i = await choose(
          "Resume which conversation?",
          list.map((x) => `${x.updated.slice(0, 16).replace("T", " ")}  ${title(x)}`),
        );
        if (i === null) break;
        const session = openSession(list[i]);
        newAgent(session, true);
        notice(`Resumed: ${title(session)}`);
        replay(session);
        break;
      }
      case "compact":
        setBusy({ label: "Compacting", detail: "", since: Date.now() });
        await a.compactNow();
        setBusy(null);
        break;
      case "mode": {
        const m = (arg || MODES[(MODES.indexOf(cfg.mode) + 1) % MODES.length]) as Mode;
        if (!MODES.includes(m)) notice("Modes: ro, edit, auto", "error");
        else setMode(m);
        break;
      }
      case "yolo":
        setMode("auto");
        notice("Auto mode: commands and edits run without asking. Shift+tab to change back.", "warn");
        break;
      case "effort": {
        const e = (arg || EFFORTS[(EFFORTS.indexOf(cfg.effort) + 1) % EFFORTS.length]) as Effort;
        if (!EFFORTS.includes(e)) notice("Effort: off, low, medium, high or max", "error");
        else setEffort(e);
        break;
      }
      case "thoughts":
        cfg.showThinking = !cfg.showThinking;
        saveConfig(cfg);
        rerender();
        break;
      case "model": {
        let models: string[];
        try {
          models = await listModels(cfg);
        } catch (e: any) {
          notice(e.message, "error");
          break;
        }
        let id = arg;
        if (!id) {
          const i = await choose("Model", models.map((m) => (m === cfg.model ? `${m} (current)` : m)));
          if (i === null) break;
          id = models[i];
        }
        if (!models.includes(id)) {
          notice(`The server has no model ${id}.`, "error");
          break;
        }
        cfg.model = id;
        const n = (await serverContext(cfg)) ?? cfg.contextWindow;
        setCtxWindow(n);
        a.contextWindow = n;
        notice(`Model ${id}.`);
        break;
      }
      case "ctx":
        notice(a.status());
        break;
      case "setting":
      case "settings": {
        const show = (key: keyof Config, v: unknown = cfg[key]) =>
          key === "apiKey" && v ? "(set)" : typeof v === "object" ? JSON.stringify(v) : v === "" ? '""' : String(v);
        const [name, ...words] = arg.split(/\s+/);
        if (!name) {
          const keys = Object.keys(DEFAULTS) as (keyof Config)[];
          const width = Math.max(...keys.map((k) => k.length)) + 2;
          push({
            prefix: "  ",
            marginTop: 1,
            text: [
              ...keys.map((k) => ansi.cyan(k.padEnd(width)) + show(k).slice(0, Math.max(20, columns - width - 6))),
              "",
              ansi.gray("/setting <name> <value> changes one (lists and objects as JSON)"),
            ].join("\n"),
          });
          break;
        }
        const key = settingName(name);
        if (!key) {
          notice(`No setting "${name}". /setting lists them.`, "error");
          break;
        }
        if (!words.length) {
          notice(`${key}: ${show(key)}`);
          break;
        }
        const parsed = parseSetting(key, words.join(" "));
        if ("error" in parsed) {
          notice(parsed.error, "error");
          break;
        }
        const value = parsed.value;
        if (key === "mode") setMode(value as Mode);
        else if (key === "effort") setEffort(value as Effort);
        else {
          saveSettings({ [key]: value });
          // The rest wait for the next start: changing the server or the
          // tools in the middle would leave the session out of step.
          if (LIVE_SETTINGS.has(key)) (cfg as any)[key] = value;
          if (key === "maxAgents") a.agentsChanged();
          rerender();
        }
        // The tool list is fixed for the session, so an agent tool left out at the start stays out.
        if (key === "maxAgents" && value !== 0 && !a.tools.some((t) => t.function.name === "agent"))
          notice(`maxAgents ${value} saved; sub-agents come back at the next start.`);
        else if (key === "maxAgents" && value === 0) notice("maxAgents 0: sub-agents off.");
        else if (key === "model") notice(`model ${show(key, value)} saved for the next start; /model switches now.`);
        else if (key !== "effort") notice(`${key} ${show(key, value)}${LIVE_SETTINGS.has(key) ? "" : " saved; takes effect at the next start"}.`);
        break;
      }
      case "sampling": {
        const s = samplingFor(cfg);
        if (!s) {
          notice(`No sampling settings match ${cfg.model}; the server's own apply. Add them under "sampling" in the settings.`);
          break;
        }
        const show = (p?: Record<string, unknown>) => (p ? Object.entries(p).map(([k, v]) => `${k} ${v}`).join(", ") : "the server's own");
        notice(`Sampling for ${cfg.model}${s.key !== cfg.model ? ` (from "${s.key}")` : ""}:`);
        notice(`  thinking: ${show(s.profile.thinking)}`);
        notice(`  no thinking: ${show(s.profile.noThinking)}${cfg.effort === "off" ? "   ← in use (effort off)" : ""}`);
        break;
      }
      case "advisors": {
        const list = a.advisors;
        for (const s of cfg.advisors) {
          const off = inactive(s);
          if (off) notice(`– ${s.name ?? (s.preset ? PRESETS[s.preset]?.name : "") ?? "advisor"} · ${off} (in the settings)`);
        }
        if (!list.length) {
          notice(
            `No advisors set up. Add one to "advisors" in the settings, e.g. {"preset": "groq", "apiKey": "…"}. Presets: ${Object.keys(PRESETS).join(", ")}.`,
          );
          break;
        }
        notice(`Testing ${list.length} advisor${list.length > 1 ? "s" : ""} (one try each, up to 30s)…`);
        // Each result as it comes, so one slow provider doesn't hide the rest.
        await Promise.all(
          list.map(async (adv) => {
            const t0 = Date.now();
            const r = await askAdvisors([adv], "Reply with just: OK", undefined, new AbortController().signal, { maxMs: 30_000 });
            const secs = ((Date.now() - t0) / 1000).toFixed(1);
            const was = dropped.has(adv.name) && r.ok ? " (was dropped; asking it again)" : dropped.has(adv.name) ? " (dropped this session)" : "";
            notice(`${r.ok ? "✓" : "✗"} ${adv.name} · ${adv.model} · ${r.ok ? `answered in ${secs}s` : r.notes.join("; ")}${was}`, r.ok ? "info" : "error");
          }),
        );
        break;
      }
      case "update":
        await update(true);
        break;
      case "log":
        notice(logPath(a.session));
        break;
      case "prompt":
        if (arg === "edit") {
          if (!fs.existsSync(USER_TEMPLATE)) {
            fs.mkdirSync(path.dirname(USER_TEMPLATE), { recursive: true });
            fs.copyFileSync(DEFAULT_TEMPLATE, USER_TEMPLATE);
          }
          notice(`Edit ${USER_TEMPLATE}. It's used from the next /clear or new session.`);
        } else {
          push({ marginTop: 1, text: `${ansi.gray(`template: ${tilde(templatePath())}`)}\n\n${systemPrompt(cwd)}` });
        }
        break;
      default:
        notice(`Unknown command /${cmd} — try /help`, "error");
    }
  };

  const onSubmit = (text: string) => {
    setExitArmed(false);
    const line = text.trim();
    if (line.startsWith("/") && !line.includes("\n")) {
      if (agentRef.current.running && !/^\/(btw|thoughts|mode|ctx|log|help)\b/.test(line)) {
        notice("Wait for the model to finish, or press esc.", "warn");
        return false;
      }
      void command(line);
      return;
    }
    setQueue((q) => [...q, line]);
  };

  // App-wide keys. The editor handles typing.
  useInput((input, key) => {
    if (transcriptOpen) return; // it has the keys
    if (key.ctrl && input === "o") return setShowTranscript(true);
    if (key.escape && btw && !ask && !pick && !question) {
      btw.stop.abort();
      setBtw(null);
    } else if (key.escape && agentRef.current.running && !ask && !pick && !question) agentRef.current.stop();
    else if (key.tab && key.shift) setMode(MODES[(MODES.indexOf(cfg.mode) + 1) % MODES.length]);
    else if (key.ctrl && input === "t") {
      cfg.showThinking = !cfg.showThinking;
      saveConfig(cfg);
      rerender();
    } else if (key.ctrl && input === "c" && agentRef.current.running) agentRef.current.stop();
  });

  // ---------- layout ----------

  // The line being written can be a long paragraph: show only its tail if it
  // wouldn't fit above the input.
  const fit = (t: string) => {
    const max = Math.max(200, (rows - 14) * Math.max(20, columns - 4));
    return t.length > max ? "…" + t.slice(t.length - max) : t;
  };
  const [modeColor, modeText] = MODE_LABEL[cfg.mode];
  const a = agentRef.current;
  // A question or permission prompt takes over from the transcript.
  const transcriptOpen = showTranscript && !pick && !ask && !question;
  const editorActive = !pick && !ask && !question && !transcriptOpen;
  const openTodos = todos.some((t) => t.status !== "done") ? todos : [];
  const runningJobs = a.jobs.list().filter((j) => !j.exit).length;

  return (
    <Width.Provider value={columns}>
      <Static items={items}>{(it) => <BlockView key={it.id} b={it.b} />}</Static>

      <Box flexDirection="column" justifyContent="flex-end" minHeight={Math.min(budget, maxBudget)}>
      {/* Measured without the padding around it: only real content growing past the budget grows it. */}
      <Box ref={liveRef} flexDirection="column">
      {transcriptOpen && (
        <Transcript entries={transcript.current} rows={rows} columns={columns} running={a.running} onClose={() => setShowTranscript(false)} />
      )}
      <Box flexDirection="column" display={transcriptOpen ? "none" : "flex"}>

      {groupLive && (groupLive.text || groupLive.current) && (
        <BlockView
          b={{
            prefix: "  ",
            text: [groupLive.text, groupLive.current && ansi.gray(`└ ${groupLive.current.slice(0, Math.max(20, columns - 8))}`)].filter(Boolean).join("\n"),
            color: "gray",
            marginTop: 1,
          }}
        />
      )}

      {liveThought && <BlockView b={blocks.thought(fit(liveThought), !s.current.thoughtStarted)} />}
      {live && <BlockView b={blocks.reply(fit(s.current.inCode !== null ? renderLines(live, s.current.inCode)[0] : live), !s.current.replyStarted)} />}
      {agents.size > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {[...agents.entries()].map(([id, st]) => (
            <AgentLine key={id} st={st} />
          ))}
        </Box>
      )}
      {busy && <Spinner {...busy} />}

      {queue.map((q, i) => (
        <Text key={i} color="gray">
          {"  "}queued: {q.split("\n")[0].slice(0, 100)}
          {i === queue.length - 1 ? "   (↑ to edit)" : ""}
        </Text>
      ))}

      {pick && (
        <Picker
          title={pick.title}
          options={pick.options}
          onPick={(i) => {
            const p = pick;
            setPick(null);
            p.resolve(i);
          }}
        />
      )}

      {ask && !ask.typing && (
        <Picker
          title={`Allow ${ask.tool}?  ${ask.summary.split("\n")[0].slice(0, 200)}`}
          options={["Yes", `Yes, and don't ask again for ${ask.tool} this session`, "No, and tell it what to do instead"]}
          onPick={(i) => {
            if (i === 2) return setAsks((q) => [{ ...q[0], typing: true }, ...q.slice(1)]);
            answerAsk(i === null ? { ok: false } : { ok: true, always: i === 1 });
          }}
        />
      )}
      {ask && ask.typing && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="yellow">Tell it what to do instead (enter on empty just says no):</Text>
          <Editor
            active
            cwd={cwd}
            keepHistory={false}
            onSubmit={(t) => {
              answerAsk({ ok: false, reason: t.trim() || undefined });
            }}
            onEscape={() => {
              answerAsk({ ok: false });
            }}
          />
        </Box>
      )}

      {question && !question.typing && (
        <Picker
          title={question.question}
          options={[...question.options, "Type an answer"]}
          onPick={(i) => {
            if (i === question.options.length) return setQuestion({ ...question, typing: true });
            const q = question;
            setQuestion(null);
            q.resolve(i === null ? null : q.options[i]);
          }}
        />
      )}
      {question && question.typing && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="yellow">{question.question}</Text>
          <Editor
            active
            cwd={cwd}
            keepHistory={false}
            onSubmit={(t) => {
              const q = question;
              setQuestion(null);
              q.resolve(t.trim() || null);
            }}
            onEscape={() => {
              const q = question;
              setQuestion(null);
              q.resolve(null);
            }}
          />
        </Box>
      )}

      {btw && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="gray" paddingX={1}>
          <Text color="cyan">/btw {btw.question}</Text>
          {btw.answer.trim() && <Text>{fit(renderMarkdown(btw.answer.trim()))}</Text>}
          <Text color="gray">{btw.status ? `${btw.status} · ` : ""}esc to close</Text>
        </Box>
      )}

      {openTodos.length > 0 && (
        <Box flexDirection="column" marginTop={1} paddingLeft={2}>
          {openTodos.map((t, i) => (
            <Text key={i} color={t.status === "done" ? "gray" : t.status === "in_progress" ? "cyan" : undefined} strikethrough={t.status === "done"}>
              {t.status === "done" ? "☒ " : t.status === "in_progress" ? "▸ " : "☐ "}
              {t.text}
            </Text>
          ))}
        </Box>
      )}

      <Box flexDirection="column" display={editorActive ? "flex" : "none"}>
        <Editor
          active={editorActive}
          cwd={cwd}
          placeholder={a.running ? "type to queue a message" : undefined}
          onSubmit={onSubmit}
          onRecall={() => {
            // Queued messages come back as one, to edit and send again.
            if (!queue.length) return null;
            const text = queue.join("\n");
            setQueue([]);
            return text;
          }}
          onCtrlV={() => {
            const img = clipboardImage();
            if (!img) return null;
            s.current.pasted.push(img);
            return `[image #${s.current.pasted.length}]`;
          }}
          onCtrlCEmpty={() => {
            if (agentRef.current.running) return; // the app-wide handler stops the turn
            if (exitArmed) exit();
            else setExitArmed(true);
          }}
          onExit={() => exit()}
        />
        <Box justifyContent="space-between" paddingX={1}>
          <Text>
            {exitArmed ? (
              <Text color="yellow">press ctrl+c again to quit</Text>
            ) : (
              <>
                <Text color={modeColor}>{modeText}</Text>
                <Text color="gray"> (shift+tab)</Text>
                {runningJobs > 0 && <Text color="blue"> · {runningJobs} background job{runningJobs > 1 ? "s" : ""}</Text>}
              </>
            )}
          </Text>
          <Text color="gray">
            ctx {a.usedPct}% · effort {cfg.effort} (/effort)
            {cfg.effort !== "off" ? (cfg.showThinking ? " · thoughts shown" : " · thoughts hidden") : ""}
          </Text>
        </Box>
      </Box>
      </Box>
      </Box>
      </Box>
    </Width.Provider>
  );
}

/**
 * stdout with each frame sent to the terminal in one write. Ink writes a frame
 * in pieces (erase the old one, then the new one), and a terminal without
 * synchronized output (VTE, for one) can show the screen between the pieces:
 * the flicker. Writes are gathered until the code writing them is done.
 */
function batchedStdout(): [NodeJS.WriteStream, () => void] {
  const out = process.stdout;
  let buf = "";
  let callbacks: (() => void)[] = [];
  let queued = false;
  const flush = () => {
    queued = false;
    if (!buf && !callbacks.length) return;
    const cbs = callbacks;
    const data = buf;
    buf = "";
    callbacks = [];
    out.write(data, () => cbs.forEach((cb) => cb()));
  };
  const write = (chunk: string | Uint8Array, enc?: any, cb?: any) => {
    if (typeof enc === "function") cb = enc;
    buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    if (cb) callbacks.push(cb);
    if (!queued) {
      queued = true;
      queueMicrotask(flush);
    }
    return true;
  };
  process.on("exit", flush);
  const stream = new Proxy(out, {
    get(target, prop) {
      if (prop === "write") return write;
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return [stream, flush];
}

export async function runApp(cfg: Config, session: Session, contextWindow: number, resumed: boolean) {
  const [stdout, flush] = batchedStdout();
  const inst = render(<App cfg={cfg} session={session} contextWindow={contextWindow} resumed={resumed} />, {
    stdout,
    exitOnCtrlC: false,
    // Rewrite only the lines that changed, not the whole frame.
    incrementalRendering: true,
  });
  await inst.waitUntilExit();
  flush();
  process.stdout.write(`\x1b[90mresume this conversation with: jcoder -c\x1b[0m\n`);
}
