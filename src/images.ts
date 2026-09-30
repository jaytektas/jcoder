import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { HOME } from "./config.js";

const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};
const EXT: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/bmp": ".bmp" };
const MAX_BYTES = 20 << 20;
const DIR = path.join(HOME, "images");

export const isImagePath = (p: string) => path.extname(p).toLowerCase() in TYPES;

export interface Image {
  /** data: URL, what the server gets. */
  url: string;
  bytes: number;
}

function dataUrl(buf: Buffer, mime: string): Image {
  return { url: `data:${mime};base64,${buf.toString("base64")}`, bytes: buf.length };
}

export function loadImage(file: string): Image {
  const mime = TYPES[path.extname(file).toLowerCase()];
  if (!mime) throw new Error(`${file} is not a png, jpeg, gif, webp or bmp`);
  const size = fs.statSync(file).size;
  if (size > MAX_BYTES) throw new Error(`${file} is ${(size / 1e6).toFixed(1)} MB; the limit is 20 MB`);
  return dataUrl(fs.readFileSync(file), mime);
}

/** The clipboard's image, if it holds one (Wayland, then X11). */
export function clipboardImage(): Image | null {
  const tryTool = (list: [string, string[]], get: (mime: string) => [string, string[]]): Image | null => {
    const types = spawnSync(list[0], list[1], { encoding: "utf8" });
    if (types.status !== 0) return null;
    const avail = types.stdout.split("\n").map((t) => t.trim());
    const mime = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"].find((m) => avail.includes(m));
    if (!mime) return null;
    const [cmd, args] = get(mime);
    const r = spawnSync(cmd, args, { maxBuffer: MAX_BYTES });
    return r.status === 0 && r.stdout.length ? dataUrl(r.stdout, mime) : null;
  };
  if (process.env.WAYLAND_DISPLAY) {
    const img = tryTool(["wl-paste", ["--list-types"]], (m) => ["wl-paste", ["--no-newline", "--type", m]]);
    if (img) return img;
  }
  if (process.env.DISPLAY)
    return tryTool(["xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"]], (m) => [
      "xclip",
      ["-selection", "clipboard", "-t", m, "-o"],
    ]);
  return null;
}

/**
 * Image files named in a message: 'quoted', "quoted", file:// URLs, or bare
 * paths with backslash-escaped spaces — what a terminal pastes when a file is
 * dragged in.
 */
export function imagePathsIn(text: string, cwd: string): string[] {
  const found: string[] = [];
  const re = /'([^']+)'|"([^"]+)"|((?:file:\/\/)?(?:[^\s\\'"]|\\.)+)/g;
  for (const m of text.matchAll(re)) {
    let p = m[1] ?? m[2] ?? m[3];
    if (!isImagePath(p)) continue;
    p = p.replace(/^file:\/\//, "");
    if (m[3]) p = p.replace(/\\(.)/g, "$1");
    try {
      p = decodeURIComponent(p);
    } catch {}
    p = path.resolve(cwd, p.replace(/^~(?=\/)/, process.env.HOME ?? "~"));
    if (!found.includes(p) && fs.existsSync(p) && fs.statSync(p).isFile()) found.push(p);
  }
  return found;
}

/** Saves a data: URL image under ~/.jcoder/images and returns its file:// URL. */
export function storeImage(url: string): string {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
  if (!m) return url;
  const buf = Buffer.from(m[2], "base64");
  const file = path.join(DIR, crypto.createHash("sha1").update(buf).digest("hex") + (EXT[m[1]] ?? ".img"));
  if (!fs.existsSync(file)) {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(file, buf);
  }
  return `file://${file}`;
}

/** The reverse of storeImage. A missing file becomes null. */
export function restoreImage(url: string): string | null {
  if (!url.startsWith("file://")) return url;
  const file = url.slice(7);
  try {
    const mime = TYPES[path.extname(file).toLowerCase()] ?? "image/png";
    return `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
  } catch {
    return null;
  }
}

export const kb = (n: number) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);
