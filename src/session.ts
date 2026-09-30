import fs from "node:fs";
import path from "node:path";
import type { Message } from "./client.js";
import { HOME } from "./config.js";

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

export function saveSession(s: Session): void {
  if (s.messages.length < 2) return;
  s.updated = new Date().toISOString();
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, `${s.id}.json`), JSON.stringify(s));
}

/** Sessions for this directory, newest first. */
export function listSessions(cwd: string): Session[] {
  let files: string[];
  try {
    files = fs.readdirSync(DIR).filter((f) => f.endsWith(".json"));
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
  const t = m ? String(m.content).replace(/\s+/g, " ").trim() : "(empty)";
  return t.length > 70 ? t.slice(0, 70) + "…" : t;
}
