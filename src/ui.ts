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
