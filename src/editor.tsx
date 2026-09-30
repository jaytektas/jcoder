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
import { Box, Text, useInput, usePaste } from "ink";
import { useMemo, useState, type ReactNode } from "react";
import { matchCommands, matchFiles, tokenAt } from "./complete.js";
import { HOME } from "./config.js";

const HISTORY_FILE = path.join(HOME, "history.jsonl");
const history: string[] = (() => {
  try {
    return fs
      .readFileSync(HISTORY_FILE, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .slice(-500)
      .reverse();
  } catch {
    return [];
  }
})();

function remember(text: string) {
  if (history[0] === text) return;
  history.unshift(text);
  try {
    fs.mkdirSync(HOME, { recursive: true });
    fs.appendFileSync(HISTORY_FILE, JSON.stringify(text) + "\n");
  } catch {}
}

interface Suggestion {
  label: string;
  desc?: string;
  /** Replaces the token under the cursor. */
  insert: string;
  /** Enter on it submits straight away (commands without arguments). */
  submit?: boolean;
}

export interface EditorProps {
  active: boolean;
  cwd: string;
  prompt?: string;
  placeholder?: string;
  /** Returns false to keep the text (nothing was sent). */
  onSubmit(text: string): boolean | void;
  /** Ctrl+V: text to insert, e.g. "[image #1]", or null. */
  onCtrlV?(): string | null;
  /** Ctrl+C with nothing typed. */
  onCtrlCEmpty?(): void;
  /** Ctrl+D with nothing typed. */
  onExit?(): void;
  /** Esc with no popup open. */
  onEscape?(): void;
  /** Up on the first line: text to take back into the input (queued messages), or null for history. */
  onRecall?(): string | null;
  /** Keep typed text in the history file. */
  keepHistory?: boolean;
}

const BIG_PASTE_LINES = 8;
const BIG_PASTE_CHARS = 1500;

export function Editor(p: EditorProps) {
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [sel, setSel] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [histIdx, setHistIdx] = useState(-1);
  const [draft, setDraft] = useState("");
  const [pastes] = useState(() => new Map<string, string>());

  const set = (v: string, c: number) => {
    setValue(v);
    setCursor(Math.max(0, Math.min(v.length, c)));
    setSel(0);
  };
  const insert = (s: string) => set(value.slice(0, cursor) + s + value.slice(cursor), cursor + s.length);

  const token = tokenAt(value, cursor);
  const suggestions: Suggestion[] = useMemo(() => {
    if (!token || dismissed === value) return [];
    if (token.kind === "/")
      return matchCommands(token.query).map((c) => ({
        label: `/${c.name}${c.args ? " " + c.args : ""}`,
        desc: c.desc,
        insert: `/${c.name}${c.args ? " " : ""}`,
        submit: !c.args,
      }));
    return matchFiles(p.cwd, token.query).map((f) => ({
      label: `@${f}`,
      insert: `@${f.replace(/ /g, "\\ ")}${f.endsWith("/") ? "" : " "}`,
    }));
  }, [value, cursor, dismissed, p.cwd]);
  const open = suggestions.length > 0 && p.active;

  const accept = (s: Suggestion): string => {
    const v = value.slice(0, token!.start) + s.insert + value.slice(cursor);
    set(v, token!.start + s.insert.length);
    return v;
  };

  const submit = (raw: string) => {
    let text = raw;
    for (const [marker, full] of pastes) text = text.split(marker).join(full);
    if (!text.trim()) return;
    if (p.onSubmit(text) === false) return;
    if (p.keepHistory !== false) remember(raw.includes("[Pasted text #") ? text : raw);
    pastes.clear();
    setHistIdx(-1);
    set("", 0);
  };

  const lineStart = (c: number) => value.lastIndexOf("\n", c - 1) + 1;
  const lineEnd = (c: number) => {
    const i = value.indexOf("\n", c);
    return i < 0 ? value.length : i;
  };
  const wordLeft = (c: number) => {
    let i = c;
    while (i > 0 && /\s/.test(value[i - 1])) i--;
    while (i > 0 && !/\s/.test(value[i - 1])) i--;
    return i;
  };
  const wordRight = (c: number) => {
    let i = c;
    while (i < value.length && /\s/.test(value[i])) i++;
    while (i < value.length && !/\s/.test(value[i])) i++;
    return i;
  };

  usePaste(
    (text) => {
      text = text.replace(/\r\n?/g, "\n");
      const lines = text.split("\n").length;
      if (lines > BIG_PASTE_LINES || text.length > BIG_PASTE_CHARS) {
        const marker = `[Pasted text #${pastes.size + 1} +${lines} lines]`;
        pastes.set(marker, text);
        insert(marker);
      } else insert(text);
    },
    { isActive: p.active },
  );

  useInput(
    (input, key) => {
      if (key.return) {
        if (key.meta || key.shift) return insert("\n");
        if (value[cursor - 1] === "\\") return set(value.slice(0, cursor - 1) + "\n" + value.slice(cursor), cursor);
        if (open) {
          const s = suggestions[Math.min(sel, suggestions.length - 1)];
          const v = accept(s);
          if (s.submit) submit(v.trim());
          return;
        }
        return submit(value);
      }
      if (key.tab) {
        if (key.shift) return; // the app cycles the mode
        if (open) accept(suggestions[Math.min(sel, suggestions.length - 1)]);
        return;
      }
      if (key.escape) {
        if (open) return setDismissed(value);
        return p.onEscape?.();
      }
      if (key.upArrow) {
        if (open) return setSel((sel - 1 + suggestions.length) % suggestions.length);
        if (value.lastIndexOf("\n", cursor - 1) >= 0) {
          // Up a line, same column.
          const ls = lineStart(cursor);
          const prevStart = lineStart(ls - 1);
          return setCursor(Math.min(prevStart + (cursor - ls), ls - 1));
        }
        const recalled = p.onRecall?.();
        if (recalled) {
          const v = value ? `${recalled}\n${value}` : recalled;
          return set(v, v.length);
        }
        if (histIdx + 1 < history.length) {
          if (histIdx === -1) setDraft(value);
          const h = history[histIdx + 1];
          setHistIdx(histIdx + 1);
          set(h, h.length);
        }
        return;
      }
      if (key.downArrow) {
        if (open) return setSel((sel + 1) % suggestions.length);
        if (value.indexOf("\n", cursor) >= 0) {
          const ls = lineStart(cursor);
          const nextStart = lineEnd(cursor) + 1;
          return setCursor(Math.min(nextStart + (cursor - ls), lineEnd(nextStart)));
        }
        if (histIdx >= 0) {
          const h = histIdx === 0 ? draft : history[histIdx - 1];
          setHistIdx(histIdx - 1);
          set(h, h.length);
        }
        return;
      }
      if (key.leftArrow) return setCursor(key.ctrl || key.meta ? wordLeft(cursor) : Math.max(0, cursor - 1));
      if (key.rightArrow) return setCursor(key.ctrl || key.meta ? wordRight(cursor) : Math.min(value.length, cursor + 1));
      if (key.home) return setCursor(lineStart(cursor));
      if (key.end) return setCursor(lineEnd(cursor));
      if (key.backspace) {
        if (key.meta || key.ctrl) {
          const w = wordLeft(cursor);
          return set(value.slice(0, w) + value.slice(cursor), w);
        }
        if (cursor === 0) return;
        return set(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
      }
      if (key.delete) {
        if (cursor >= value.length) return;
        return set(value.slice(0, cursor) + value.slice(cursor + 1), cursor);
      }
      if (key.ctrl) {
        switch (input) {
          case "a":
            return setCursor(lineStart(cursor));
          case "e":
            return setCursor(lineEnd(cursor));
          case "u":
            return set(value.slice(0, lineStart(cursor)) + value.slice(cursor), lineStart(cursor));
          case "k":
            return set(value.slice(0, cursor) + value.slice(lineEnd(cursor)), cursor);
          case "w": {
            const w = wordLeft(cursor);
            return set(value.slice(0, w) + value.slice(cursor), w);
          }
          case "v": {
            const t = p.onCtrlV?.();
            if (t) insert(t);
            return;
          }
          case "c":
            if (value) {
              pastes.clear();
              return set("", 0);
            }
            return p.onCtrlCEmpty?.();
          case "d":
            if (!value) p.onExit?.();
            return;
          case "j":
            return insert("\n");
        }
        return;
      }
      if (key.meta && (input === "b" || input === "f")) return setCursor(input === "b" ? wordLeft(cursor) : wordRight(cursor));
      if (input && !key.meta) {
        // Typed fast (or pasted without bracketed paste), text and Enter can
        // arrive together: "\r" at the end submits, inside it is a newline.
        const submitAfter = input.length > 1 && input.endsWith("\r") && !input.slice(0, -1).includes("\r");
        const body = submitAfter ? input.slice(0, -1) : input;
        const clean = body.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
        if (submitAfter) return submit(value.slice(0, cursor) + clean + value.slice(cursor));
        if (clean) insert(clean);
      }
    },
    { isActive: p.active },
  );

  // Render the text with a block cursor.
  const lines = value.split("\n");
  let pos = 0;
  const rows = lines.map((line, i) => {
    const start = pos;
    pos += line.length + 1;
    const prefix = i === 0 ? (p.prompt ?? "❯ ") : "  ";
    const hasCursor = p.active && cursor >= start && cursor <= start + line.length;
    let body: ReactNode = line;
    if (hasCursor) {
      const col = cursor - start;
      body = (
        <>
          {line.slice(0, col)}
          <Text inverse>{line[col] ?? " "}</Text>
          {line.slice(col + 1)}
        </>
      );
    } else if (!value && i === 0 && p.placeholder) {
      body = <Text color="gray">{p.placeholder}</Text>;
    }
    return (
      <Box key={i}>
        <Text color={i === 0 ? "gray" : undefined}>{prefix}</Text>
        <Text wrap="wrap">{body}</Text>
      </Box>
    );
  });
  if (!value && p.active && p.placeholder) {
    rows[0] = (
      <Box key={0}>
        <Text color="gray">{p.prompt ?? "❯ "}</Text>
        <Text inverse> </Text>
        <Text color="gray">{p.placeholder}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" borderStyle="single" borderLeft={false} borderRight={false} borderColor="gray">
        {rows}
      </Box>
      {open && (
        <Box flexDirection="column" paddingLeft={2}>
          {suggestions.map((s, i) => {
            const on = i === Math.min(sel, suggestions.length - 1);
            return (
              <Box key={s.label}>
                <Text color={on ? "cyan" : undefined} bold={on}>
                  {s.label.padEnd(token?.kind === "/" ? 22 : 0)}
                </Text>
                {s.desc && <Text color="gray"> {s.desc}</Text>}
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}
