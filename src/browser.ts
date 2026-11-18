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
 * jcoder in Chrome: the bridge between the browser tool and the jcoder
 * Chrome extension. jcoder listens on a local port; the extension connects
 * to it and runs the actions in jcoder's own tab group, through the
 * DevTools protocol. See extension/ for the other side.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { wsServer, type WsConnection } from "./ws.js";
import type { Content } from "./client.js";

/** Where the extension is, to load unpacked. */
export const EXTENSION_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "extension");
/** Ports tried from the one set: the extension looks through the same range, so several jcoders can share one browser. */
export const PORT_RANGE = 10;
const PROTOCOL = 1;

interface Browser {
  ws: WsConnection;
  name: string;
  version: string;
  since: number;
}

interface Reply {
  text?: string;
  image?: string;
  error?: boolean;
  host?: string;
}

const isLoopback = (h: string) => h === "localhost" || h === "::1" || h.startsWith("127.");

export function parseListen(listen: string): { host: string; port: number } {
  const m = /^(?:\[?([^\]]*)\]?:)?(\d+)$/.exec(listen.trim());
  return { host: m?.[1] || "127.0.0.1", port: m ? Number(m[2]) : 47823 };
}

class Bridge {
  private server?: http.Server;
  private browsers: Browser[] = [];
  private pending = new Map<number, (r: Reply) => void>();
  private nextId = 1;
  private waiters: (() => void)[] = [];
  private pinger?: NodeJS.Timeout;
  /** Lets the extension keep this session's tab group across reconnects. */
  readonly session = crypto.randomUUID();
  address = "";
  error = "";
  label = "jcoder";

  get running(): boolean {
    return !!this.server;
  }

  get connected(): Browser[] {
    return this.browsers;
  }

  /** Listens on the first free port from `listen`'s. Resolves with the address, or throws. */
  async start(listen: string, token: string, label: string): Promise<string> {
    this.label = label;
    if (this.server) return this.address;
    const { host, port } = parseListen(listen);
    if (!isLoopback(host) && !token)
      throw new Error(`browserListen is ${listen}, open to the network: set browserToken too (the same in the extension), or tunnel the port over ssh instead`);
    const allow = (req: http.IncomingMessage) => {
      // Web pages can open sockets to localhost too; only an extension may.
      const origin = String(req.headers.origin ?? "");
      if (!origin.startsWith("chrome-extension://")) return "only the jcoder extension may connect";
      if (token) {
        const got = new URL(req.url ?? "/", "http://x").searchParams.get("token") ?? "";
        const a = Buffer.from(got), b = Buffer.from(token);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return "wrong token: set the same token as browserToken in the extension";
      }
      return null;
    };
    const server = wsServer(allow, (ws) => this.connection(ws));
    let lastErr: any;
    for (let p = port; p < port + PORT_RANGE; p++) {
      try {
        await new Promise<void>((ok, fail) => {
          server.once("error", fail);
          server.listen(p, host, () => {
            server.off("error", fail);
            ok();
          });
        });
        this.server = server;
        this.address = `${host.includes(":") ? `[${host}]` : host}:${p}`;
        this.error = "";
        // The extension's service worker is put to sleep after 30s without traffic.
        this.pinger = setInterval(() => this.browsers.forEach((b) => b.ws.send('{"type":"ping"}')), 20_000);
        this.pinger.unref();
        server.unref();
        return this.address;
      } catch (e: any) {
        lastErr = e;
        if (e.code !== "EADDRINUSE") break;
      }
    }
    this.error = lastErr?.code === "EADDRINUSE" ? `ports ${port}-${port + PORT_RANGE - 1} are all in use` : String(lastErr?.message ?? lastErr);
    throw new Error(this.error);
  }

  stop(): void {
    clearInterval(this.pinger);
    for (const b of this.browsers) b.ws.close();
    this.browsers = [];
    this.server?.close();
    this.server = undefined;
    this.address = "";
  }

  private connection(ws: WsConnection) {
    let browser: Browser | undefined;
    const hello = setTimeout(() => browser || ws.close(), 5000);
    ws.onmessage = (text) => {
      let m: any;
      try {
        m = JSON.parse(text);
      } catch {
        return;
      }
      if (m.type === "hello") {
        clearTimeout(hello);
        browser = { ws, name: String(m.browser ?? "Chrome"), version: String(m.version ?? "?"), since: Date.now() };
        // Newest first: the browser the user most recently opened is the one to drive.
        this.browsers.unshift(browser);
        ws.send(JSON.stringify({ type: "welcome", protocol: PROTOCOL, session: this.session, name: this.label }));
        this.waiters.splice(0).forEach((w) => w());
      } else if (m.type === "result" && typeof m.id === "number") {
        this.pending.get(m.id)?.(m);
        this.pending.delete(m.id);
      }
    };
    ws.onclose = () => {
      clearTimeout(hello);
      this.browsers = this.browsers.filter((b) => b.ws !== ws);
    };
  }

  /** A browser to talk to, waiting up to `ms` for one to connect (the extension retries every few seconds, or 30 when asleep). */
  private async browser(ms: number, signal: AbortSignal): Promise<Browser | null> {
    const end = Date.now() + ms;
    while (!this.browsers.length && Date.now() < end && !signal.aborted) {
      await new Promise<void>((ok) => {
        const done = () => (clearTimeout(t), signal.removeEventListener("abort", done), ok());
        const t = setTimeout(done, Math.min(1000, end - Date.now()));
        signal.addEventListener("abort", done);
        this.waiters.push(done);
      });
    }
    return this.browsers[0] ?? null;
  }

  async call(action: string, args: Record<string, unknown>, signal: AbortSignal, timeoutMs = 30_000): Promise<Reply> {
    const b = await this.browser(35_000, signal);
    if (signal.aborted) return { text: "Stopped.", error: true };
    if (!b)
      return {
        error: true,
        text:
          `No browser is connected to jcoder (listening on ${this.address}). The user needs the jcoder extension in Chrome: ` +
          "tell them to run /browser for how to set it up, then try again.",
      };
    const id = this.nextId++;
    return new Promise<Reply>((done) => {
      const finish = (r: Reply) => {
        clearTimeout(t);
        signal.removeEventListener("abort", onAbort);
        this.pending.delete(id);
        done(r);
      };
      const t = setTimeout(() => finish({ text: `The browser didn't answer within ${Math.round(timeoutMs / 1000)}s.`, error: true }), timeoutMs);
      const onAbort = () => finish({ text: "Stopped.", error: true });
      signal.addEventListener("abort", onAbort);
      this.pending.set(id, finish);
      b.ws.send(JSON.stringify({ type: "call", id, action, args }));
    });
  }
}

export const bridge = new Bridge();

/** Actions that change a page: asked about once per site in edit mode, refused in read-only. */
const ACTS = new Set(["click", "double_click", "right_click", "type", "key", "drag", "set", "upload", "js", "dialog"]);

export const ACTIONS = [
  "tabs", "new_tab", "close_tab", "navigate", "back", "forward", "reload",
  "read_page", "find", "text", "screenshot", "zoom",
  "click", "double_click", "right_click", "hover", "type", "key", "scroll", "drag", "set", "upload", "dialog",
  "js", "console", "network", "wait", "resize",
];

export interface BrowserContext {
  cwd: string;
  mode: "ro" | "edit" | "auto";
  signal: AbortSignal;
  approve(tool: string, summary: string): Promise<{ ok: boolean; reason?: string }>;
}

/** The one-line summary of a browser call. */
export function browserSummary(a: any): string {
  const act = String(a.action ?? "");
  const target = a.url ?? (a.ref ? `[${a.ref}]` : a.x !== undefined ? `${a.x},${a.y}` : "");
  const text = a.text !== undefined ? JSON.stringify(String(a.text).length > 60 ? String(a.text).slice(0, 60) + "…" : String(a.text)) : "";
  return [act, target, text, a.tab ? `tab ${a.tab}` : ""].filter(Boolean).join(" ");
}

export async function browserAction(a: any, ctx: BrowserContext): Promise<{ content: Content; display?: string; error?: boolean }> {
  const action = String(a.action ?? "");
  if (!ACTIONS.includes(action)) return { content: `Unknown action "${action}". Actions: ${ACTIONS.join(", ")}.`, error: true };
  if (!bridge.running) return { content: `The browser bridge isn't running${bridge.error ? ` (${bridge.error})` : ""}. Tell the user to run /browser.`, error: true };
  const args: Record<string, unknown> = { ...a };
  delete args.action;

  if (ACTS.has(action)) {
    if (ctx.mode === "ro") return { content: `Read-only mode: browser ${action} is not allowed. Tell the user what you would do instead.`, error: true };
    // Asked once per site: where the action would happen.
    const where = await bridge.call("where", { tab: a.tab }, ctx.signal, 10_000);
    if (where.error) return { content: where.text ?? "No tab.", error: true };
    const host = where.host || "this page";
    const ok = await ctx.approve(`browser on ${host}`, browserSummary(a));
    if (!ok.ok) return { content: `User declined.${ok.reason ? ` They said: ${ok.reason}` : ""}`, error: true };
  }

  if (action === "upload") {
    const files = (Array.isArray(a.files) ? a.files : [a.files]).filter(Boolean).map(String);
    if (!files.length) return { content: "upload needs files: paths of the files to give the file input.", error: true };
    const list = [];
    for (const f of files) {
      const abs = path.resolve(ctx.cwd, f.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
      try {
        const buf = fs.readFileSync(abs);
        if (buf.length > 30 << 20) return { content: `${f} is over 30 MB.`, error: true };
        list.push({ name: path.basename(abs), data: buf.toString("base64") });
      } catch (e: any) {
        return { content: e.code === "ENOENT" ? `${f} does not exist.` : e.message, error: true };
      }
    }
    args.files = list;
  }

  const seconds = Math.min(60, Math.max(0, Number(a.seconds) || 0));
  const timeout = action === "wait" ? (seconds || 2) * 1000 + 15_000 : action === "js" ? 45_000 : 30_000;
  const r = await bridge.call(action, args, ctx.signal, timeout);
  const text = r.text ?? "";
  if (r.image)
    return {
      content: [
        { type: "text", text },
        { type: "image_url", image_url: { url: r.image } },
      ],
      display: text.split("\n")[0],
      error: r.error,
    };
  return { content: text || "(nothing)", error: r.error };
}
