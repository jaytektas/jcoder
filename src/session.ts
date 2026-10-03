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
import { textOf, type Content, type Message } from "./client.js";
import { HOME } from "./config.js";
import { restoreImage, storeImage } from "./images.js";

export interface Session {
  id: string;
  cwd: string;
  model: string;
  messages: Message[];
  updated: string;
}

const DIR = path.join(HOME, "sessions");

export function newSession(cwd: string, model: string, system: string): Session {
  const id = new Date().toISOString().replace(/[:.]/g, "-");
  return { id, cwd, model, messages: [{ role: "system", content: system }], updated: "" };
}

/** Images as files under ~/.jcoder/images instead of base64 in the JSON. */
export function storeContent<T extends Content | null>(c: T): T {
  if (!Array.isArray(c)) return c;
  return c.map((p) => (p.type === "image_url" ? { ...p, image_url: { url: storeImage(p.image_url.url) } } : p)) as T;
}

function restoreContent(c: Content | null): Content | null {
  if (!Array.isArray(c)) return c;
  return c.map((p) => {
    if (p.type !== "image_url") return p;
    const url = restoreImage(p.image_url.url);
    return url ? { ...p, image_url: { url } } : { type: "text" as const, text: "[image no longer on disk]" };
  });
}

/** The current conversation, overwritten after every turn; what resume loads. */
export function saveSession(s: Session): void {
  if (s.messages.length < 2) return;
  s.updated = new Date().toISOString();
  const messages = s.messages.map((m) => ({ ...m, content: storeContent(m.content) }));
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, `${s.id}.json`), JSON.stringify({ ...s, messages }));
}

/** Loads a listed session's images back in, ready to send. */
export function openSession(s: Session): Session {
  s.messages = s.messages.map((m) => ({ ...m, content: restoreContent(m.content) }) as Message);
  return s;
}

export const logPath = (s: Session) => path.join(DIR, `${s.id}.log.jsonl`);

/**
 * The full record, one JSON line per event, only ever appended to: every
 * message including the model's thinking, tool calls and results, errors,
 * and what compaction replaced.
 */
export function log(s: Session, event: Record<string, unknown>): void {
  fs.mkdirSync(DIR, { recursive: true });
  fs.appendFileSync(logPath(s), JSON.stringify({ t: new Date().toISOString(), ...event }) + "\n");
}

/** The log's events, oldest first; empty when there's no log. A torn last line is skipped. */
export function readLog(s: Session): Record<string, any>[] {
  let text: string;
  try {
    text = fs.readFileSync(logPath(s), "utf8");
  } catch {
    return [];
  }
  const events: Record<string, any>[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch {}
  }
  return events;
}

/** Sessions for this directory, newest first. */
export function listSessions(cwd: string): Session[] {
  let files: string[];
  try {
    files = fs.readdirSync(DIR).filter((f) => f.endsWith(".json") && !f.endsWith(".log.jsonl"));
  } catch {
    return [];
  }
  const out: Session[] = [];
  for (const f of files) {
    try {
      const s: Session = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
      if (s.cwd === cwd) out.push(s);
    } catch {}
  }
  return out.sort((a, b) => b.updated.localeCompare(a.updated));
}

/** The first thing the user asked, as a one-line title. */
export function title(s: Session): string {
  const m = s.messages.find((m) => m.role === "user");
  const t = m ? textOf(m.content).replace(/\s+/g, " ").trim() : "(empty)";
  return t.length > 70 ? t.slice(0, 70) + "…" : t;
}
