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
 * Just enough markdown for terminal replies: headings, lists, quotes, code
 * blocks, **bold**, *italic*, `code`. Returns ANSI-styled text.
 */
const E = "\x1b[";
const bold = (s: string) => `${E}1m${s}${E}22m`;
const italic = (s: string) => `${E}3m${s}${E}23m`;
const code = (s: string) => `${E}38;5;147m${s}${E}39m`; // soft lavender
const dim = (s: string) => `${E}2m${s}${E}22m`;
const block = (s: string) => `${E}38;5;180m${s}${E}39m`;

function inline(s: string): string {
  // Code spans first, so their contents aren't styled further.
  const spans: string[] = [];
  s = s.replace(/`([^`\n]+)`/g, (_, t) => {
    spans.push(code(t));
    return `\u0000${spans.length - 1}\u0000`;
  });
  s = s
    .replace(/\*\*([^*\n]+)\*\*/g, (_, t) => bold(t))
    .replace(/__([^_\n]+)__/g, (_, t) => bold(t))
    .replace(/(^|[^\w*])\*([^*\s][^*\n]*?)\*(?!\w)/g, (_, pre, t) => pre + italic(t))
    .replace(/(^|[^\w])_([^_\s][^_\n]*?)_(?!\w)/g, (_, pre, t) => pre + italic(t))
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, t, url) => `${t} ${dim(`(${url})`)}`);
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => spans[Number(i)]);
}

/**
 * Renders complete lines. Pass the code-block state from the previous call
 * when rendering a stream piece by piece; the new state comes back.
 */
export function renderLines(text: string, inCode = false): [string, boolean] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(block("  " + line));
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) out.push(bold(inline(m[2])));
    else if ((m = /^(\s*)[-*+]\s+(.*)$/.exec(line))) out.push(`${m[1]}• ${inline(m[2])}`);
    else if ((m = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line))) out.push(`${m[1]}${m[2]}. ${inline(m[3])}`);
    else if ((m = /^>\s?(.*)$/.exec(line))) out.push(dim("│ ") + italic(inline(m[1])));
    else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) out.push(dim("─".repeat(40)));
    else out.push(inline(line));
  }
  return [out.join("\n"), inCode];
}

export const renderMarkdown = (text: string) => renderLines(text)[0];
