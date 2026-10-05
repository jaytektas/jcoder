// jcoder — a coding agent for a local LLM server
// Copyright (C) 2026 Jason Roughley
// SPDX-License-Identifier: GPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option)
// any later version. It is distributed WITHOUT ANY WARRANTY; see the LICENSE
// file for details.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface Command {
  name: string;
  args?: string;
  desc: string;
}

export const COMMANDS: Command[] = [
  { name: "help", desc: "commands and keys" },
  { name: "clear", desc: "start a new conversation" },
  { name: "resume", desc: "pick an earlier conversation in this directory" },
  { name: "compact", desc: "summarise the conversation to free context" },
  { name: "mode", args: "[ro|edit|auto]", desc: "permissions; no argument cycles (also shift+tab)" },
  { name: "yolo", desc: "auto mode: runs commands and edits without asking" },
  { name: "effort", args: "[off|low|medium|high|max]", desc: "how hard the model thinks; no argument cycles" },
  { name: "btw", args: "<question>", desc: "ask on the side while the model works; kept out of the conversation" },
  { name: "thoughts", desc: "show or hide the model's thinking (also ctrl+t)" },
  { name: "model", args: "[id]", desc: "list the server's models, or switch" },
  { name: "ctx", desc: "context use" },
  { name: "prompt", args: "[edit]", desc: "show the system prompt; edit makes a copy to change" },
  { name: "log", desc: "where this conversation's full log is" },
  { name: "update", desc: "check for a new jcoder release and install it" },
  { name: "advisors", desc: "the remote models ask_model can use, each tested" },
  { name: "sampling", desc: "the sampling settings in use for this model" },
  { name: "setting", args: "[name [value]]", desc: "show the settings, or change one" },
  { name: "exit", desc: "quit (also ctrl+d)" },
];

export function matchCommands(query: string): Command[] {
  const q = query.toLowerCase();
  return COMMANDS.filter((c) => c.name.startsWith(q)).concat(
    COMMANDS.filter((c) => !c.name.startsWith(q) && c.name.includes(q)),
  );
}

const SKIP = new Set([".git", "node_modules", "dist", "build", ".venv", "__pycache__", "target", ".cache"]);
const MAX_FILES = 20000;

/** Project files for @ completion: git's list when it's a repo, else a walk. Cached per directory for 30 s. */
let cache: { cwd: string; at: number; files: string[] } | null = null;

export function projectFiles(cwd: string): string[] {
  if (cache && cache.cwd === cwd && Date.now() - cache.at < 30_000) return cache.files;
  let files: string[] = [];
  const git = spawnSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd, encoding: "utf8", maxBuffer: 64 << 20 });
  if (git.status === 0) files = git.stdout.split("\n").filter(Boolean).slice(0, MAX_FILES);
  else {
    const walk = (dir: string, rel: string) => {
      if (files.length >= MAX_FILES) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (SKIP.has(e.name) || e.name.startsWith(".")) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(dir, e.name), r);
        else files.push(r);
      }
    };
    walk(cwd, "");
  }
  // Directories too, so @src/ can be picked.
  const dirs = new Set<string>();
  for (const f of files) {
    let d = path.dirname(f);
    while (d !== "." && !dirs.has(d + "/")) {
      dirs.add(d + "/");
      d = path.dirname(d);
    }
  }
  files = [...dirs, ...files];
  cache = { cwd, at: Date.now(), files };
  return files;
}

/** Best matches first: name starts with the query, then name contains it, then path does. */
export function matchFiles(cwd: string, query: string, limit = 8): string[] {
  const files = projectFiles(cwd);
  const q = query.toLowerCase();
  if (!q) return files.filter((f) => !f.slice(0, -1).includes("/")).slice(0, limit);
  const scored: [number, string][] = [];
  for (const f of files) {
    const lf = f.toLowerCase();
    const base = path.basename(lf.endsWith("/") ? lf.slice(0, -1) : lf);
    let s: number;
    if (lf.startsWith(q)) s = 0;
    else if (base.startsWith(q)) s = 1;
    else if (base.includes(q)) s = 2;
    else if (lf.includes(q)) s = 3;
    else continue;
    scored.push([s * 1000 + f.length, f]);
  }
  return scored
    .sort((a, b) => a[0] - b[0])
    .slice(0, limit)
    .map(([, f]) => f);
}

/** The @word or /word under the cursor, if any. */
export function tokenAt(value: string, cursor: number): { kind: "@" | "/"; start: number; query: string } | null {
  let start = cursor;
  while (start > 0 && !/\s/.test(value[start - 1])) start--;
  const word = value.slice(start, cursor);
  if (word.startsWith("@")) return { kind: "@", start, query: word.slice(1) };
  if (start === 0 && word.startsWith("/") && !value.slice(0, cursor).includes("\n"))
    return { kind: "/", start, query: word.slice(1) };
  return null;
}
