// jcoder — a coding agent for a local LLM server
// Copyright (C) 2026 Jason Roughley
// SPDX-License-Identifier: GPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option)
// any later version. It is distributed WITHOUT ANY WARRANTY; see the LICENSE
// file for details.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Content, ToolSchema } from "./client.js";
import { ask as askAdvisors, type Advisor } from "./advisors.js";
import { HOME, type Mode } from "./config.js";
import { isImagePath, kb, loadImage } from "./images.js";
import type { Jobs } from "./jobs.js";
import { webFetch, webSearch } from "./web.js";
import { c } from "./ui.js";

export interface ToolResult {
  /** What the model sees. */
  content: Content;
  /** What the user sees, if different from a preview of content. */
  display?: string;
  error?: boolean;
}

export interface Todo {
  text: string;
  status: "pending" | "in_progress" | "done";
}

export interface Approval {
  ok: boolean;
  /** Allow this tool for the rest of the session. */
  always?: boolean;
  /** The user's reason for saying no, passed on to the model. */
  reason?: string;
}

export interface ToolContext {
  cwd: string;
  mode: Mode;
  signal: AbortSignal;
  maxChars: number;
  /** Default bash timeout, seconds. */
  bashTimeout: number;
  /** SearXNG server for web_search; empty = off. */
  searchUrl: string;
  jobs: Jobs;
  /** Remote models for ask_model, in order. */
  advisors: Advisor[];
  /** An advisor ignored us enough to drop (per the dropAdvisors setting); undefined when the setting is "never". */
  dropAdvisor?: (a: Advisor, why: string) => void;
  /** Puts a question to the user; null if they didn't answer. */
  ask(question: string, options: string[]): Promise<string | null>;
  setTodos(items: Todo[]): void;
  /** Starts a sub-agent and resolves with its report; missing inside a sub-agent. */
  runAgent?(description: string, task: string): Promise<ToolResult>;
  approve(tool: string, summary: string): Promise<Approval>;
  /** path -> mtime when the model last read or wrote it. */
  seen: Map<string, number>;
}

interface Tool {
  schema: ToolSchema;
  /** Changes files or runs commands. */
  writes: boolean;
  /** One line for the UI. */
  summary(args: any): string;
  run(args: any, ctx: ToolContext): Promise<ToolResult>;
}

const fail = (content: string): ToolResult => ({ content, error: true });

function def(
  name: string,
  description: string,
  properties: Record<string, object>,
  required: string[],
): ToolSchema {
  return {
    type: "function",
    function: { name, description, parameters: { type: "object", properties, required } },
  };
}

const str = (description: string) => ({ type: "string", description });
const int = (description: string) => ({ type: "integer", description });

function resolve(ctx: ToolContext, p: string): string {
  return path.resolve(ctx.cwd, p.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
}

function rel(ctx: ToolContext, abs: string): string {
  const r = path.relative(ctx.cwd, abs);
  return r && !r.startsWith("..") ? r : abs;
}

/** Cuts long output to head + tail and saves the whole thing to a file. */
export function cap(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const dir = path.join(HOME, "tmp");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `out-${Date.now()}.txt`);
  fs.writeFileSync(file, text);
  const head = text.slice(0, Math.floor(maxChars * 0.6));
  const tail = text.slice(text.length - Math.floor(maxChars * 0.4));
  const cut = text.length - head.length - tail.length;
  return `${head}\n\n[... ${cut} characters cut. Full output: ${file} — read_file it with offset/limit, or grep it]\n\n${tail}`;
}

function mtime(p: string): number {
  return fs.statSync(p).mtimeMs;
}

/** An existing file must have been read, and not changed since, before it is changed. */
function checkSeen(ctx: ToolContext, abs: string): string | null {
  if (!fs.existsSync(abs)) return null;
  const seen = ctx.seen.get(abs);
  if (seen === undefined) return `${rel(ctx, abs)} exists and you haven't read it. read_file it first.`;
  if (mtime(abs) !== seen) return `${rel(ctx, abs)} changed since you read it. read_file it again first.`;
  return null;
}

function diffPreview(oldText: string, newText: string, maxLines = 12): string {
  const minus = oldText.split("\n").map((l) => c.red(`- ${l}`));
  const plus = newText.split("\n").map((l) => c.green(`+ ${l}`));
  const clip = (a: string[]) =>
    a.length > maxLines ? [...a.slice(0, maxLines), c.gray(`  … ${a.length - maxLines} more`)] : a;
  return [...clip(minus), ...clip(plus)].join("\n");
}

const readFile: Tool = {
  schema: def(
    "read_file",
    "Read a text file (numbered lines; large files: use offset/limit), or look at an image (png, jpg, gif, webp, bmp).",
    {
      path: str("File path, absolute or relative to the project"),
      offset: int("First line to read, 1-based (default 1)"),
      limit: int("Number of lines (default 2000)"),
    },
    ["path"],
  ),
  writes: false,
  summary: (a) => `${a.path}${a.offset ? `:${a.offset}` : ""}`,
  async run(a, ctx) {
    const abs = resolve(ctx, String(a.path ?? ""));
    let buf: Buffer;
    try {
      if (fs.statSync(abs).isDirectory()) return fail(`${a.path} is a directory. Use glob to list it.`);
      buf = fs.readFileSync(abs);
    } catch (e: any) {
      return fail(e.code === "ENOENT" ? `${a.path} does not exist.` : e.message);
    }
    if (isImagePath(abs)) {
      let img;
      try {
        img = loadImage(abs);
      } catch (e: any) {
        return fail(e.message);
      }
      return {
        content: [
          { type: "text", text: `Image ${rel(ctx, abs)} (${kb(img.bytes)}):` },
          { type: "image_url", image_url: { url: img.url } },
        ],
        display: `image, ${kb(img.bytes)}`,
      };
    }
    if (buf.subarray(0, 8000).includes(0)) return fail(`${a.path} is a binary file.`);
    ctx.seen.set(abs, mtime(abs));
    const lines = buf.toString("utf8").split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    const offset = Math.max(1, Number(a.offset) || 1);
    const limit = Math.max(1, Number(a.limit) || 2000);
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    if (!slice.length) return { content: `(${a.path} has ${lines.length} lines; nothing at line ${offset})` };
    let out = slice
      .map((l, i) => `${offset + i}\t${l.length > 2000 ? l.slice(0, 2000) + " [line cut]" : l}`)
      .join("\n");
    const end = offset - 1 + slice.length;
    if (end < lines.length) out += `\n\n(lines ${offset}-${end} of ${lines.length}; use offset to read more)`;
    return {
      content: cap(out, ctx.maxChars),
      display: `${slice.length} line${slice.length === 1 ? "" : "s"}${end < lines.length ? ` of ${lines.length}` : ""}`,
    };
  },
};

const writeFile: Tool = {
  schema: def(
    "write_file",
    "Create or overwrite a file with the given content. For changes to an existing file prefer edit_file.",
    { path: str("File path"), content: str("The whole new file content") },
    ["path", "content"],
  ),
  writes: true,
  summary: (a) => String(a.path),
  async run(a, ctx) {
    const abs = resolve(ctx, String(a.path ?? ""));
    const content = String(a.content ?? "");
    const stale = checkSeen(ctx, abs);
    if (stale) return fail(stale);
    const existed = fs.existsSync(abs);
    const ok = await ctx.approve("write_file", `${existed ? "overwrite" : "create"} ${rel(ctx, abs)}`);
    if (!ok.ok) return fail(`User declined.${ok.reason ? ` They said: ${ok.reason}` : ""}`);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    ctx.seen.set(abs, mtime(abs));
    const n = content.split("\n").length;
    return { content: `${existed ? "Overwrote" : "Created"} ${rel(ctx, abs)} (${n} lines).`, display: `${n} line${n === 1 ? "" : "s"}` };
  },
};

/** Finds old text whose lines match ignoring leading/trailing whitespace. */
function looseMatch(file: string, old: string): { start: number; end: number } | null {
  const fl = file.split("\n");
  const ol = old.split("\n").map((l) => l.trim());
  while (ol.length && ol[ol.length - 1] === "") ol.pop();
  if (!ol.length) return null;
  let found: { start: number; end: number } | null = null;
  for (let i = 0; i + ol.length <= fl.length; i++) {
    if (ol.every((l, k) => fl[i + k].trim() === l)) {
      if (found) return null; // ambiguous
      found = { start: i, end: i + ol.length };
    }
  }
  return found;
}

const editFile: Tool = {
  schema: def(
    "edit_file",
    "Replace exact text in a file. old_string must match the file exactly, including indentation, " +
      "and be unique unless replace_all is true. Include enough surrounding lines to make it unique.",
    {
      path: str("File path"),
      old_string: str("Exact text to replace"),
      new_string: str("Replacement text"),
      replace_all: { type: "boolean", description: "Replace every occurrence (default false)" },
    },
    ["path", "old_string", "new_string"],
  ),
  writes: true,
  summary: (a) => String(a.path),
  async run(a, ctx) {
    const abs = resolve(ctx, String(a.path ?? ""));
    const oldS = String(a.old_string ?? "");
    const newS = String(a.new_string ?? "");
    if (!fs.existsSync(abs)) return fail(`${a.path} does not exist. Use write_file to create it.`);
    const stale = checkSeen(ctx, abs);
    if (stale) return fail(stale);
    if (!oldS) return fail("old_string is empty.");
    if (oldS === newS) return fail("old_string and new_string are the same.");
    const text = fs.readFileSync(abs, "utf8");
    const count = text.split(oldS).length - 1;
    if (count === 0) {
      const m = looseMatch(text, oldS);
      if (m) {
        const actual = text.split("\n").slice(m.start, m.end).join("\n");
        return fail(
          `old_string not found exactly. Lines ${m.start + 1}-${m.end} match except for whitespace. ` +
            `The file has:\n${actual}\nRetry with that exact text.`,
        );
      }
      return fail(`old_string not found in ${a.path}. read_file it and copy the text exactly.`);
    }
    if (count > 1 && !a.replace_all)
      return fail(`old_string occurs ${count} times. Add surrounding lines to make it unique, or set replace_all.`);
    const ok = await ctx.approve("edit_file", `edit ${rel(ctx, abs)}`);
    if (!ok.ok) return fail(`User declined.${ok.reason ? ` They said: ${ok.reason}` : ""}`);
    const updated = a.replace_all ? text.split(oldS).join(newS) : text.replace(oldS, () => newS);
    fs.writeFileSync(abs, updated);
    ctx.seen.set(abs, mtime(abs));
    const line = text.slice(0, text.indexOf(oldS)).split("\n").length;
    return {
      content: `Edited ${rel(ctx, abs)}${count > 1 ? ` (${count} places)` : ` at line ${line}`}.`,
      display: diffPreview(oldS, newS),
    };
  },
};

const bash: Tool = {
  schema: def(
    "bash",
    "Run a bash command in the project directory. Each call is a fresh shell: cd does not carry over. " +
      "Output is stdout+stderr. Don't run interactive programs. For a server, watcher or anything that " +
      "keeps running, set background: you get a job id at once; read its output with bash_output, stop it with bash_stop.",
    {
      command: str("The command"),
      timeout: int("Seconds before it is killed (max 600); not for background jobs"),
      background: { type: "boolean", description: "Run it in the background and return straight away" },
    },
    ["command"],
  ),
  writes: true,
  summary: (a) => String(a.command),
  async run(a, ctx) {
    const cmd = String(a.command ?? "");
    if (!cmd.trim()) return fail("command is empty.");
    const ok = await ctx.approve("bash", cmd);
    if (!ok.ok) return fail(`User declined.${ok.reason ? ` They said: ${ok.reason}` : ""}`);
    if (a.background) {
      const job = ctx.jobs.start(cmd, ctx.cwd);
      // A second's output catches a command that fails straight away.
      const first = await ctx.jobs.output(job.id, 1000, ctx.signal);
      const out = first?.text.trim() ? `\n${cap(first.text.replace(/\s+$/, ""), ctx.maxChars)}` : "";
      return {
        content: `Started ${job.id} (${first?.status}).${out}\nRead more with bash_output ${job.id}; stop it with bash_stop ${job.id}.`,
        display: `${job.id} ${first?.status}${out ? "\n" + out.trim().split("\n").slice(-4).join("\n") : ""}`,
      };
    }
    const timeout = Math.min(600, Math.max(1, Number(a.timeout) || ctx.bashTimeout)) * 1000;
    return new Promise((done) => {
      const child = spawn("bash", ["-c", cmd], {
        cwd: ctx.cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PAGER: "cat", GIT_PAGER: "cat", TERM: "dumb" },
      });
      let out = "";
      let why = "";
      const kill = (reason: string) => {
        why = reason;
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {}
      };
      const timer = setTimeout(() => kill(`killed after ${timeout / 1000}s`), timeout);
      const onAbort = () => kill("interrupted by user");
      ctx.signal.addEventListener("abort", onAbort);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      // Finish when bash exits, not when its output pipes close: a process it
      // started in the background (a dev server, say) can hold them open for
      // ever. Give the pipes a moment to drain, then let go of them and leave
      // any background process running.
      let finished = false;
      const finish = (code: number | null) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
        child.stdout.destroy();
        child.stderr.destroy();
        const status = why || `exit ${code}`;
        const body = out.trim() ? cap(out.replace(/\s+$/, ""), ctx.maxChars) : "(no output)";
        done({ content: `${body}\n[${status}]`, error: why !== "" || code !== 0 });
      };
      child.on("exit", (code) => setTimeout(() => finish(code), 200));
      child.on("close", (code) => finish(code));
      child.on("error", (e) => done(fail(e.message)));
    });
  },
};

const bashOutput: Tool = {
  schema: def(
    "bash_output",
    "New output from a background job since you last read it, and whether it is still running.",
    { id: str("Job id, e.g. job1"), wait: int("Seconds to wait for new output or for it to finish (default 0, max 120)") },
    ["id"],
  ),
  writes: false,
  summary: (a) => `${a.id}${a.wait ? ` (wait ${a.wait}s)` : ""}`,
  async run(a, ctx) {
    const wait = Math.min(120, Math.max(0, Number(a.wait) || 0)) * 1000;
    const r = await ctx.jobs.output(String(a.id ?? ""), wait, ctx.signal);
    if (!r) {
      const ids = ctx.jobs.list().map((j) => `${j.id} (${ctx.jobs.status(j)}): ${j.command}`);
      return fail(`No job ${a.id}.${ids.length ? ` Jobs:\n${ids.join("\n")}` : " There are no jobs."}`);
    }
    const body = r.text.trim() ? cap(r.text.replace(/\s+$/, ""), ctx.maxChars) : "(no new output)";
    return { content: `${body}\n[${r.status}]`, display: `${r.status}${r.text.trim() ? `, ${r.text.trim().split("\n").length} new lines` : ", no new output"}` };
  },
};

const bashStop: Tool = {
  schema: def("bash_stop", "Stop a background job.", { id: str("Job id") }, ["id"]),
  writes: false,
  summary: (a) => String(a.id),
  async run(a, ctx) {
    return ctx.jobs.stop(String(a.id ?? "")) ? { content: `Stopped ${a.id}.` } : fail(`No job ${a.id}.`);
  },
};

const todo: Tool = {
  schema: def(
    "todo",
    "Your to-do list for a task with several steps; the user sees it. Send the whole list each time, " +
      "marking one item in_progress while you work on it and items done as you finish them. Skip it for simple tasks.",
    {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            text: { type: "string" },
            status: { type: "string", enum: ["pending", "in_progress", "done"] },
          },
          required: ["text", "status"],
        },
      },
    },
    ["items"],
  ),
  writes: false,
  summary: (a) => {
    const items: Todo[] = Array.isArray(a.items) ? a.items : [];
    return `${items.filter((i) => i.status === "done").length}/${items.length} done`;
  },
  async run(a, ctx) {
    if (!Array.isArray(a.items)) return fail("items must be a list of {text, status}.");
    const items: Todo[] = a.items
      .filter((i: any) => i && typeof i.text === "string")
      .map((i: any) => ({ text: i.text, status: ["pending", "in_progress", "done"].includes(i.status) ? i.status : "pending" }));
    ctx.setTodos(items);
    const mark = { pending: "[ ]", in_progress: "[>]", done: "[x]" };
    return { content: "To-do list updated.", display: items.map((i) => `${mark[i.status]} ${i.text}`).join("\n") };
  },
};

const askUser: Tool = {
  schema: def(
    "ask_user",
    "Ask the user a question when you need their decision to go on. Offer options when there are clear choices; they can also type an answer.",
    { question: str("The question"), options: { type: "array", items: { type: "string" }, description: "Choices, if any" } },
    ["question"],
  ),
  writes: false,
  summary: (a) => String(a.question),
  async run(a, ctx) {
    const options = Array.isArray(a.options) ? a.options.map(String).slice(0, 8) : [];
    const answer = await ctx.ask(String(a.question ?? ""), options);
    if (answer === null) return { content: "The user didn't answer. Decide yourself, and say what you assumed.", display: "no answer" };
    return { content: `The user answered: ${answer}`, display: answer };
  },
};

const askModel: Tool = {
  schema: def(
    "ask_model",
    "Ask a stronger remote model for a second opinion: a hard bug, a design choice, an API you're unsure of. " +
      "It sees nothing of this conversation or the project, only your question, so include the code, errors " +
      "and context it needs. It can't run tools. Don't send secrets. If the one asked is busy, the next answers.",
    {
      question: str("The question, with everything needed to answer it"),
      advisor: str("Which to ask first (default: the first listed)"),
    },
    ["question"],
  ),
  writes: false,
  summary: (a) => `${a.advisor ? `${a.advisor}: ` : ""}${String(a.question).replace(/\s+/g, " ").slice(0, 120)}`,
  async run(a, ctx) {
    if (!ctx.advisors.length) return fail("No advisors are set up.");
    const r = await askAdvisors(ctx.advisors, String(a.question ?? ""), a.advisor ? String(a.advisor) : undefined, ctx.signal, undefined, ctx.dropAdvisor);
    if (!r.ok) return fail(`No advisor answered:\n${r.notes.join("\n")}`);
    const tried = r.notes.length ? ` (after ${r.notes.map((n) => n.split(":")[0]).join(", ")} didn't answer)` : "";
    return {
      content: cap(`${r.advisor.name} (${r.advisor.model}) says${tried}:\n\n${r.text}`, ctx.maxChars),
      display: `${r.advisor.name}${tried}\n${r.text}`,
    };
  },
};

const agentTool: Tool = {
  schema: def(
    "agent",
    "Hand a self-contained job to a sub-agent with a fresh context: exploring or searching a large codebase, " +
      "researching a question, or a well-defined change. It has the same tools, sees nothing of this conversation, " +
      "and returns a report, so the task must say everything it needs (goal, paths, what to report back). " +
      "Several agent calls in one reply run at the same time. Use it to keep your own context small, " +
      "not for a lookup you can do in a call or two.",
    {
      description: str("3 to 6 words for the screen, e.g. \"find the CAN frame parser\""),
      task: str("The whole job, written for someone who knows nothing of this conversation"),
    },
    ["description", "task"],
  ),
  writes: false,
  summary: (a) => String(a.description ?? ""),
  async run(a, ctx) {
    if (!ctx.runAgent) return fail("A sub-agent can't start agents of its own. Do it yourself.");
    const task = String(a.task ?? "").trim();
    if (!task) return fail("task is empty.");
    return ctx.runAgent(String(a.description ?? "agent").slice(0, 60), task);
  },
};

const hasRg = spawnSync("rg", ["--version"]).status === 0;
const SKIP_DIRS = [".git", "node_modules", "dist", "build", ".venv", "__pycache__", "target"];

const grep: Tool = {
  schema: def(
    "grep",
    "Search file contents with a regular expression. Returns path:line:text.",
    {
      pattern: str("Regular expression (extended syntax)"),
      path: str("File or directory to search (default: project)"),
      glob: str("Only files matching this, e.g. *.ts"),
      ignore_case: { type: "boolean", description: "Case-insensitive" },
    },
    ["pattern"],
  ),
  writes: false,
  summary: (a) => `${a.pattern}${a.path ? `  ${a.path}` : ""}${a.glob ? `  (${a.glob})` : ""}`,
  async run(a, ctx) {
    const target = a.path ? resolve(ctx, String(a.path)) : ctx.cwd;
    const args: string[] = [];
    let bin: string;
    if (hasRg) {
      bin = "rg";
      args.push("-n", "--no-heading", "--color=never", "-M", "300");
      if (a.ignore_case) args.push("-i");
      if (a.glob) args.push("-g", String(a.glob));
    } else {
      bin = "grep";
      args.push("-rnIE", "--color=never", ...SKIP_DIRS.map((d) => `--exclude-dir=${d}`));
      if (a.ignore_case) args.push("-i");
      if (a.glob) args.push(`--include=${a.glob}`);
    }
    args.push("-e", String(a.pattern ?? ""), target);
    const r = spawnSync(bin, args, { cwd: ctx.cwd, encoding: "utf8", maxBuffer: 64 << 20 });
    if (r.status === 1) return { content: "No matches.", display: "no matches" };
    if (r.status !== 0) return fail(r.stderr.trim() || `${bin} failed`);
    const lines = r.stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => (l.startsWith(ctx.cwd + "/") ? l.slice(ctx.cwd.length + 1) : l));
    const shown = lines.slice(0, 300);
    let out = shown.join("\n");
    if (lines.length > shown.length) out += `\n\n(${lines.length} matches, first 300 shown; narrow the search)`;
    return { content: cap(out, ctx.maxChars), display: `${lines.length} matches` };
  },
};

const glob: Tool = {
  schema: def(
    "glob",
    "Find files by name pattern, e.g. **/*.ts or src/*. Skips .git, node_modules and build output.",
    { pattern: str("Glob pattern"), path: str("Directory to search from (default: project)") },
    ["pattern"],
  ),
  writes: false,
  summary: (a) => `${a.pattern}${a.path ? `  ${a.path}` : ""}`,
  async run(a, ctx) {
    const base = a.path ? resolve(ctx, String(a.path)) : ctx.cwd;
    let files: string[];
    try {
      files = fs.globSync(String(a.pattern ?? "*"), {
        cwd: base,
        exclude: (p: string) => SKIP_DIRS.includes(path.basename(p)),
      });
    } catch (e: any) {
      return fail(e.message);
    }
    files.sort();
    if (!files.length) return { content: "No files match.", display: "none" };
    const prefix = base === ctx.cwd ? "" : rel(ctx, base) + "/";
    const shown = files.slice(0, 500).map((f) => prefix + f);
    let out = shown.join("\n");
    if (files.length > 500) out += `\n\n(${files.length} files, first 500 shown)`;
    return { content: out, display: `${files.length} files` };
  },
};

const search: Tool = {
  schema: def(
    "web_search",
    "Search the web. Returns titles, URLs and snippets; web_fetch a result to read it.",
    { query: str("Search terms"), count: int("Number of results (default 8, max 20)") },
    ["query"],
  ),
  writes: false,
  summary: (a) => String(a.query),
  run: (a, ctx) => webSearch(ctx.searchUrl, String(a.query ?? ""), Number(a.count) || 8, ctx.signal),
};

const fetchPage: Tool = {
  schema: def(
    "web_fetch",
    "Fetch a web page and return its main text (or a JSON/text file as it is). Long pages are cut; the full text is saved to a file you can read.",
    { url: str("http(s) URL") },
    ["url"],
  ),
  writes: false,
  summary: (a) => String(a.url),
  async run(a, ctx) {
    const r = await webFetch(String(a.url ?? ""), ctx.signal);
    return typeof r.content === "string" ? { ...r, content: cap(r.content, ctx.maxChars) } : r;
  },
};

export const TOOLS: Record<string, Tool> = Object.fromEntries(
  [readFile, writeFile, editFile, bash, bashOutput, bashStop, grep, glob, search, fetchPage, todo, askUser, askModel, agentTool].map((t) => [
    t.schema.function.name,
    t,
  ]),
);

/**
 * Always every tool, whatever the mode: the tool list is part of the prompt,
 * and changing it would throw away the server's cache. Read-only mode refuses
 * writing tools when they're called instead.
 */
/** Tools a sub-agent doesn't get: it can't start agents, ask the user, or own the to-do list. */
const MAIN_ONLY = new Set(["agent", "ask_user", "todo"]);

export function schemas(opts: { advisors: Advisor[]; searchUrl: string; maxAgents: number }, sub = false): ToolSchema[] {
  // Tools that need setting up are only offered once they are.
  const names = opts.advisors.map((a) => `${a.name} (${a.model})`).join(", ");
  return Object.values(TOOLS)
    .filter((t) => !sub || !MAIN_ONLY.has(t.schema.function.name))
    .filter((t) => t.schema.function.name !== "agent" || opts.maxAgents !== 0)
    .filter((t) => t.schema.function.name !== "ask_model" || opts.advisors.length)
    .filter((t) => t.schema.function.name !== "web_search" || opts.searchUrl)
    .map((t) =>
      t.schema.function.name === "ask_model"
        ? { ...t.schema, function: { ...t.schema.function, description: `Advisors: ${names}. ${t.schema.function.description}` } }
        : t.schema,
    );
}
