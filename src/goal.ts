// jcoder — a coding agent for a local LLM server
// Copyright (C) 2026 Jason Roughley
// SPDX-License-Identifier: GPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option)
// any later version. It is distributed WITHOUT ANY WARRANTY; see the LICENSE
// file for details.

import { spawn } from "node:child_process";

/**
 * /goal: a condition to work towards. After each turn it's checked, by a
 * shell command when one was given (exit 0 = met) or else by asking the
 * model to judge the conversation; until it's met jcoder starts the next
 * turn itself.
 */
export interface Goal {
  text: string;
  /** A shell command whose exit status decides instead of the model. */
  check?: string;
  /** Turns checked so far. */
  turns: number;
  /** Turns in a row with no tool call: the model is saying it's done, or stuck. */
  idle: number;
  /** The last check's "what's missing". */
  last?: string;
}

/** Turns in a row without a tool call before the goal is dropped as stuck. */
export const IDLE_LIMIT = 2;

/** `<condition> [--check <command>]`, the command optionally quoted. */
export function parseGoal(arg: string): { text: string; check?: string } | { error: string } {
  const m = /(?:^|\s)--check(?:(?:\s+|=)(.*))?$/s.exec(arg);
  const text = (m ? arg.slice(0, m.index) : arg).trim();
  let check = m?.[1]?.trim();
  if (check && /^(["']).*\1$/s.test(check)) check = check.slice(1, -1).trim();
  if (m && !check) return { error: "--check needs a command, e.g. /goal tests pass --check npm test" };
  if (!text && !check) return { error: "Usage: /goal <condition> [--check <command>]" };
  return { text: text || `\`${check}\` succeeds`, check };
}

/** The first message of a goal started from an idle prompt. */
export function startPrompt(g: Goal): string {
  return (
    `Goal: ${g.text}\n\n` +
    `Work until this is fully met. ` +
    (g.check
      ? `It's checked by running \`${g.check}\`: it's met when that exits 0.`
      : `After each of your turns it's checked against the evidence in the conversation (tool results, test output), not against what you say.`) +
    ` If it can't be done, say exactly why.`
  );
}

/** Asked of the model after a turn, without tools; kept out of the history. */
export function verdictPrompt(g: Goal): string {
  return (
    `[A goal check, not a message from the user. Don't call tools; your work carries on afterwards.]\n\n` +
    `The goal: ${g.text}\n\n` +
    `Judge from the evidence in this conversation: tool results, command and test output, files read back. ` +
    `Not from plans, or from claims that something was done without output that shows it. ` +
    `Is the goal fully met, with nothing left to do?\n\n` +
    `Answer MET or NOT MET on the first line. Then one or two lines: what shows it's met, or exactly what's still missing.`
  );
}

/** The model's answer to verdictPrompt. Anything unclear counts as not met. */
export function parseVerdict(reply: string): { met: boolean; reason: string } {
  const lines = reply.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  // Markdown off, but not an identifier's underscores (write_file).
  const first = (lines[0] ?? "").replace(/[*#`>]|\b__|__\b/g, "").trim();
  const head = /^(?:verdict\s*:?\s*)?(NOT[\s_-]*MET|MET)\b[\s.:\-—–]*(.*)$/i.exec(first);
  let met: boolean;
  let rest: string;
  if (head) {
    met = !/^NOT/i.test(head[1]);
    rest = [head[2], ...lines.slice(1)].filter(Boolean).join(" ");
  } else {
    // No verdict up front: take one from anywhere, "not met" winning.
    const all = reply.replace(/[*#`]/g, "");
    met = !/\bNOT[\s_-]*MET\b/i.test(all) && /\bMET\b/.test(all);
    rest = lines.join(" ");
  }
  rest = rest.replace(/\*\*|`/g, "").trim();
  if (rest.length > 400) rest = rest.slice(0, 399) + "…";
  return { met, reason: rest || (met ? "the model judged it met" : "the model gave no reason") };
}

/** The message that starts the next turn while the goal isn't met. */
export function continuePrompt(g: Goal, reason: string): string {
  return `[Goal not met yet: ${reason}]\n\nKeep working towards the goal: ${g.text}`;
}

/** Runs the goal's check command: exit 0 is met; otherwise the end of its output says why. */
export function runCheck(command: string, cwd: string, timeoutSecs: number, signal: AbortSignal): Promise<{ met: boolean; reason: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    let out = "";
    const take = (b: Buffer) => {
      out += b.toString();
      if (out.length > 200_000) out = out.slice(-100_000);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    let why = "";
    const kill = (reason: string) => {
      why = reason;
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {}
    };
    const timer = setTimeout(() => kill(`timed out after ${timeoutSecs}s`), timeoutSecs * 1000);
    const onAbort = () => kill("stopped");
    signal.addEventListener("abort", onAbort);
    const done = (code: number | null, err?: Error) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (code === 0 && !why) return resolve({ met: true, reason: `\`${command}\` exited 0` });
      const tail = out.trim().split("\n").slice(-30).join("\n").slice(-2000);
      const status = err ? `failed to start (${err.message})` : why || `exited ${code ?? "on a signal"}`;
      resolve({ met: false, reason: `\`${command}\` ${status}${tail ? `:\n${tail}` : ""}` });
    };
    child.on("error", (e) => done(null, e));
    child.on("close", (code) => done(code));
  });
}
