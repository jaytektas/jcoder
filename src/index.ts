#!/usr/bin/env node
// jcoder — a coding agent for a local LLM server
// Copyright (C) 2026 Jason Roughley
// SPDX-License-Identifier: GPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option)
// any later version. It is distributed WITHOUT ANY WARRANTY; see the LICENSE
// file for details.

import { Agent } from "./agent.js";
import { runApp } from "./app.js";
import { prepare } from "./attach.js";
import { listModels, serverContext } from "./client.js";
import { loadConfig, type Config, type Mode } from "./config.js";
import { systemPrompt } from "./prompt.js";
import { listSessions, newSession, openSession } from "./session.js";
import { PlainView } from "./view.js";

const MODES: Mode[] = ["ro", "edit", "auto"];

const USAGE = `jcoder — a coding agent for a local OpenAI-compatible server

  jcoder                 start
  jcoder -c              continue the last conversation in this directory
  jcoder -p "prompt"     run one request and exit
  options: --mode ro|edit|auto  --yolo (= --mode auto)  --model ID  --url http://host:port`;

function parseArgs(argv: string[]) {
  const o: { print?: string; cont: boolean; mode?: Mode; model?: string; url?: string } = { cont: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "-p" || a === "--print") o.print = next();
    else if (a === "-c" || a === "--continue") o.cont = true;
    else if (a === "--mode") {
      const m = next() as Mode;
      if (!MODES.includes(m)) throw new Error(`--mode must be ro, edit or auto`);
      o.mode = m;
    } else if (a === "--yolo") o.mode = "auto";
    else if (a === "--model") o.model = next();
    else if (a === "--url") o.url = next().replace(/\/+$/, "");
    else if (a === "-h" || a === "--help") {
      console.log(USAGE);
      process.exit(0);
    } else throw new Error(`unknown option ${a}\n\n${USAGE}`);
  }
  return o;
}

async function connect(cfg: Config): Promise<number> {
  if (!cfg.model) {
    const models = await listModels(cfg);
    if (!models.length) throw new Error(`${cfg.baseUrl} lists no models`);
    cfg.model = models[0];
  }
  return (await serverContext(cfg)) ?? cfg.contextWindow;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  if (args.url) cfg.baseUrl = args.url;
  if (args.model) cfg.model = args.model;
  if (args.mode) cfg.mode = args.mode;
  const cwd = process.cwd();

  let ctxWindow: number;
  try {
    ctxWindow = await connect(cfg);
  } catch (e: any) {
    console.error(`jcoder: can't reach ${cfg.baseUrl}: ${e.cause?.message ?? e.message}`);
    process.exit(1);
  }

  let session = newSession(cwd, cfg.model, systemPrompt(cwd));
  let resumed = false;
  if (args.cont) {
    const last = listSessions(cwd)[0];
    if (last) {
      session = openSession(last);
      resumed = true;
    } else console.error("no earlier conversation here; starting a new one");
  }

  if (args.print !== undefined) {
    const view = new PlainView();
    const agent = new Agent(cfg, session, ctxWindow, view);
    if (resumed) agent.estimateUsed();
    const prep = await prepare(args.print, [], agent.toolContext(new AbortController().signal));
    for (const e of prep.errors) view.notice(e, "error");
    if (prep.notes.length) view.notice(`attached ${prep.notes.join(", ")}`);
    await agent.turn(prep.text, prep.images);
    return;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("jcoder: needs a terminal; use -p for scripts");
    process.exit(1);
  }
  await runApp(cfg, session, ctxWindow, resumed);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`jcoder: ${e.message}`);
    process.exit(1);
  },
);
