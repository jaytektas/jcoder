import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { HOME } from "./config.js";

const NOTES = ["JCODER.md", "AGENTS.md"];

/** The user's notes: ~/.jcoder/JCODER.md, then the project's JCODER.md or AGENTS.md. */
export function notes(cwd: string): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const add = (file: string) => {
    try {
      const text = fs.readFileSync(file, "utf8").trim();
      if (text) out.push({ file, text });
    } catch {}
  };
  add(path.join(HOME, "JCODER.md"));
  for (const n of NOTES) {
    const f = path.join(cwd, n);
    if (fs.existsSync(f)) {
      add(f);
      break;
    }
  }
  return out;
}

function gitBranch(cwd: string): string | null {
  const r = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function systemPrompt(cwd: string): string {
  const branch = gitBranch(cwd);
  const env = [
    `Project directory: ${cwd}`,
    branch ? `Git branch: ${branch}` : "Not a git repository",
    `OS: ${os.type()} ${os.release()}`,
    `Date: ${new Date().toISOString().slice(0, 10)}`,
  ].join("\n");

  let p = `You are jcoder, a coding agent working in the user's project through tools.

How to work:
- Look before you change: read the relevant code first. Don't guess at file contents, APIs or command output.
- Make the change the user asked for, nothing more. Match the style of the surrounding code.
- Use edit_file for changes to existing files; old_string must be copied exactly from read_file output (without the line-number prefix).
- After changing code, build or run the tests if the project has them, and fix what you broke.
- If a command or edit fails, read the error and change approach. Don't repeat the same failing call.
- When you're done, reply with a short plain summary of what you did and anything left undone. If something failed, say so.
- Ask the user only when you can't proceed without their decision.

${env}`;

  for (const n of notes(cwd)) p += `\n\nNotes from ${n.file}:\n${n.text}`;
  return p;
}
