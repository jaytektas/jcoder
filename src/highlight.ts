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
 * Syntax colours for one line of code, without knowing the language
 * properly: comments, strings, numbers, keywords and capitalised names. Good
 * enough to read a diff or a code block at a glance. Only the foreground is
 * set and reset (39), so a background behind it (a diff's red or green) stays.
 */
const E = "\x1b[";
const fg = (n: number) => (s: string) => `${E}38;5;${n}m${s}${E}39m`;
const KEYWORD = fg(176);
const STRING = fg(150);
const NUMBER = fg(215);
const COMMENT = (s: string) => `${E}38;5;245m${E}3m${s}${E}23m${E}39m`;
const TYPE = fg(117);
const KEY = fg(110);

const KEYWORDS = new Set(
  (
    "abstract as async await break case catch class const continue def default defer del delete do elif else enum " +
    "export extends final finally fn for foreach from func function go goto if impl implements import in instanceof " +
    "interface is lambda let loop match mod module mut namespace new nonlocal not or and package pass private " +
    "protected pub public raise readonly return static struct super switch synchronized this throw throws trait try " +
    "type typedef typeof union unsafe use using var void volatile where while with yield " +
    "true false null None True False nil undefined self NULL nullptr"
  ).split(" "),
);

const HASH_COMMENTS = new Set(["py", "python", "sh", "bash", "shell", "zsh", "console", "rb", "ruby", "perl", "yaml", "yml", "toml", "conf", "ini", "cmake", "makefile", "mk", "r", "pl", "dockerfile"]);

/** The language from a fence tag (```ts) or a file name, lower-case. */
export function langOf(nameOrTag: string): string {
  const base = nameOrTag.trim().toLowerCase().split("/").pop() ?? "";
  if (base === "makefile" || base === "dockerfile") return base;
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1) : base;
}

const TOKEN = /(\/\/.*$|\/\*.*?(?:\*\/|$)|#.*$|--.*$)|("(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|`(?:\\.|[^`\\])*`?)|(\b0x[0-9a-fA-F_]+\b|\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?[a-zA-Z]*\b)|([A-Za-z_$][\w$]*)/g;

export function highlightLine(line: string, lang: string): string {
  if (lang === "diff" || lang === "text" || lang === "txt" || lang === "md" || lang === "markdown" || lang === "") return line;
  const hash = HASH_COMMENTS.has(lang);
  const sql = lang === "sql" || lang === "lua";
  const json = lang === "json" || lang === "jsonc";
  return line.replace(TOKEN, (m, comment: string, str: string, num: string, word: string, at: number) => {
    if (comment) {
      // Each style of comment only in the languages that use it; elsewhere
      // # and -- are ordinary characters (a CSS colour, a decrement).
      const isComment = comment.startsWith("#") ? hash : comment.startsWith("--") ? sql : !hash;
      if (isComment) return COMMENT(m);
      const n = comment.startsWith("/*") ? 1 : comment.startsWith("#") ? 1 : 2;
      return m.slice(0, n) + highlightLine(m.slice(n), lang);
    }
    if (str) return json && /^\s*:/.test(line.slice(at + m.length)) ? KEY(m) : STRING(m);
    if (num) return NUMBER(m);
    if (word) {
      if (KEYWORDS.has(word)) return KEYWORD(m);
      if (/^[A-Z][a-z0-9]/.test(word)) return TYPE(m);
    }
    return m;
  });
}

export function highlight(code: string, lang: string): string {
  return code
    .split("\n")
    .map((l) => highlightLine(l, lang))
    .join("\n");
}
