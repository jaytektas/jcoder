// jcoder — a coding agent for a local LLM server
// Copyright (C) 2026 Jason Roughley
// SPDX-License-Identifier: GPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option)
// any later version. It is distributed WITHOUT ANY WARRANTY; see the LICENSE
// file for details.

/**
 * The terminal side of the app-drawn ("fullscreen") screen: mouse reports
 * filtered out of the keyboard input, mouse reporting on and off, the
 * clipboard, and cutting ANSI-coloured lines by column for selection.
 */
import { spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";

export interface Mouse {
  kind: "press" | "release" | "drag" | "move" | "wheel";
  /** 0 left, 1 middle, 2 right; wheel: -1 up, 1 down. */
  button: number;
  /** 0-based cell. */
  x: number;
  y: number;
}

// Clicks, drags and the wheel, in the SGR format (any size of terminal).
const MOUSE_ON = "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h";
const MOUSE_OFF = "\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l";
const SGR = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

let restored = false;
/** Mouse reporting off, the normal screen back. Safe to call more than once. */
export function restoreTerminal() {
  if (restored) return;
  restored = true;
  try {
    process.stdout.write(MOUSE_OFF + "\x1b[?1049l\x1b[?25h");
  } catch {}
}

/**
 * The keyboard input Ink reads, with mouse reports taken out and handed to
 * `onMouse`. Also turns mouse reporting on, and off again however jcoder ends.
 */
export function mouseStdin(onMouse: (m: Mouse) => void): NodeJS.ReadStream {
  const real = process.stdin;
  const out = new PassThrough({ encoding: "utf8" }) as unknown as NodeJS.ReadStream & PassThrough;
  let held = "";
  const onData = (chunk: Buffer | string) => {
    let s = held + chunk.toString();
    held = "";
    // A report cut off at the end of the chunk waits for the rest.
    const tail = /\x1b(\[(<[\d;]*)?)?$/.exec(s);
    if (tail && tail[0].length > 1) {
      held = tail[0];
      s = s.slice(0, tail.index);
    }
    const keys = s.replace(SGR, (_, b: string, x: string, y: string, end: string) => {
      const code = Number(b);
      const m: Mouse = { kind: "press", button: code & 3, x: Number(x) - 1, y: Number(y) - 1 };
      if (code & 64) Object.assign(m, { kind: "wheel", button: code & 1 ? 1 : -1 });
      else if (code & 32) m.kind = (code & 3) === 3 ? "move" : "drag";
      else if (end === "m") m.kind = "release";
      onMouse(m);
      return "";
    });
    if (keys) out.write(keys);
  };
  real.on("data", onData);
  Object.assign(out, {
    isTTY: real.isTTY,
    setRawMode: (mode: boolean) => {
      real.setRawMode?.(mode);
      return out;
    },
    ref: () => (real.ref(), out),
    unref: () => (real.unref(), out),
  });
  process.stdout.write(MOUSE_ON);
  process.on("exit", restoreTerminal);
  for (const sig of ["SIGTERM", "SIGHUP"] as const)
    process.on(sig, () => {
      restoreTerminal();
      process.exit(128 + (sig === "SIGTERM" ? 15 : 1));
    });
  process.on("uncaughtException", (e) => {
    restoreTerminal();
    console.error(e);
    process.exit(1);
  });
  return out;
}

/** Puts text on the clipboard: wl-copy, xclip or xsel, else the terminal (OSC 52). */
export function copyToClipboard(text: string): boolean {
  const tries: [string, string[]][] = process.env.WAYLAND_DISPLAY
    ? [["wl-copy", []], ["xclip", ["-selection", "clipboard"]], ["xsel", ["-b", "-i"]]]
    : [["xclip", ["-selection", "clipboard"]], ["xsel", ["-b", "-i"]], ["wl-copy", []]];
  for (const [cmd, args] of tries) {
    const r = spawnSync(cmd, args, { input: text, stdio: ["pipe", "ignore", "ignore"], timeout: 2000 });
    if (!r.error && r.status === 0) return true;
  }
  try {
    process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
    return true;
  } catch {
    return false;
  }
}

const ANSI = /\x1b\[[0-9;]*m/g;
export const stripAnsi = (s: string) => s.replace(ANSI, "");

/** A coloured line with columns [from, to) shown reversed (selected). */
export function invertColumns(line: string, from: number, to: number): string {
  const plain = [...stripAnsi(line)];
  if (from >= to || from >= plain.length) return line;
  const a = plain.slice(0, from).join("");
  const b = plain.slice(from, to).join("");
  const c = plain.slice(to).join("");
  return `${a}\x1b[7m${b}\x1b[27m${c}`;
}
