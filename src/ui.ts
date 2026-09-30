import readline from "node:readline";

const tty = process.stdout.isTTY;
const esc = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);

export const c = {
  dim: esc("2"),
  bold: esc("1"),
  red: esc("31"),
  green: esc("32"),
  yellow: esc("33"),
  blue: esc("34"),
  cyan: esc("36"),
  gray: esc("90"),
};

export const write = (s: string) => process.stdout.write(s);

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** One status line that redraws in place. */
export class Spinner {
  private timer?: NodeJS.Timeout;
  private frame = 0;
  private started = 0;
  private label = "";
  private detail = "";

  start(label: string) {
    this.label = label;
    this.detail = "";
    if (this.timer) return;
    this.started = Date.now();
    if (!tty) return;
    write("\x1b[?25l");
    this.timer = setInterval(() => this.draw(), 80);
    this.draw();
  }

  set(label: string, detail = "") {
    this.label = label;
    this.detail = detail;
  }

  get running() {
    return this.timer !== undefined;
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
    write("\r\x1b[2K\x1b[?25h");
  }

  private draw() {
    const secs = Math.floor((Date.now() - this.started) / 1000);
    const parts = [`${secs}s`, this.detail, "esc to stop"].filter(Boolean).join(" · ");
    const line = `${c.cyan(FRAMES[this.frame++ % FRAMES.length])} ${this.label}… ${c.gray(parts)}`;
    write(`\r\x1b[2K${line}`);
  }
}

/**
 * While the agent runs, Esc or Ctrl+C calls onStop and Ctrl+T calls onToggle.
 * Returns a function that detaches the listener.
 */
export function watchKeys(onStop: () => void, onToggle?: () => void): () => void {
  if (!process.stdin.isTTY) return () => {};
  const onData = (buf: Buffer) => {
    const s = buf.toString();
    if (s === "\x1b" || s === "\x03") onStop();
    else if (s === "\x14") onToggle?.();
  };
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", onData);
  return () => {
    process.stdin.off("data", onData);
    process.stdin.setRawMode(false);
    process.stdin.pause();
  };
}

const inputHistory: string[] = [];

/**
 * Reads one line with editing and history; resolves null on Ctrl+D, or on
 * Ctrl+C with an empty line. A paste arrives as several lines at once: lines
 * that come within a few ms of each other are joined into one answer, and a
 * pasted last line without a newline waits for Enter.
 */
export function readLine(prompt: string, remember = true): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdin.isTTY,
      history: remember ? inputHistory : [],
      historySize: 500,
    });
    const lines: string[] = [];
    let timer: NodeJS.Timeout | undefined;
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      rl.close();
      if (v && remember && lines.length > 1) inputHistory.unshift(v);
      resolve(v);
    };
    rl.on("line", (l) => {
      lines.push(l);
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!(rl as any).line) finish(lines.join("\n"));
      }, 25);
    });
    rl.on("SIGINT", () => {
      if ((rl as any).line || lines.length) {
        write("\n");
        lines.length = 0;
        finish("");
      } else finish(null);
    });
    rl.on("close", () => finish(lines.length ? lines.join("\n") : null));
    rl.setPrompt(prompt);
    rl.prompt();
  });
}

export function preview(text: string, maxLines: number): string {
  const lines = text.replace(/\s+$/, "").split("\n");
  const shown = lines.slice(0, maxLines).map((l) => (l.length > 160 ? l.slice(0, 160) + "…" : l));
  if (lines.length > maxLines) shown.push(`… ${lines.length - maxLines} more lines`);
  return shown.join("\n");
}

export function indent(text: string, pad = "  "): string {
  return text
    .split("\n")
    .map((l) => pad + l)
    .join("\n");
}
