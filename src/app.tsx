import fs from "node:fs";
import path from "node:path";
import { Box, Static, Text, render, useApp, useInput, useWindowSize } from "ink";
import { useEffect, useRef, useState, type ReactNode } from "react";
import wrapAnsi from "wrap-ansi";
import { Agent, k } from "./agent.js";
import { prepare } from "./attach.js";
import { listModels, serverContext, textOf } from "./client.js";
import { COMMANDS } from "./complete.js";
import { saveConfig, type Config, type Mode } from "./config.js";
import { Editor } from "./editor.js";
import { clipboardImage, type Image } from "./images.js";
import { renderLines, renderMarkdown } from "./markdown.js";
import { DEFAULT_TEMPLATE, notes, systemPrompt, templatePath, USER_TEMPLATE } from "./prompt.js";
import { listSessions, logPath, newSession, openSession, title, type Session } from "./session.js";
import type { Approval, Todo } from "./tools.js";
import type { View } from "./view.js";

const MODES: Mode[] = ["edit", "auto", "ro"];
const MODE_LABEL: Record<Mode, [string, string]> = {
  edit: ["yellow", "⏵ edit · asks before commands"],
  auto: ["red", "⏵⏵ auto · asks nothing"],
  ro: ["green", "read-only"],
};
/**
 * Wraps text ourselves, trimming the spaces at line ends, and one column
 * short of the space it has. Ink's own wrapping keeps a trailing space, so a
 * full line comes out one column too wide; the terminal wraps it, Ink's
 * count of lines to erase is then off by one, and every redraw leaves a copy
 * of the live text in the scrollback.
 */
function useWrap(indent: number) {
  const { columns } = useWindowSize();
  const width = Math.max(20, columns - indent - 1);
  // Line by line, so each keeps its own indent; the space a line broke at
  // starts the next row, so drop it there.
  return (t: string) =>
    t
      .split("\n")
      .map((line) =>
        wrapAnsi(line, width, { hard: true, trim: false })
          .split("\n")
          .map((row, i) => (i ? row.replace(/^((?:\x1b\[[0-9;]*m)*) /, "$1") : row).replace(/[ \t]+$/, ""))
          .join("\n"),
      )
      .join("\n");
}

const tilde = (p: string) => (process.env.HOME && p.startsWith(process.env.HOME) ? "~" + p.slice(process.env.HOME.length) : p);
const SPIN = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];

interface Item {
  id: number;
  el: ReactNode;
}

interface Pick {
  title: string;
  options: string[];
  resolve(i: number | null): void;
}

interface Question {
  question: string;
  options: string[];
  typing: boolean;
  resolve(answer: string | null): void;
}

interface Ask {
  tool: string;
  summary: string;
  /** Picking "no, tell it": typing a reason. */
  typing: boolean;
  resolve(a: Approval): void;
}

// ---------- rendering pieces ----------

/** A piece of a reply; `text` is already rendered markdown. */
function Reply({ text, first }: { text: string; first: boolean }) {
  const wrap = useWrap(2);
  return (
    <Box marginTop={first ? 1 : 0}>
      <Text>{first ? "● " : "  "}</Text>
      <Box flexGrow={1} flexShrink={1}>
        <Text>{wrap(text)}</Text>
      </Box>
    </Box>
  );
}

function Thought({ text, first }: { text: string; first: boolean }) {
  const wrap = useWrap(2);
  return (
    <Box marginTop={first ? 1 : 0}>
      <Text color="gray">{first ? "✻ " : "  "}</Text>
      <Box flexGrow={1} flexShrink={1}>
        <Text color="gray" italic>
          {wrap(text)}
        </Text>
      </Box>
    </Box>
  );
}

function Result({ display, error }: { display: string; error: boolean }) {
  const wrap = useWrap(5);
  return (
    <Box>
      <Text color="gray">{"  ⎿  "}</Text>
      <Box flexShrink={1}>
        <Text color={error ? "red" : "gray"}>{wrap(display)}</Text>
      </Box>
    </Box>
  );
}

function UserLine({ text }: { text: string }) {
  const wrap = useWrap(2);
  return (
    <Box marginTop={1}>
      <Text backgroundColor="#303030" color="gray">❯ </Text>
      <Box flexShrink={1}>
        <Text backgroundColor="#303030">{wrap(text)}</Text>
      </Box>
    </Box>
  );
}

function Spinner({ label, detail, since }: { label: string; detail: string; since: number }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setFrame((f) => f + 1), 120);
    return () => clearInterval(t);
  }, []);
  const secs = Math.floor((Date.now() - since) / 1000);
  return (
    <Box marginTop={1}>
      <Text color="magenta">{SPIN[frame % SPIN.length]} </Text>
      <Text color="magenta">{label}… </Text>
      <Text color="gray">({[`${secs}s`, detail, "esc to interrupt"].filter(Boolean).join(" · ")})</Text>
    </Box>
  );
}

function Picker({ title, options, onPick }: { title: string; options: string[]; onPick(i: number | null): void }) {
  const [sel, setSel] = useState(0);
  useInput((input, key) => {
    if (key.upArrow) setSel((sel - 1 + options.length) % options.length);
    else if (key.downArrow) setSel((sel + 1) % options.length);
    else if (key.return) onPick(sel);
    else if (key.escape) onPick(null);
    else if (/^[1-9]$/.test(input) && Number(input) <= options.length) onPick(Number(input) - 1);
  });
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
      <Text bold>{title}</Text>
      {options.map((o, i) => (
        <Text key={i} color={i === sel ? "cyan" : undefined}>
          {i === sel ? "❯ " : "  "}
          {i + 1}. {o}
        </Text>
      ))}
      <Text color="gray">↑↓ or number, enter to choose, esc to cancel</Text>
    </Box>
  );
}

// ---------- the app ----------

interface Props {
  cfg: Config;
  session: Session;
  contextWindow: number;
  resumed: boolean;
}

function App(props: Props) {
  const { cfg } = props;
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const [items, setItems] = useState<Item[]>([]);
  const [live, setLive] = useState("");
  const [liveThought, setLiveThought] = useState("");
  const [busy, setBusy] = useState<{ label: string; detail: string; since: number } | null>(null);
  const [pick, setPick] = useState<Pick | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [question, setQuestion] = useState<Question | null>(null);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [queue, setQueue] = useState<string[]>([]);
  const [exitArmed, setExitArmed] = useState(false);
  const [, setTick] = useState(0);
  const rerender = () => setTick((t) => t + 1);

  const nextId = useRef(0);
  const push = (el: ReactNode) => setItems((xs) => [...xs, { id: nextId.current++, el }]);
  const notice = (text: string, tone: "info" | "warn" | "error" = "info") =>
    push(
      <Text color={tone === "error" ? "red" : tone === "warn" ? "yellow" : "gray"}>
        {"  "}
        {text}
      </Text>,
    );

  // Streaming state lives in refs: chunks arrive faster than React renders.
  // Every complete line goes straight into the scrollback (Static); only the
  // line still being written is redrawn. A live area taller than the screen
  // can't be redrawn cleanly and leaves copies behind in the scrollback.
  const s = useRef({
    text: "",
    thought: "",
    replyStarted: false,
    thoughtStarted: false,
    inCode: false,
    /** Blank lines held back until more text follows, so a reply never ends in them. */
    blanks: 0,
    pasted: [] as Image[],
  });

  const flushThought = (all: boolean) => {
    const st = s.current;
    const i = all ? st.thought.length : st.thought.lastIndexOf("\n");
    if (i < 0) return;
    let done = st.thought.slice(0, i);
    st.thought = st.thought.slice(i + 1);
    if (!st.thoughtStarted) done = done.replace(/^\s+/, "");
    if (all) done = done.replace(/\s+$/, "");
    if (!done && !st.thoughtStarted) return;
    if (done || !all) push(<Thought text={done} first={!st.thoughtStarted} />);
    st.thoughtStarted = true;
  };

  const flushText = (all: boolean) => {
    const st = s.current;
    const i = all ? st.text.length : st.text.lastIndexOf("\n");
    if (i < 0) return;
    let done = st.text.slice(0, i);
    st.text = st.text.slice(i + 1);
    if (!st.replyStarted) done = done.replace(/^\s+/, "");
    if (all) done = done.replace(/\s+$/, "");
    if (!done && (!st.replyStarted || all)) return;
    if (!done) {
      st.blanks++;
      return;
    }
    const [rendered, inCode] = renderLines(done, st.inCode);
    st.inCode = inCode;
    push(<Reply text={"\n".repeat(st.blanks) + rendered} first={!st.replyStarted} />);
    st.blanks = 0;
    st.replyStarted = true;
  };

  const view: View = {
    busy(label, detail = "") {
      setBusy((b) => ({ label, detail, since: b?.since ?? Date.now() }));
    },
    thinking(chunk) {
      s.current.thought += chunk;
      flushThought(false);
      setLiveThought(s.current.thought);
    },
    text(chunk) {
      const st = s.current;
      if (st.thought) {
        flushThought(true);
        setLiveThought("");
      }
      st.text += chunk;
      flushText(false);
      setLive(st.text);
    },
    endMessage() {
      const st = s.current;
      flushThought(true);
      flushText(true);
      st.text = st.thought = "";
      st.replyStarted = st.thoughtStarted = st.inCode = false;
      st.blanks = 0;
      setLive("");
      setLiveThought("");
    },
    tool(name, summary) {
      push(
        <Box marginTop={1}>
          <Text color="green">● </Text>
          <Box flexShrink={1}>
            <Text>
              <Text bold>{name}</Text> {summary.split("\n")[0]}
            </Text>
          </Box>
        </Box>,
      );
    },
    result(display, error) {
      push(<Result display={display} error={error} />);
    },
    notice,
    approve(tool, summary) {
      return new Promise((resolve) => setAsk({ tool, summary, typing: false, resolve }));
    },
    ask(q, options) {
      return new Promise((resolve) => setQuestion({ question: q, options, typing: options.length === 0, resolve }));
    },
    todos(items) {
      setTodos(items);
    },
    turnDone({ seconds, status, stopped }) {
      setBusy(null);
      if (stopped) push(<Text color="red">{"  ⎿  Interrupted · tell it what to do instead"}</Text>);
      const secs = seconds < 60 ? `${Math.round(seconds)}s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
      push(
        <Box marginTop={1}>
          <Text color="gray">✻ Done in {secs}{status ? ` · ${status}` : ""}</Text>
        </Box>,
      );
    },
  };
  const viewRef = useRef(view);
  viewRef.current = view;
  // The agent holds a stable object that forwards to the latest closures.
  const stableView = useRef<View>(
    new Proxy({} as View, { get: (_, key) => (viewRef.current as any)[key] }),
  ).current;

  const [ctxWindow, setCtxWindow] = useState(props.contextWindow);
  const agentRef = useRef<Agent>(null as any);
  if (!agentRef.current) {
    agentRef.current = new Agent(cfg, props.session, props.contextWindow, stableView);
    if (props.resumed) agentRef.current.estimateUsed();
  }
  const agent = agentRef.current;
  const cwd = agent.session.cwd;

  const newAgent = (session: Session, resumed: boolean) => {
    setTodos([]);
    agentRef.current = new Agent(cfg, session, ctxWindow, stableView);
    if (resumed) agentRef.current.estimateUsed();
    rerender();
  };

  const showUser = (text: string) => push(<UserLine text={text} />);

  const replay = (session: Session) => {
    for (const m of session.messages.slice(1).filter((m) => (m.role === "user" || m.role === "assistant") && m.content).slice(-6)) {
      const t = textOf(m.content);
      if (m.role === "user") showUser(t.length > 800 ? t.slice(0, 800) + "…" : t);
      else push(<Reply text={renderMarkdown(t.length > 1500 ? t.slice(0, 1500) + "…" : t)} first />);
    }
  };

  // Banner, once.
  useEffect(() => {
    const n = notes(cwd);
    push(
      <Box flexDirection="column">
        <Text>
          <Text bold color="magenta">✻ jcoder</Text>
          <Text color="gray">
            {"  "}
            {cfg.model} · ctx {k(ctxWindow)}
          </Text>
        </Text>
        <Text color="gray">{"  "}{tilde(cwd)}</Text>
        {n.length > 0 && <Text color="gray">{"  "}notes: {n.map((x) => x.file).join(", ")}</Text>}
        <Text color="gray">{"  "}/ for commands · @ for files · ctrl+v pastes an image · esc stops the model</Text>
      </Box>,
    );
    if (props.resumed) replay(props.session);
  }, []);

  // ---------- running turns ----------

  const run = async (line: string) => {
    const pasted = s.current.pasted;
    s.current.pasted = [];
    showUser(line);
    const ctx = agentRef.current.toolContext(new AbortController().signal);
    const prep = await prepare(line, pasted, ctx);
    for (const e of prep.errors) notice(e, "error");
    if (prep.notes.length) push(<Text color="gray">{"  ⎿  attached "}{prep.notes.join(", ")}</Text>);
    setBusy({ label: "Thinking", detail: "", since: Date.now() });
    await agentRef.current.turn(prep.text, prep.images);
    setBusy(null);
  };

  // Messages typed while a turn runs wait here and go one at a time.
  useEffect(() => {
    if (busy || pick || !queue.length || agentRef.current.running) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    void run(next);
  }, [queue, busy, pick]);

  const choose = (title: string, options: string[]) =>
    new Promise<number | null>((resolve) => setPick({ title, options, resolve }));

  const setMode = (m: Mode) => {
    cfg.mode = m;
    saveConfig(cfg);
    rerender();
  };

  const command = async (line: string) => {
    const [cmd, ...rest] = line.slice(1).split(/\s+/);
    const arg = rest.join(" ").trim();
    const a = agentRef.current;
    switch (cmd) {
      case "help":
      case "?":
        push(
          <Box flexDirection="column" marginY={1}>
            {COMMANDS.map((c) => (
              <Text key={c.name}>
                {"  "}
                <Text color="cyan">{`/${c.name}${c.args ? " " + c.args : ""}`.padEnd(22)}</Text>
                <Text color="gray">{c.desc}</Text>
              </Text>
            ))}
            <Text> </Text>
            <Text color="gray">  @path          attach a file (its text, an image, or a directory listing)</Text>
            <Text color="gray">  ctrl+v         paste an image from the clipboard</Text>
            <Text color="gray">  \ + enter      new line (alt+enter and ctrl+j too)</Text>
            <Text color="gray">  shift+tab      cycle mode · ctrl+t show/hide thinking · esc stop · ctrl+d quit</Text>
            <Text color="gray">  settings: {path.join(path.dirname(USER_TEMPLATE), "config.json")}</Text>
          </Box>,
        );
        break;
      case "exit":
      case "quit":
        exit();
        break;
      case "clear":
        newAgent(newSession(cwd, cfg.model, systemPrompt(cwd)), false);
        notice("New conversation.");
        break;
      case "resume": {
        const list = listSessions(cwd).slice(0, 9);
        if (!list.length) {
          notice("No earlier conversations here.");
          break;
        }
        const i = await choose(
          "Resume which conversation?",
          list.map((x) => `${x.updated.slice(0, 16).replace("T", " ")}  ${title(x)}`),
        );
        if (i === null) break;
        const session = openSession(list[i]);
        newAgent(session, true);
        notice(`Resumed: ${title(session)}`);
        replay(session);
        break;
      }
      case "compact":
        setBusy({ label: "Compacting", detail: "", since: Date.now() });
        await a.compactNow();
        setBusy(null);
        break;
      case "mode": {
        const m = (arg || MODES[(MODES.indexOf(cfg.mode) + 1) % MODES.length]) as Mode;
        if (!MODES.includes(m)) notice("Modes: ro, edit, auto", "error");
        else setMode(m);
        break;
      }
      case "think":
        cfg.thinking = !cfg.thinking;
        saveConfig(cfg);
        notice(`Model thinking ${cfg.thinking ? "on" : "off"}.`);
        break;
      case "thoughts":
        cfg.showThinking = !cfg.showThinking;
        saveConfig(cfg);
        rerender();
        break;
      case "model": {
        let models: string[];
        try {
          models = await listModels(cfg);
        } catch (e: any) {
          notice(e.message, "error");
          break;
        }
        let id = arg;
        if (!id) {
          const i = await choose("Model", models.map((m) => (m === cfg.model ? `${m} (current)` : m)));
          if (i === null) break;
          id = models[i];
        }
        if (!models.includes(id)) {
          notice(`The server has no model ${id}.`, "error");
          break;
        }
        cfg.model = id;
        const n = (await serverContext(cfg)) ?? cfg.contextWindow;
        setCtxWindow(n);
        a.contextWindow = n;
        notice(`Model ${id}.`);
        break;
      }
      case "ctx":
        notice(a.status());
        break;
      case "log":
        notice(logPath(a.session));
        break;
      case "prompt":
        if (arg === "edit") {
          if (!fs.existsSync(USER_TEMPLATE)) {
            fs.mkdirSync(path.dirname(USER_TEMPLATE), { recursive: true });
            fs.copyFileSync(DEFAULT_TEMPLATE, USER_TEMPLATE);
          }
          notice(`Edit ${USER_TEMPLATE}. It's used from the next /clear or new session.`);
        } else {
          push(
            <Box flexDirection="column" marginY={1}>
              <Text color="gray">template: {templatePath()}</Text>
              <Text>{systemPrompt(cwd)}</Text>
            </Box>,
          );
        }
        break;
      default:
        notice(`Unknown command /${cmd} — try /help`, "error");
    }
  };

  const onSubmit = (text: string) => {
    setExitArmed(false);
    const line = text.trim();
    if (line.startsWith("/") && !line.includes("\n")) {
      if (agentRef.current.running && !/^\/(thoughts|mode|ctx|log|help)\b/.test(line)) {
        notice("Wait for the model to finish, or press esc.", "warn");
        return false;
      }
      void command(line);
      return;
    }
    setQueue((q) => [...q, line]);
  };

  // App-wide keys. The editor handles typing.
  useInput((input, key) => {
    if (key.escape && agentRef.current.running && !ask && !pick && !question) agentRef.current.stop();
    else if (key.tab && key.shift) setMode(MODES[(MODES.indexOf(cfg.mode) + 1) % MODES.length]);
    else if (key.ctrl && input === "t") {
      cfg.showThinking = !cfg.showThinking;
      saveConfig(cfg);
      rerender();
    } else if (key.ctrl && input === "c" && agentRef.current.running) agentRef.current.stop();
  });

  // ---------- layout ----------

  // The line being written can be a long paragraph: show only its tail if it
  // wouldn't fit above the input.
  const fit = (t: string) => {
    const max = Math.max(200, (rows - 14) * Math.max(20, columns - 4));
    return t.length > max ? "…" + t.slice(t.length - max) : t;
  };
  const [modeColor, modeText] = MODE_LABEL[cfg.mode];
  const a = agentRef.current;
  const editorActive = !pick && !ask && !question;
  const openTodos = todos.some((t) => t.status !== "done") ? todos : [];
  const runningJobs = a.jobs.list().filter((j) => !j.exit).length;

  return (
    <>
      <Static items={items}>{(it) => <Box key={it.id}>{it.el}</Box>}</Static>

      {liveThought && <Thought text={fit(liveThought)} first={!s.current.thoughtStarted} />}
      {live && <Reply text={fit(s.current.inCode ? renderLines(live, true)[0] : live)} first={!s.current.replyStarted} />}
      {busy && <Spinner {...busy} />}

      {queue.map((q, i) => (
        <Text key={i} color="gray">
          {"  "}queued: {q.split("\n")[0].slice(0, 100)}
        </Text>
      ))}

      {pick && (
        <Picker
          title={pick.title}
          options={pick.options}
          onPick={(i) => {
            const p = pick;
            setPick(null);
            p.resolve(i);
          }}
        />
      )}

      {ask && !ask.typing && (
        <Picker
          title={`Allow ${ask.tool}?  ${ask.summary.split("\n")[0].slice(0, 200)}`}
          options={["Yes", `Yes, and don't ask again for ${ask.tool} this session`, "No, and tell it what to do instead"]}
          onPick={(i) => {
            if (i === 2) return setAsk({ ...ask, typing: true });
            const r = ask.resolve;
            setAsk(null);
            r(i === null ? { ok: false } : { ok: true, always: i === 1 });
          }}
        />
      )}
      {ask && ask.typing && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="yellow">Tell it what to do instead (enter on empty just says no):</Text>
          <Editor
            active
            cwd={cwd}
            keepHistory={false}
            onSubmit={(t) => {
              const r = ask.resolve;
              setAsk(null);
              r({ ok: false, reason: t.trim() || undefined });
            }}
            onEscape={() => {
              const r = ask.resolve;
              setAsk(null);
              r({ ok: false });
            }}
          />
        </Box>
      )}

      {question && !question.typing && (
        <Picker
          title={question.question}
          options={[...question.options, "Type an answer"]}
          onPick={(i) => {
            if (i === question.options.length) return setQuestion({ ...question, typing: true });
            const q = question;
            setQuestion(null);
            q.resolve(i === null ? null : q.options[i]);
          }}
        />
      )}
      {question && question.typing && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="yellow">{question.question}</Text>
          <Editor
            active
            cwd={cwd}
            keepHistory={false}
            onSubmit={(t) => {
              const q = question;
              setQuestion(null);
              q.resolve(t.trim() || null);
            }}
            onEscape={() => {
              const q = question;
              setQuestion(null);
              q.resolve(null);
            }}
          />
        </Box>
      )}

      {openTodos.length > 0 && (
        <Box flexDirection="column" marginTop={1} paddingLeft={2}>
          {openTodos.map((t, i) => (
            <Text key={i} color={t.status === "done" ? "gray" : t.status === "in_progress" ? "cyan" : undefined} strikethrough={t.status === "done"}>
              {t.status === "done" ? "☒ " : t.status === "in_progress" ? "▸ " : "☐ "}
              {t.text}
            </Text>
          ))}
        </Box>
      )}

      <Box flexDirection="column" display={editorActive ? "flex" : "none"}>
        <Editor
          active={editorActive}
          cwd={cwd}
          placeholder={a.running ? "type to queue a message" : undefined}
          onSubmit={onSubmit}
          onCtrlV={() => {
            const img = clipboardImage();
            if (!img) return null;
            s.current.pasted.push(img);
            return `[image #${s.current.pasted.length}]`;
          }}
          onCtrlCEmpty={() => {
            if (agentRef.current.running) return; // the app-wide handler stops the turn
            if (exitArmed) exit();
            else setExitArmed(true);
          }}
          onExit={() => exit()}
        />
        <Box justifyContent="space-between" paddingX={1}>
          <Text>
            {exitArmed ? (
              <Text color="yellow">press ctrl+c again to quit</Text>
            ) : (
              <>
                <Text color={modeColor}>{modeText}</Text>
                <Text color="gray"> (shift+tab)</Text>
                {runningJobs > 0 && <Text color="blue"> · {runningJobs} background job{runningJobs > 1 ? "s" : ""}</Text>}
              </>
            )}
          </Text>
          <Text color="gray">
            ctx {a.usedPct}% · {cfg.thinking ? (cfg.showThinking ? "thoughts shown" : "thoughts hidden") : "thinking off"}
            {cfg.thinking ? " (ctrl+t)" : ""}
          </Text>
        </Box>
      </Box>
    </>
  );
}

export async function runApp(cfg: Config, session: Session, contextWindow: number, resumed: boolean) {
  const inst = render(<App cfg={cfg} session={session} contextWindow={contextWindow} resumed={resumed} />, {
    exitOnCtrlC: false,
  });
  await inst.waitUntilExit();
  process.stdout.write(`\x1b[90mresume this conversation with: jcoder -c\x1b[0m\n`);
}
