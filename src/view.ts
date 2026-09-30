// jcoder — a coding agent for a local LLM server
// Copyright (C) 2026 Jason Roughley
// SPDX-License-Identifier: GPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option)
// any later version. It is distributed WITHOUT ANY WARRANTY; see the LICENSE
// file for details.

import type { Approval, Todo } from "./tools.js";
import { c, indent, preview, write } from "./ui.js";

/** What the agent reports while it works. The Ink app and plain output both implement it. */
export interface View {
  /** The status line while a turn runs: "Thinking", "Running bash", ... `progress` 0–1 draws a bar. */
  busy(label: string, detail?: string, progress?: number): void;
  /** A chunk of the model's thinking; only sent while thinking is shown. */
  thinking(chunk: string): void;
  /** A chunk of the model's reply. */
  text(chunk: string): void;
  /** The current model message is complete. */
  endMessage(): void;
  tool(name: string, summary: string): void;
  result(display: string, error: boolean): void;
  notice(text: string, tone?: "info" | "warn" | "error"): void;
  approve(tool: string, summary: string): Promise<Approval>;
  /** ask_user: the answer, or null if none. */
  ask(question: string, options: string[]): Promise<string | null>;
  todos(items: Todo[]): void;
  turnDone(info: { seconds: number; status: string; stopped: boolean }): void;
}

/** For -p: plain text on stdout, no questions. */
export class PlainView implements View {
  private printed = "";
  private held = "";

  busy() {}
  thinking() {}

  text(chunk: string) {
    // Drop leading whitespace, hold trailing whitespace until more text comes.
    if (!this.printed && !this.held) chunk = chunk.replace(/^\s+/, "");
    const body = chunk.replace(/\s+$/, "");
    if (body) {
      write(this.held + body);
      this.printed += this.held + body;
      this.held = chunk.slice(body.length);
    } else this.held += chunk;
  }

  endMessage() {
    if (this.printed) write("\n\n");
    this.printed = this.held = "";
  }

  tool(name: string, summary: string) {
    write(`${c.blue("●")} ${c.bold(name)} ${summary.split("\n")[0]}\n`);
  }

  result(display: string, error: boolean) {
    const text = error ? c.red(preview(display, 8)) : c.gray(display);
    write(indent(text, "  └ ").replace(/\n  └ /g, "\n    ") + "\n");
  }

  notice(text: string, tone: "info" | "warn" | "error" = "info") {
    write((tone === "error" ? c.red : tone === "warn" ? c.yellow : c.gray)(text) + "\n");
  }

  async approve(): Promise<Approval> {
    return { ok: false, reason: "not allowed without asking, and -p can't ask; run with --mode auto" };
  }

  async ask(): Promise<string | null> {
    return null;
  }

  todos() {}

  turnDone(info: { seconds: number; status: string; stopped: boolean }) {
    if (info.stopped) write(c.yellow("[stopped]\n"));
    if (info.status) write(c.gray(info.status) + "\n");
  }
}
