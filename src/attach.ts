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
import { textOf } from "./client.js";
import { imagePathsIn, isImagePath, kb, loadImage, type Image } from "./images.js";
import { TOOLS, type ToolContext } from "./tools.js";

export interface Prepared {
  /** The message with @file contents appended. */
  text: string;
  images: Image[];
  /** One line per attachment, for the screen. */
  notes: string[];
  errors: string[];
}

const MENTION = /(^|\s)@((?:[^\s\\]|\\.)+)/g;

/**
 * Turns what the user typed into what the model gets: pasted images whose
 * [image #n] marker is still there, image files named in the text, and @paths
 * — a text file's numbered lines (as read_file would give them, so the model
 * can edit it straight away), a directory's listing, or an image.
 */
export async function prepare(line: string, pasted: Image[], ctx: ToolContext): Promise<Prepared> {
  const out: Prepared = { text: line, images: [], notes: [], errors: [] };
  pasted.forEach((img, i) => {
    if (!line.includes(`[image #${i + 1}]`)) return;
    out.images.push(img);
    out.notes.push(`[image #${i + 1}] ${kb(img.bytes)}`);
  });

  const blocks: string[] = [];
  const done = new Set<string>();
  for (const m of line.matchAll(MENTION)) {
    const raw = m[2].replace(/\\(.)/g, "$1").replace(/[.,;:!?)]+$/, "");
    const abs = path.resolve(ctx.cwd, raw.replace(/^~(?=\/)/, process.env.HOME ?? "~"));
    if (done.has(abs) || !fs.existsSync(abs)) continue;
    done.add(abs);
    const rel = path.relative(ctx.cwd, abs) || ".";
    try {
      if (fs.statSync(abs).isDirectory()) {
        const entries = fs
          .readdirSync(abs, { withFileTypes: true })
          .filter((e) => e.name !== ".git" && e.name !== "node_modules")
          .map((e) => e.name + (e.isDirectory() ? "/" : ""))
          .sort();
        const shown = entries.slice(0, 300);
        blocks.push(`<directory path="${rel}">\n${shown.join("\n")}${entries.length > 300 ? `\n(${entries.length} entries, first 300 shown)` : ""}\n</directory>`);
        out.notes.push(`@${rel}/ (${entries.length} entries)`);
      } else if (isImagePath(abs)) {
        const img = loadImage(abs);
        out.images.push(img);
        out.notes.push(`@${rel} ${kb(img.bytes)}`);
      } else {
        const r = await TOOLS.read_file.run({ path: abs }, ctx);
        if (r.error) {
          out.errors.push(`@${rel}: ${textOf(r.content)}`);
          continue;
        }
        blocks.push(`<file path="${rel}">\n${textOf(r.content)}\n</file>`);
        out.notes.push(`@${rel} (${r.display ?? "read"})`);
      }
    } catch (e: any) {
      out.errors.push(`@${rel}: ${e.message}`);
    }
  }

  // Plain image paths (a dragged-in file) that weren't @mentions.
  for (const file of imagePathsIn(line.replace(MENTION, "$1"), ctx.cwd)) {
    if (done.has(file)) continue;
    try {
      const img = loadImage(file);
      out.images.push(img);
      out.notes.push(`${file} ${kb(img.bytes)}`);
    } catch (e: any) {
      out.errors.push(e.message);
    }
  }

  if (blocks.length) out.text += "\n\n" + blocks.join("\n\n");
  return out;
}
