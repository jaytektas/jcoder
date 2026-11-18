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

import { restoreNodeEnv } from "./production.js"; // first: before anything loads React
import { Agent } from "./agent.js";
import { bridge } from "./browser.js";
import { runApp } from "./app.js";
import { prepare } from "./attach.js";
import { parseGoal, startPrompt } from "./goal.js";
import { listModels, serverContext } from "./client.js";
import { loadConfig, type Config, type Mode } from "./config.js";
import { systemPrompt } from "./prompt.js";
import { setup } from "./setup.js";
import { listSessions, newSession, openSession } from "./session.js";
import { VERSION } from "./update.js";
import path from "node:path";
import { PlainView } from "./view.js";

restoreNodeEnv();

const MODES: Mode[] = ["ro", "edit", "auto"];

const USAGE = `jcoder — a coding agent for a local OpenAI-compatible server

  jcoder                 start
  jcoder -c              continue the last conversation in this directory
  jcoder -p "prompt"     run one request and exit
  jcoder --goal "cond"   work until a condition is met, then exit (0 met, 2 not)
         [--goal-check "cmd"]  met when cmd exits 0, instead of the model judging
  jcoder --setup         find or change the model server
  jcoder --version
  options: --mode ro|edit|auto  --yolo (= --mode auto)  --model ID  --url http://host:port`;

function parseArgs(argv: string[]) {
  const o: { print?: string; goal?: string; goalCheck?: string; cont: boolean; setup: boolean; mode?: Mode; model?: string; url?: string } = { cont: false, setup: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "-p" || a === "--print") o.print = next();
    else if (a === "--goal") o.goal = next();
    else if (a === "--goal-check") o.goalCheck = next();
    else if (a === "-c" || a === "--continue") o.cont = true;
    else if (a === "--mode") {
      const m = next() as Mode;
      if (!MODES.includes(m)) throw new Error(`--mode must be ro, edit or auto`);
      o.mode = m;
    } else if (a === "--yolo") o.mode = "auto";
    else if (a === "--setup") o.setup = true;
    else if (a === "--model") o.model = next();
    else if (a === "--url") o.url = next().replace(/\/+$/, "");
    else if (a === "-v" || a === "--version") {
      console.log(`jcoder ${VERSION}`);
      process.exit(0);
    } else if (a === "-h" || a === "--help") {
      console.log(USAGE);
      process.exit(0);
    } else throw new Error(`unknown option ${a}\n\n${USAGE}`);
  }
  // A goal runs like -p: no terminal needed.
  if ((o.goal !== undefined || o.goalCheck !== undefined) && o.print === undefined) o.print = "";
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

  const interactive = process.stdin.isTTY && process.stdout.isTTY && args.print === undefined;
  if (args.setup) {
    if (!interactive) throw new Error("--setup needs a terminal");
    if (!(await setup(cfg))) process.exit(1);
  }

  let ctxWindow: number | undefined;
  while (ctxWindow === undefined) {
    try {
      ctxWindow = await connect(cfg);
    } catch (e: any) {
      const why = `Can't reach a model server at ${cfg.baseUrl} (${e.cause?.code ?? e.cause?.message ?? e.message}).`;
      if (!interactive) {
        console.error(`jcoder: ${why}\nStart it, or point jcoder at it: jcoder --url http://host:port (or jcoder --setup).`);
        process.exit(1);
      }
      if (!(await setup(cfg, why))) process.exit(1);
    }
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

  if (cfg.browser)
    await bridge.start(cfg.browserListen, cfg.browserToken, `jcoder · ${path.basename(cwd)}`).catch((e) => console.error(`jcoder: browser bridge: ${e.message}`));

  if (args.print !== undefined) {
    const view = new PlainView();
    const agent = new Agent(cfg, session, ctxWindow, view);
    if (resumed) agent.estimateUsed();
    let text = args.print;
    if (args.goal !== undefined || args.goalCheck !== undefined) {
      const parsed = parseGoal(args.goalCheck ? `${args.goal ?? ""} --check ${args.goalCheck}` : args.goal!);
      if ("error" in parsed) throw new Error(parsed.error.replace("/goal", "--goal").replace("--check", "--goal-check"));
      agent.setGoal(parsed);
      text = [text, startPrompt(agent.goal!)].filter(Boolean).join("\n\n");
    }
    if (!text.trim()) throw new Error("-p needs a prompt");
    const prep = await prepare(text, [], agent.toolContext(new AbortController().signal));
    for (const e of prep.errors) view.notice(e, "error");
    if (prep.notes.length) view.notice(`attached ${prep.notes.join(", ")}`);
    await agent.turn(prep.text, prep.images);
    for (let next = await agent.goalNext(); next; next = await agent.goalNext()) await agent.turn(next, [], true);
    if ((args.goal !== undefined || args.goalCheck !== undefined) && agent.goalOutcome !== "met") process.exit(2);
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
