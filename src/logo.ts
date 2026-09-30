// jcoder — a coding agent for a local LLM server
// Copyright (C) 2026 Jason Roughley
// SPDX-License-Identifier: GPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option)
// any later version. It is distributed WITHOUT ANY WARRANTY; see the LICENSE
// file for details.

/** Block letters, 6 rows each: █ is the face, the box-drawing lines its shadow. */
const LETTERS: Record<string, string[]> = {
  J: ["     ██╗", "     ██║", "     ██║", "██   ██║", "╚█████╔╝", " ╚════╝ "],
  A: [" █████╗ ", "██╔══██╗", "███████║", "██╔══██║", "██║  ██║", "╚═╝  ╚═╝"],
  Y: ["██╗   ██╗", "╚██╗ ██╔╝", " ╚████╔╝ ", "  ╚██╔╝  ", "   ██║   ", "   ╚═╝   "],
  T: ["████████╗", "╚══██╔══╝", "   ██║   ", "   ██║   ", "   ██║   ", "   ╚═╝   "],
  E: ["███████╗", "██╔════╝", "█████╗  ", "██╔══╝  ", "███████╗", "╚══════╝"],
  K: ["██╗  ██╗", "██║ ██╔╝", "█████╔╝ ", "██╔═██╗ ", "██║  ██╗", "╚═╝  ╚═╝"],
};

const WORD = "JAYTEK";
const ROWS = Array.from({ length: 6 }, (_, r) => [...WORD].map((ch) => LETTERS[ch][r]).join(""));
export const LOGO_WIDTH = [...ROWS[0]].length;

type RGB = [number, number, number];
// JAYTEK orange (#ff8c28) across to amber; the shadow is a burnt orange.
const FROM: RGB = [255, 110, 30];
const TO: RGB = [255, 200, 60];
const SHADOW: RGB = [150, 60, 20];

const mix = (a: RGB, b: RGB, t: number): RGB => [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t)) as RGB;

const truecolor = /truecolor|24bit/i.test(process.env.COLORTERM ?? "");
function fg([r, g, b]: RGB): string {
  if (truecolor) return `\x1b[38;2;${r};${g};${b}m`;
  // 256-colour cube.
  const c = (v: number) => Math.round((v / 255) * 5);
  return `\x1b[38;5;${16 + 36 * c(r) + 6 * c(g) + c(b)}m`;
}

/** The logo in colour, or null if it won't fit in `columns`. */
export function logo(columns: number): string | null {
  if (columns < LOGO_WIDTH + 2) return null;
  return ROWS.map((row) => {
    const chars = [...row];
    let out = "";
    let last = "";
    chars.forEach((ch, i) => {
      if (ch === " ") {
        out += ch;
        return;
      }
      const t = i / (chars.length - 1);
      const colour = fg(ch === "█" ? mix(FROM, TO, t) : mix(SHADOW, mix(SHADOW, FROM, 0.35), t));
      if (colour !== last) out += colour;
      last = colour;
      out += ch;
    });
    return out + "\x1b[39m";
  }).join("\n");
}
