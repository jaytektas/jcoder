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
 * Just enough of a WebSocket server (RFC 6455) for the browser bridge: text
 * frames, fragmentation, ping/pong and close. Node has a WebSocket client
 * built in but no server, and this saves a dependency.
 */

import crypto from "node:crypto";
import http from "node:http";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE = 64 << 20;

export class WsConnection {
  private buf: Buffer = Buffer.alloc(0);
  private parts: Buffer[] = [];
  private closed = false;
  onmessage?: (text: string) => void;
  onclose?: () => void;

  constructor(private socket: Duplex) {
    socket.on("data", (d: Buffer) => this.data(d));
    socket.on("close", () => this.end());
    socket.on("error", () => this.end());
  }

  get open(): boolean {
    return !this.closed;
  }

  send(text: string): void {
    if (this.closed) return;
    this.frame(0x1, Buffer.from(text, "utf8"));
  }

  ping(): void {
    if (!this.closed) this.frame(0x9, Buffer.alloc(0));
  }

  close(): void {
    if (this.closed) return;
    this.frame(0x8, Buffer.from([0x03, 0xe8]));
    this.socket.end();
    this.end();
  }

  private end() {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.onclose?.();
  }

  private frame(op: number, payload: Buffer) {
    const n = payload.length;
    const head = n < 126 ? Buffer.alloc(2) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
    head[0] = 0x80 | op;
    if (n < 126) head[1] = n;
    else if (n < 65536) {
      head[1] = 126;
      head.writeUInt16BE(n, 2);
    } else {
      head[1] = 127;
      head.writeBigUInt64BE(BigInt(n), 2);
    }
    this.socket.write(Buffer.concat([head, payload]));
  }

  private data(d: Buffer) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    for (;;) {
      if (this.buf.length < 2) return;
      const fin = (this.buf[0] & 0x80) !== 0;
      const op = this.buf[0] & 0x0f;
      const masked = (this.buf[1] & 0x80) !== 0;
      let len = this.buf[1] & 0x7f;
      let at = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        at = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        at = 10;
      }
      if (len > MAX_MESSAGE) return this.close();
      const maskAt = at;
      if (masked) at += 4;
      if (this.buf.length < at + len) return;
      const payload = Buffer.from(this.buf.subarray(at, at + len));
      if (masked) for (let i = 0; i < len; i++) payload[i] ^= this.buf[maskAt + (i & 3)];
      this.buf = this.buf.subarray(at + len);
      if (op === 0x8) return this.close();
      if (op === 0x9) {
        this.frame(0xa, payload);
        continue;
      }
      if (op === 0xa) continue;
      // 0x1 text, 0x2 binary, 0x0 a continuation of either.
      this.parts.push(payload);
      if (fin) {
        const text = Buffer.concat(this.parts).toString("utf8");
        this.parts = [];
        this.onmessage?.(text);
      }
    }
  }
}

/**
 * Accepts the upgrade if `allow` says so, and hands over the connection.
 * Anything else gets a 403 or 426.
 */
export function wsServer(
  allow: (req: http.IncomingMessage) => string | null,
  onConnection: (ws: WsConnection, req: http.IncomingMessage) => void,
): http.Server {
  const server = http.createServer((_, res) => {
    res.writeHead(426, { "Content-Type": "text/plain" });
    res.end("jcoder browser bridge: connect with the jcoder Chrome extension.\n");
  });
  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    const refused = typeof key !== "string" ? "not a WebSocket request" : allow(req);
    if (refused) {
      socket.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${refused}\n`);
      return;
    }
    const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    onConnection(new WsConnection(socket), req);
  });
  return server;
}
