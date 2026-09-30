import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Content, ToolSchema } from "./client.js";
import { HOME, type Mode } from "./config.js";
import { isImagePath, kb, loadImage } from "./images.js";
import { c } from "./ui.js";

export interface ToolResult {
  /** What the model sees. */
  content: Content;
  /** What the user sees, if different from a preview of content. */
  display?: string;
  error?: boolean;
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
      display: `${slice.length} lines${end < lines.length ? ` of ${lines.length}` : ""}`,
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
    return { content: `${existed ? "Overwrote" : "Created"} ${rel(ctx, abs)} (${n} lines).`, display: `${n} lines` };
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
      "Output is stdout+stderr. Don't run interactive programs. For a server or anything long-running, " +
      "start it in the background with its output redirected to a file (cmd > /tmp/x.log 2>&1 &); it keeps running after the call returns.",
    {
      command: str("The command"),
      timeout: int("Seconds before it is killed (default 120, max 600)"),
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
    const timeout = Math.min(600, Math.max(1, Number(a.timeout) || 120)) * 1000;
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

export const TOOLS: Record<string, Tool> = Object.fromEntries(
  [readFile, writeFile, editFile, bash, grep, glob].map((t) => [t.schema.function.name, t]),
);

/**
 * Always every tool, whatever the mode: the tool list is part of the prompt,
 * and changing it would throw away the server's cache. Read-only mode refuses
 * writing tools when they're called instead.
 */
export const SCHEMAS: ToolSchema[] = Object.values(TOOLS).map((t) => t.schema);
