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
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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

const PROMPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts");

/** The built-in template, shipped next to dist/. */
export const DEFAULT_TEMPLATE = path.join(PROMPTS, "system.md");
/** A copy here replaces the built-in one. */
export const USER_TEMPLATE = path.join(HOME, "system.md");

export function templatePath(name = "system"): string {
  const mine = path.join(HOME, `${name}.md`);
  return fs.existsSync(mine) ? mine : path.join(PROMPTS, `${name}.md`);
}

/**
 * A prompt from its template, with {{cwd}}, {{git}}, {{os}}, {{date}} and
 * {{notes}} filled in. Unknown {{names}} are left as they are.
 */
function render(name: string, cwd: string): string {
  const branch = gitBranch(cwd);
  const vars: Record<string, string> = {
    cwd,
    git: branch ? `Git branch: ${branch}` : "Not a git repository",
    os: `${os.type()} ${os.release()}`,
    date: new Date().toLocaleDateString("en-CA"), // local YYYY-MM-DD
    notes: notes(cwd)
      .map((n) => `\nNotes from ${n.file}:\n${n.text}`)
      .join("\n"),
  };
  const template = fs.readFileSync(templatePath(name), "utf8");
  return template.replace(/\{\{(\w+)\}\}/g, (m, key) => vars[key] ?? m).trim();
}

/** The main agent's system prompt (prompts/system.md, or ~/.jcoder/system.md). */
export const systemPrompt = (cwd: string) => render("system", cwd);

/** A sub-agent's (prompts/agent.md, or ~/.jcoder/agent.md). */
export const agentPrompt = (cwd: string) => render("agent", cwd);
