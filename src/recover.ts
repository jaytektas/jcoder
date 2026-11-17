// jcoder — Copyright (C) 2026 Jason Roughley — SPDX-License-Identifier: GPL-3.0-or-later
//
// Tool calls that didn't come back as tool calls. A local model now and then
// writes a call the server can't turn into a structured one: a near-miss name
// (`read` for `read_file`), or the call left in the reply as text. The server
// then ends the reply with finish "stop", and the turn used to end there with
// the raw <tool_call> on screen. These helpers recover the call instead.

import type { ToolCall, ToolSchema } from "./client.js";

/** Names models trained on other agents reach for, and the jcoder tool each means. */
const ALIASES: Record<string, string> = {
  read: "read_file", view: "read_file", cat: "read_file", open: "read_file", open_file: "read_file", view_file: "read_file", readfile: "read_file",
  write: "write_file", create: "write_file", create_file: "write_file", writefile: "write_file",
  edit: "edit_file", str_replace: "edit_file", replace: "edit_file", apply_edit: "edit_file", editfile: "edit_file",
  shell: "bash", run: "bash", exec: "bash", execute: "bash", terminal: "bash", run_command: "bash", sh: "bash",
  search: "grep", find: "glob", ls: "glob",
  fetch: "web_fetch", webfetch: "web_fetch", websearch: "web_search",
  todowrite: "todo", todo_write: "todo",
};

/**
 * The offered tool a called name means, or undefined. Exact names win; then a
 * namespace prefix is dropped (`functions.read_file`, `mcp__x__read_file`),
 * case and dashes are ignored, a known alias is mapped, and last a name that
 * starts exactly one tool's name (`read` → `read_file`) is taken. Never guesses
 * between two tools.
 */
export function resolveToolName(name: string, offered: Iterable<string>): string | undefined {
  const names = new Set(offered);
  if (names.has(name)) return name;
  const bare = name.trim().replace(/^.*(?:\.|__|=|:)/, "").toLowerCase().replace(/-/g, "_");
  if (names.has(bare)) return bare;
  const alias = ALIASES[bare] ?? ALIASES[bare.replace(/_/g, "")];
  if (alias && names.has(alias)) return alias;
  const prefixed = [...names].filter((n) => n.startsWith(bare + "_"));
  return prefixed.length === 1 ? prefixed[0] : undefined;
}

/** A parameter's value as its schema types it: the XML call format only has strings. */
function coerce(value: string, type: string | undefined): unknown {
  const v = value.replace(/^\n/, "").replace(/\n$/, "");
  switch (type) {
    case "integer":
    case "number": {
      const n = Number(v.trim());
      return Number.isFinite(n) ? n : v;
    }
    case "boolean":
      return /^true$/i.test(v.trim()) ? true : /^false$/i.test(v.trim()) ? false : v;
    case "array":
    case "object":
      try {
        return JSON.parse(v);
      } catch {
        return v;
      }
    default:
      return v;
  }
}

function propertiesOf(schemas: ToolSchema[], name: string): Record<string, { type?: string }> {
  const s = schemas.find((t) => t.function.name === name);
  return ((s?.function.parameters as any)?.properties ?? {}) as Record<string, { type?: string }>;
}

let seq = 0;
const callId = () => `call_text_${Date.now().toString(36)}_${(seq++).toString(36)}`;

/**
 * Tool calls written into a reply's text, in the Qwen XML form
 * (<tool_call><function=NAME><parameter=K>V</parameter></function></tool_call>)
 * or the Hermes JSON form (<tool_call>{"name": ..., "arguments": {...}}</tool_call>).
 * Only calls whose name resolves to an offered tool are taken. Returns the
 * calls and the text left once they're cut out, or null if there are none.
 */
export function textToolCalls(content: string, schemas: ToolSchema[]): { calls: ToolCall[]; rest: string } | null {
  if (!/<tool_call>|<function=/.test(content)) return null;
  const offered = schemas.map((s) => s.function.name);
  const calls: ToolCall[] = [];
  let rest = content;

  // XML form, with or without the <tool_call> wrapper.
  const xml = /(?:<tool_call>\s*)?<function=([^>\n]+)>([\s\S]*?)<\/function>(?:\s*<\/tool_call>)?/g;
  rest = rest.replace(xml, (whole, rawName: string, body: string) => {
    const name = resolveToolName(rawName.trim(), offered);
    if (!name) return whole;
    const props = propertiesOf(schemas, name);
    const args: Record<string, unknown> = {};
    for (const m of body.matchAll(/<parameter=([^>\n]+)>([\s\S]*?)<\/parameter>/g)) {
      const key = m[1].trim();
      args[key] = coerce(m[2], props[key]?.type);
    }
    calls.push({ id: callId(), type: "function", function: { name, arguments: JSON.stringify(args) } });
    return "";
  });

  // JSON form.
  rest = rest.replace(/<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g, (whole, json: string) => {
    let parsed: any;
    try {
      parsed = JSON.parse(json);
    } catch {
      return whole;
    }
    const name = typeof parsed?.name === "string" ? resolveToolName(parsed.name, offered) : undefined;
    if (!name) return whole;
    let args = parsed.arguments ?? parsed.parameters ?? {};
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        return whole;
      }
    }
    calls.push({ id: callId(), type: "function", function: { name, arguments: JSON.stringify(args) } });
    return "";
  });

  return calls.length ? { calls, rest: rest.trim() } : null;
}
