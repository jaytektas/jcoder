#!/usr/bin/env node
import { Agent } from "./agent.js";
import { listModels, serverContext } from "./client.js";
import { CONFIG_PATH, loadConfig, saveConfig, type Config, type Mode } from "./config.js";
import { notes, systemPrompt } from "./prompt.js";
import { listSessions, newSession, title, type Session } from "./session.js";
import { c, readLine, write } from "./ui.js";

const MODES: Mode[] = ["ro", "edit", "auto"];
const MODE_TEXT: Record<Mode, string> = {
  ro: "read-only: no edits or commands",
  edit: "edits files freely, asks before commands",
  auto: "edits and runs commands without asking",
};

const HELP = `Commands:
  /think          model thinking on or off (${c.gray("off is faster, weaker on hard problems")})
  /thoughts       show or hide the model's thinking (${c.gray("Ctrl+T while it runs")})
  /mode [m]       ro | edit | auto — no argument cycles
  /compact        summarise the conversation to free context
  /clear          start a new conversation
  /resume         pick an earlier conversation in this directory
  /model [id]     list the server's models, or switch
  /ctx            context use
  /exit           quit (or Ctrl+D)

Keys: Esc stops the model · Ctrl+T shows/hides thinking · Ctrl+C on an empty line quits
Notes: ~/.jcoder/JCODER.md and the project's JCODER.md or AGENTS.md go into the prompt.
Settings: ${CONFIG_PATH}`;

const USAGE = `jcoder — a coding agent for a local OpenAI-compatible server

  jcoder                 start
  jcoder -c              continue the last conversation in this directory
  jcoder -p "prompt"     run one request and exit
  options: --mode ro|edit|auto  --model ID  --url http://host:port`;

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
    } else if (a === "--model") o.model = next();
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

function banner(cfg: Config, agent: Agent) {
  const n = notes(agent.session.cwd);
  write(`${c.bold("jcoder")} ${c.gray("·")} ${cfg.model} ${c.gray("·")} ctx ${Math.round(agent.contextWindow / 1000)}k ${c.gray("·")} mode ${cfg.mode} ${c.gray("·")} thinking ${cfg.thinking ? (cfg.showThinking ? "on, shown" : "on, hidden") : "off"}\n`);
  if (n.length) write(c.gray(`notes: ${n.map((x) => x.file).join(", ")}\n`));
  write(c.gray("/help for commands · Esc stops the model\n\n"));
}

function replay(s: Session) {
  // Show the tail of a resumed conversation so the user knows where it was.
  const shown = s.messages.filter((m) => (m.role === "user" || m.role === "assistant") && m.content).slice(-4);
  for (const m of shown) {
    const text = String(m.content);
    const cut = text.length > 600 ? text.slice(0, 600) + "…" : text;
    write(m.role === "user" ? c.cyan(`› ${cut}\n`) : `${cut}\n`);
  }
  write("\n");
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
  if (args.cont) {
    const last = listSessions(cwd)[0];
    if (last) session = last;
    else write(c.gray("no earlier conversation here; starting a new one\n"));
  }

  if (args.print !== undefined) {
    const agent = new Agent(cfg, session, ctxWindow, false);
    await agent.turn(args.print);
    return;
  }

  let agent = new Agent(cfg, session, ctxWindow, true);
  banner(cfg, agent);
  if (args.cont && session.messages.length > 1) {
    agent.estimateUsed();
    replay(session);
  }

  for (;;) {
    const input = await readLine(c.cyan(`${cfg.mode === "edit" ? "" : cfg.mode + " "}› `));
    if (input === null) break;
    const line = input.trim();
    if (!line) continue;

    if (line.startsWith("/")) {
      const [cmd, ...rest] = line.slice(1).split(/\s+/);
      const arg = rest.join(" ");
      switch (cmd) {
        case "help":
        case "?":
          write(HELP + "\n");
          break;
        case "exit":
        case "quit":
          return;
        case "think":
          cfg.thinking = !cfg.thinking;
          saveConfig(cfg);
          write(`thinking ${cfg.thinking ? "on" : "off"}\n`);
          break;
        case "thoughts":
          cfg.showThinking = !cfg.showThinking;
          saveConfig(cfg);
          write(`thinking ${cfg.showThinking ? "shown" : "hidden"}\n`);
          break;
        case "mode": {
          const m = (arg || MODES[(MODES.indexOf(cfg.mode) + 1) % MODES.length]) as Mode;
          if (!MODES.includes(m)) {
            write(c.red("modes: ro, edit, auto\n"));
            break;
          }
          cfg.mode = m;
          saveConfig(cfg);
          write(`mode ${m}: ${MODE_TEXT[m]}\n`);
          break;
        }
        case "compact":
          await agent.compactNow();
          break;
        case "clear":
          session = newSession(cwd, cfg.model, systemPrompt(cwd));
          agent = new Agent(cfg, session, ctxWindow, true);
          write("new conversation\n");
          break;
        case "resume": {
          const list = listSessions(cwd).slice(0, 15);
          if (!list.length) {
            write("no earlier conversations here\n");
            break;
          }
          list.forEach((s, i) => write(`${String(i + 1).padStart(3)}  ${c.gray(s.updated.slice(0, 16).replace("T", " "))}  ${title(s)}\n`));
          const pick = await readLine("number (Enter to cancel): ", false);
          const idx = Number(pick) - 1;
          if (!pick || !list[idx]) break;
          session = list[idx];
          agent = new Agent(cfg, session, ctxWindow, true);
          agent.estimateUsed();
          replay(session);
          break;
        }
        case "model": {
          let models: string[] = [];
          try {
            models = await listModels(cfg);
          } catch (e: any) {
            write(c.red(`${e.message}\n`));
            break;
          }
          if (!arg) {
            models.forEach((m) => write(`${m === cfg.model ? c.green("●") : " "} ${m}\n`));
            break;
          }
          if (!models.includes(arg)) {
            write(c.red(`the server has no model ${arg}\n`));
            break;
          }
          cfg.model = arg;
          ctxWindow = await connect(cfg);
          agent.contextWindow = ctxWindow;
          write(`model ${arg}\n`);
          break;
        }
        case "ctx":
          write(agent.status() + "\n");
          break;
        default:
          write(c.red(`unknown command /${cmd} — /help\n`));
      }
      continue;
    }

    await agent.turn(line);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`jcoder: ${e.message}`);
    process.exit(1);
  },
);
