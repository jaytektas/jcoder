// jcoder — a coding agent for a local LLM server
// Copyright (C) 2026 Jason Roughley
// SPDX-License-Identifier: GPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option)
// any later version. It is distributed WITHOUT ANY WARRANTY; see the LICENSE
// file for details.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HOME } from "./config.js";

/** The installed package: dist/.. */
const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, "package.json"), "utf8"));

export const VERSION: string = pkg.version;

/** owner/name from package.json's repository. */
function repo(): string | null {
  const url = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  const m = /github\.com[/:]([^/]+\/[^/.]+)/.exec(url ?? "");
  return m ? m[1] : null;
}

const STATE = path.join(HOME, "update.json");
const DAY = 24 * 3600 * 1000;

export interface Release {
  version: string;
  /** The jcoder-X.Y.Z.tgz asset. */
  url: string;
  page: string;
}

function newer(a: string, b: string): boolean {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

interface State {
  checked?: number;
  /** A version the user said to skip. */
  skip?: string;
}

function readState(): State {
  try {
    return JSON.parse(fs.readFileSync(STATE, "utf8"));
  } catch {
    return {};
  }
}

function writeState(s: State) {
  try {
    fs.mkdirSync(HOME, { recursive: true });
    fs.writeFileSync(STATE, JSON.stringify(s));
  } catch {}
}

/** Don't offer this version again (later ones still are). */
export function skipVersion(version: string) {
  writeState({ ...readState(), skip: version });
}

/**
 * The latest release if it's newer than this one and not skipped. Asks
 * GitHub at most once a day unless forced (/update), which also ignores a
 * skip. JCODER_UPDATE_URL replaces the GitHub API URL (testing).
 */
export async function checkForUpdate(force = false): Promise<Release | null> {
  const state = readState();
  if (!force && state.checked && Date.now() - state.checked < DAY) return null;
  const r = repo();
  const api = process.env.JCODER_UPDATE_URL || (r && `https://api.github.com/repos/${r}/releases/latest`);
  if (!api) return null;
  writeState({ ...state, checked: Date.now() });
  const res = await fetch(api, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": `jcoder/${VERSION}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 404) return null; // no releases yet
  if (!res.ok) throw new Error(`GitHub: HTTP ${res.status}`);
  const j: any = await res.json();
  const version = String(j.tag_name ?? "").replace(/^v/, "");
  const asset = (j.assets ?? []).find((a: any) => /^jcoder-.*\.tgz$/.test(a.name));
  if (!version || !asset || !newer(version, VERSION)) return null;
  if (!force && state.skip === version) return null;
  return { version, url: asset.browser_download_url, page: j.html_url };
}

/** The npm that belongs to the node running us (a private node brings its own), else the one on PATH. */
function npmBin(): string {
  const own = path.join(path.dirname(process.execPath), process.platform === "win32" ? "npm.cmd" : "npm");
  return fs.existsSync(own) ? own : "npm";
}

/**
 * Whether this copy can replace itself: any npm install, wherever its prefix
 * (<prefix>/lib/node_modules/jcoder). A git checkout, a development copy, is
 * updated with git pull instead.
 */
export function selfUpdate(): { ok: true; prefix: string } | { ok: false; why: string } {
  if (fs.existsSync(path.join(PKG_DIR, ".git"))) return { ok: false, why: "this is a git checkout: git pull and npm run build" };
  const modules = path.dirname(PKG_DIR);
  const lib = path.dirname(modules);
  if (path.basename(PKG_DIR) !== "jcoder" || path.basename(modules) !== "node_modules")
    return { ok: false, why: `jcoder wasn't installed by npm (${PKG_DIR})` };
  // Unix: <prefix>/lib/node_modules; Windows: <prefix>/node_modules.
  const prefix = path.basename(lib) === "lib" ? path.dirname(lib) : lib;
  try {
    fs.accessSync(modules, fs.constants.W_OK);
  } catch {
    return { ok: false, why: `no write access to ${modules}` };
  }
  return { ok: true, prefix };
}

/**
 * npm install of the release file into the prefix this copy came from. The
 * running copy keeps working; the next start is the new version.
 */
export function install(url: string): Promise<void> {
  const can = selfUpdate();
  if (!can.ok) return Promise.reject(new Error(can.why));
  return new Promise((resolve, reject) => {
    const child = spawn(npmBin(), ["install", "-g", "--prefix", can.prefix, "--no-fund", "--no-audit", "--no-update-notifier", url], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.trim().split("\n").slice(-3).join(" ") || `npm exited ${code}`))));
  });
}
