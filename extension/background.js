// jcoder in Chrome — Copyright (C) 2026 Jason Roughley — SPDX-License-Identifier: GPL-3.0-or-later
//
// The extension's service worker. It connects to every jcoder it can find
// (each listens on a local port; see src/browser.ts), gives each one its own
// tab group, and runs the browser tool's actions there through the DevTools
// protocol (chrome.debugger): trusted clicks and keys, screenshots, console
// and network.

import { pageHelper } from "./page.js";

const VERSION = chrome.runtime.getManifest().version;
const DEFAULTS = { addresses: "127.0.0.1:47823-47832", token: "" };
const MAX_SHOT = 1280;
const COLORS = ["blue", "purple", "cyan", "green", "orange", "pink", "red", "yellow"];

// ---------------------------------------------------------------- connections

/** url -> { ws, url, session, name, groupId, lastTab, queue, error } */
const conns = new Map();
let settings = { ...DEFAULTS };

async function loadSettings() {
  settings = { ...DEFAULTS, ...(await chrome.storage.local.get(["addresses", "token"])) };
}

/** "host:47823-47832, wss://other/x" -> WebSocket URLs. */
function urls() {
  const out = [];
  for (let a of settings.addresses.split(/[\s,]+/).filter(Boolean)) {
    if (/^wss?:\/\//.test(a)) {
      out.push(a);
      continue;
    }
    const m = /^(.*?):(\d+)(?:-(\d+))?$/.exec(a);
    if (!m) continue;
    const host = m[1] || "127.0.0.1";
    const from = Number(m[2]), to = Math.min(Number(m[3] || m[2]), from + 50);
    for (let p = from; p <= to; p++) out.push(`ws://${host}:${p}`);
  }
  return out.map((u) => (settings.token ? `${u}${u.includes("?") ? "&" : "?"}token=${encodeURIComponent(settings.token)}` : u));
}

function connectAll() {
  const want = new Set(urls());
  for (const [url, c] of conns) if (!want.has(url)) (c.ws.close(), conns.delete(url));
  for (const url of want) {
    if (conns.has(url)) continue;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch {
      continue;
    }
    const c = { ws, url, session: "", name: "jcoder", groupId: -1, lastTab: -1, queue: Promise.resolve(), open: false };
    conns.set(url, c);
    ws.onopen = () => {
      c.open = true;
      ws.send(JSON.stringify({ type: "hello", version: VERSION, browser: browserName() }));
    };
    ws.onmessage = (e) => message(c, e.data);
    ws.onclose = () => {
      if (conns.get(url) === c) conns.delete(url);
      badge();
    };
    ws.onerror = () => {};
  }
}

function browserName() {
  const ua = navigator.userAgentData?.brands?.find((b) => !/Not.?A.?Brand|Chromium/i.test(b.brand));
  return ua ? `${ua.brand} ${ua.version}` : "Chrome";
}

async function message(c, data) {
  let m;
  try {
    m = JSON.parse(data);
  } catch {
    return;
  }
  if (m.type === "welcome") {
    c.session = m.session;
    c.name = m.name || "jcoder";
    const saved = (await chrome.storage.session.get("groups")).groups ?? {};
    c.groupId = saved[c.session] ?? -1;
    badge();
    return;
  }
  if (m.type !== "call") return;
  // One action at a time per jcoder: they share the tabs.
  c.queue = c.queue.then(async () => {
    let r;
    try {
      // jcoder gives up after its own timeout; so does the queue, so one stuck action can't hold up the rest.
      const limit = (m.action === "wait" ? 75 : 40) * 1000;
      r = await Promise.race([run(c, m.action, m.args ?? {}), sleep(limit).then(() => ({ text: `${m.action} took over ${limit / 1000}s and was abandoned.`, error: true }))]);
    } catch (e) {
      r = { text: String(e?.message ?? e), error: true };
    }
    c.ws.send(JSON.stringify({ type: "result", id: m.id, ...r }));
  });
}

function badge() {
  const n = [...conns.values()].filter((c) => c.session).length;
  chrome.action.setBadgeText({ text: n ? String(n) : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#2563eb" });
}

// ---------------------------------------------------------------- tabs and groups

async function groupExists(id) {
  if (id < 0) return false;
  try {
    await chrome.tabGroups.get(id);
    return true;
  } catch {
    return false;
  }
}

async function saveGroup(c) {
  const saved = (await chrome.storage.session.get("groups")).groups ?? {};
  saved[c.session] = c.groupId;
  await chrome.storage.session.set({ groups: saved });
}

async function groupTabs(c) {
  if (!(await groupExists(c.groupId))) return [];
  return chrome.tabs.query({ groupId: c.groupId });
}

async function newTab(c, url) {
  let windowId;
  if (await groupExists(c.groupId)) windowId = (await chrome.tabGroups.get(c.groupId)).windowId;
  else {
    const w = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
    windowId = w?.id ?? (await chrome.windows.create({ focused: false })).id;
  }
  const tab = await chrome.tabs.create({ windowId, url: "about:blank", active: true });
  if (await groupExists(c.groupId)) await chrome.tabs.group({ groupId: c.groupId, tabIds: [tab.id] });
  else {
    c.groupId = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId } });
    const used = new Set([...conns.values()].map((o) => o.color));
    c.color = COLORS.find((x) => !used.has(x)) ?? "blue";
    await chrome.tabGroups.update(c.groupId, { title: c.name, color: c.color });
    await saveGroup(c);
  }
  c.lastTab = tab.id;
  // Attached before the page loads, so its console and requests are all seen.
  await attach(tab.id);
  if (url) await navigate(tab.id, url);
  return chrome.tabs.get(tab.id);
}

/** The tab an action is for: the one named, else the last used, else the group's active one. */
async function target(c, id, create = true) {
  const tabs = await groupTabs(c);
  if (id !== undefined && id !== null && id !== "") {
    const t = tabs.find((t) => t.id === Number(id));
    if (!t) throw new Error(`Tab ${id} isn't in jcoder's tab group. action tabs lists them; the user can drag a tab into the group to hand it over.`);
    c.lastTab = t.id;
    return t;
  }
  const t = tabs.find((t) => t.id === c.lastTab) ?? tabs.find((t) => t.active) ?? tabs[0];
  if (t) {
    c.lastTab = t.id;
    return t;
  }
  return create ? newTab(c) : null;
}

// ---------------------------------------------------------------- the DevTools protocol

/** tabId -> { console, consoleShown, requests, order, netShown, dialog, notes, scale, mainFrame, loading, loadWaiters } */
const tabs = new Map();

function state(tabId) {
  let s = tabs.get(tabId);
  if (!s) {
    s = { attached: false, console: [], consoleShown: 0, newErrors: 0, requests: new Map(), order: [], netShown: 0, dialog: null, notes: [], scale: null, mainFrame: "", loading: false, waiters: [], dialogWaiters: [] };
    tabs.set(tabId, s);
  }
  return s;
}

/**
 * A DevTools command. Input and script commands don't return while a
 * confirm() or prompt() they set off is open, so those come back
 * { dialogOpened: true } as soon as one opens.
 */
function send(tabId, method, params = {}) {
  const p = chrome.debugger.sendCommand({ tabId }, method, params);
  if (!/^(Input\.|Runtime\.evaluate|Runtime\.callFunctionOn)/.test(method)) return p;
  const s = state(tabId);
  let w;
  const opened = new Promise((ok) => {
    w = () => ok({ dialogOpened: true });
    if (s.dialog) w();
    else s.dialogWaiters.push(w);
  });
  return Promise.race([p, opened]).finally(() => (s.dialogWaiters = s.dialogWaiters.filter((x) => x !== w)));
}

async function attach(tabId) {
  const s = state(tabId);
  if (s.attached) return;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (!/already attached/i.test(msg)) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      throw new Error(`Can't control this tab (${tab?.url ?? "?"}): ${msg}. Chrome doesn't allow extensions on chrome:// pages, the Web Store or other extensions; navigate somewhere else.`);
    }
  }
  s.attached = true;
  await Promise.all([send(tabId, "Page.enable"), send(tabId, "Runtime.enable"), send(tabId, "Log.enable"), send(tabId, "Network.enable", { maxPostDataSize: 4096 })]);
  const tree = await send(tabId, "Page.getFrameTree").catch(() => null);
  s.mainFrame = tree?.frameTree?.frame?.id ?? "";
}

chrome.debugger.onDetach.addListener(({ tabId }, reason) => {
  const s = tabs.get(tabId);
  if (s) {
    s.attached = false;
    if (reason === "canceled_by_user") s.notes.push("The user stopped jcoder debugging this tab (the bar at the top); it's attached again when needed.");
  }
});

chrome.tabs.onRemoved.addListener((id) => tabs.delete(id));

const remote = (o) => {
  if (!o) return "";
  if (o.type === "string") return o.value;
  if ("value" in o) return typeof o.value === "object" ? JSON.stringify(o.value) : String(o.value);
  if (o.unserializableValue) return o.unserializableValue;
  if (o.preview?.properties) {
    const inner = o.preview.properties.map((p) => (o.subtype === "array" ? p.value : `${p.name}: ${p.value}`)).join(", ");
    return o.subtype === "array" ? `[${inner}${o.preview.overflow ? ", …" : ""}]` : `{${inner}${o.preview.overflow ? ", …" : ""}}`;
  }
  return o.description ?? o.type;
};

function addConsole(s, level, text, where) {
  s.console.push({ level, text: text.length > 2000 ? text.slice(0, 2000) + "…" : text, where });
  if (level === "error") s.newErrors++;
  if (s.console.length > 1000) {
    s.console.splice(0, 200);
    s.consoleShown = Math.max(0, s.consoleShown - 200);
  }
}

chrome.debugger.onEvent.addListener(({ tabId }, method, p) => {
  const s = tabs.get(tabId);
  if (!s) return;
  switch (method) {
    case "Runtime.consoleAPICalled": {
      const f = p.stackTrace?.callFrames?.[0];
      const level = { warning: "warn", error: "error", assert: "error" }[p.type] ?? (p.type === "log" ? "log" : p.type);
      addConsole(s, level, p.args.map(remote).join(" "), f ? `${f.url.split("/").pop() || "page"}:${f.lineNumber + 1}` : "");
      break;
    }
    case "Runtime.exceptionThrown": {
      const d = p.exceptionDetails;
      addConsole(s, "error", `Uncaught ${d.exception?.description ?? d.text}`, d.url ? `${d.url.split("/").pop() || "page"}:${d.lineNumber + 1}` : "");
      break;
    }
    case "Log.entryAdded":
      addConsole(s, p.entry.level === "warning" ? "warn" : p.entry.level, p.entry.text + (p.entry.url ? ` ${p.entry.url}` : ""), p.entry.source);
      break;
    case "Network.requestWillBeSent": {
      const r = { id: p.requestId, method: p.request.method, url: p.request.url, type: p.type ?? "", status: 0, mime: "", size: 0, failed: "", post: p.request.postData };
      if (!s.requests.has(p.requestId)) s.order.push(p.requestId);
      s.requests.set(p.requestId, r);
      if (s.order.length > 1000) {
        for (const id of s.order.splice(0, 200)) s.requests.delete(id);
        s.netShown = Math.max(0, s.netShown - 200);
      }
      break;
    }
    case "Network.responseReceived": {
      const r = s.requests.get(p.requestId);
      if (r) (r.status = p.response.status, r.mime = p.response.mimeType);
      break;
    }
    case "Network.loadingFinished": {
      const r = s.requests.get(p.requestId);
      if (r) r.size = p.encodedDataLength;
      break;
    }
    case "Network.loadingFailed": {
      const r = s.requests.get(p.requestId);
      if (r) r.failed = p.canceled ? "canceled" : p.blockedReason ? `blocked (${p.blockedReason})` : p.errorText;
      break;
    }
    case "Page.frameNavigated":
      if (!p.frame.parentId) s.mainFrame = p.frame.id;
      break;
    case "Page.frameStartedLoading":
      if (p.frameId === s.mainFrame) s.loading = true;
      break;
    case "Page.frameStoppedLoading":
      if (p.frameId === s.mainFrame) {
        s.loading = false;
        s.waiters.splice(0).forEach((w) => w());
      }
      break;
    case "Page.navigatedWithinDocument":
      if (p.frameId === s.mainFrame) s.waiters.splice(0).forEach((w) => w());
      break;
    case "Page.javascriptDialogOpening":
      if (p.type === "alert" || p.type === "beforeunload") {
        // Nothing to decide: accepted at once, and the model told.
        send(tabId, "Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
        s.notes.push(p.type === "alert" ? `An alert said: "${p.message}" (accepted).` : "The page asked to confirm leaving it (accepted).");
      } else {
        s.dialog = { type: p.type, message: p.message, defaultPrompt: p.defaultPrompt };
        s.waiters.splice(0).forEach((w) => w());
        s.dialogWaiters.splice(0).forEach((w) => w());
      }
      break;
    case "Page.javascriptDialogClosed":
      s.dialog = null;
      break;
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Waits for the page to stop loading (or a same-page navigation), up to ms. */
function untilLoaded(s, ms) {
  return new Promise((ok) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      s.waiters = s.waiters.filter((w) => w !== done);
      ok();
    }
    s.waiters.push(done);
  });
}

/** After an action: let a navigation it started finish. */
async function settle(tabId, ms = 400) {
  const s = state(tabId);
  await sleep(ms);
  if (s.loading && !s.dialog) await untilLoaded(s, 10_000);
}

function dialogError(s) {
  const d = s.dialog;
  return new Error(`A ${d.type} dialog is open on this tab: "${d.message}". Answer it first: action dialog, text accept or dismiss${d.type === "prompt" ? ", or the text to answer it with" : ""}.`);
}

/** Calls window.__jcoder.<fn>(...args) in the page, installing it first if it isn't there. */
async function helper(tabId, fn, ...args) {
  const s = state(tabId);
  if (s.dialog) throw dialogError(s);
  const expression = `(${pageHelper.toString()})(); window.__jcoder.${fn}(...${JSON.stringify(args)})`;
  const r = await send(tabId, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.dialogOpened) return "A dialog opened.";
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split("\n")[0].replace(/^Error: /, "") ?? r.exceptionDetails.text);
  return r.result.value;
}

async function evaluate(tabId, expression) {
  const r = await send(tabId, "Runtime.evaluate", { expression, returnByValue: true });
  return r.result?.value;
}

async function navigate(tabId, url) {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = (/^(localhost|127\.|\[::1\]|[\w-]+:\d+)/.test(url) ? "http://" : "https://") + url;
  if (/^javascript:/i.test(url)) throw new Error("Use action js to run JavaScript.");
  if (/^(chrome|chrome-extension|chrome-untrusted|devtools|edge|brave|view-source):/i.test(url) || (/^about:/i.test(url) && !/^about:blank$/i.test(url)))
    throw new Error(`Chrome doesn't let extensions control ${url.split(/[?#]/)[0]}: navigate to a web page instead.`);
  if (/^data:/i.test(url)) throw new Error("Chrome won't open data: URLs in a tab. Write the page to a file and open it as file://…, or set the page's content with js.");
  const s = state(tabId);
  s.loading = true;
  const r = await send(tabId, "Page.navigate", { url });
  if (r.errorText) s.loading = false;
  if (r.errorText === "net::ERR_ABORTED") throw new Error(`${url} didn't open as a page: it may have started a download, or the page stopped it.`);
  if (r.errorText) throw new Error(`Couldn't open ${url}: ${r.errorText}`);
  await untilLoaded(s, 20_000);
}

// ---------------------------------------------------------------- input

const NAMED = {
  enter: ["Enter", "Enter", 13, "\r"], return: ["Enter", "Enter", 13, "\r"], tab: ["Tab", "Tab", 9], backspace: ["Backspace", "Backspace", 8],
  delete: ["Delete", "Delete", 46], del: ["Delete", "Delete", 46], escape: ["Escape", "Escape", 27], esc: ["Escape", "Escape", 27],
  space: [" ", "Space", 32, " "], arrowup: ["ArrowUp", "ArrowUp", 38], up: ["ArrowUp", "ArrowUp", 38], arrowdown: ["ArrowDown", "ArrowDown", 40],
  down: ["ArrowDown", "ArrowDown", 40], arrowleft: ["ArrowLeft", "ArrowLeft", 37], left: ["ArrowLeft", "ArrowLeft", 37],
  arrowright: ["ArrowRight", "ArrowRight", 39], right: ["ArrowRight", "ArrowRight", 39], home: ["Home", "Home", 36], end: ["End", "End", 35],
  pageup: ["PageUp", "PageUp", 33], pagedown: ["PageDown", "PageDown", 34], insert: ["Insert", "Insert", 45],
};
for (let i = 1; i <= 12; i++) NAMED[`f${i}`] = [`F${i}`, `F${i}`, 111 + i];
const PUNCT = { "-": ["Minus", 189], "=": ["Equal", 187], "[": ["BracketLeft", 219], "]": ["BracketRight", 221], "\\": ["Backslash", 220], ";": ["Semicolon", 186], "'": ["Quote", 222], ",": ["Comma", 188], ".": ["Period", 190], "/": ["Slash", 191], "`": ["Backquote", 192] };
const MODS = { alt: 1, option: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, super: 4, win: 4, shift: 8 };
const EDIT_COMMANDS = { a: "selectAll", c: "copy", x: "cut", v: "paste", z: "undo", y: "redo" };

async function pressKeys(tabId, text) {
  const combos = String(text).trim().split(/\s+/).filter(Boolean);
  if (!combos.length) throw new Error("key needs text: the keys to press, like Enter, ctrl+a or \"Tab Tab\"");
  for (const combo of combos) {
    const parts = combo.split("+");
    const keyName = parts.pop() || "+";
    let modifiers = 0;
    for (const m of parts) {
      const bit = MODS[m.toLowerCase()];
      if (!bit) throw new Error(`Unknown modifier "${m}" in ${combo}: use ctrl, shift, alt or meta`);
      modifiers |= bit;
    }
    let key, code, keyCode, txt;
    const named = NAMED[keyName.toLowerCase()];
    if (named) [key, code, keyCode, txt] = named;
    else if ([...keyName].length === 1) {
      key = modifiers & 8 && /[a-z]/.test(keyName) ? keyName.toUpperCase() : keyName;
      const up = keyName.toUpperCase();
      if (/[A-Z]/.test(up)) (code = `Key${up}`, keyCode = up.charCodeAt(0));
      else if (/\d/.test(keyName)) (code = `Digit${keyName}`, keyCode = keyName.charCodeAt(0));
      else [code, keyCode] = PUNCT[keyName] ?? ["", 0];
      txt = key;
    } else throw new Error(`Unknown key "${keyName}" in ${combo}`);
    const typing = txt && !(modifiers & 7);
    const commands = modifiers & 6 && EDIT_COMMANDS[keyName.toLowerCase()] && !(modifiers & 1) ? [EDIT_COMMANDS[keyName.toLowerCase()]] : undefined;
    const base = { modifiers, key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
    await send(tabId, "Input.dispatchKeyEvent", { ...base, type: typing ? "keyDown" : "rawKeyDown", ...(typing ? { text: txt, unmodifiedText: txt } : {}), ...(commands ? { commands } : {}) });
    await send(tabId, "Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  }
  return combos.join(" ");
}

async function mouse(tabId, type, x, y, extra = {}) {
  await send(tabId, "Input.dispatchMouseEvent", { type, x, y, ...extra });
}

async function click(tabId, x, y, button = "left", count = 1) {
  await mouse(tabId, "mouseMoved", x, y);
  for (let i = 1; i <= count; i++) {
    await mouse(tabId, "mousePressed", x, y, { button, buttons: button === "right" ? 2 : 1, clickCount: i });
    await mouse(tabId, "mouseReleased", x, y, { button, buttons: 0, clickCount: i });
  }
}

/** The point an action is aimed at, in CSS pixels: an element's centre, or a screenshot's x,y scaled back. */
async function point(tabId, a, need = true) {
  if (a.ref) return helper(tabId, "point", a.ref);
  if (a.x !== undefined && a.y !== undefined) {
    const sc = state(tabId).scale ?? 1;
    return { x: Number(a.x) * sc, y: Number(a.y) * sc, what: `${a.x},${a.y}`, covered: "" };
  }
  if (need) throw new Error("Say where: ref (from read_page or find) or x,y (from a screenshot).");
  return null;
}

// ---------------------------------------------------------------- screenshots

function base64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** The viewport as a JPEG at most MAX_SHOT wide or high, and the CSS pixels per image pixel. Or a region of it, enlarged. */
async function capture(tabId, region) {
  const s = state(tabId);
  if (s.dialog) throw dialogError(s);
  const vp = await evaluate(tabId, "[innerWidth, innerHeight, devicePixelRatio]");
  const shot = await send(tabId, "Page.captureScreenshot", { format: "png" });
  const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${shot.data}`)).blob());
  // Image pixels from the top left are CSS pixels times the device pixel ratio (the zoom included).
  const devicePerCss = vp[2] || 1;
  let sx = 0, sy = 0, sw = bmp.width, sh = bmp.height;
  if (region) {
    // Region in the last screenshot's pixels -> device pixels.
    const sc = (s.scale ?? 1) * devicePerCss;
    sx = Math.max(0, Math.min(region.x, region.x2) * sc);
    sy = Math.max(0, Math.min(region.y, region.y2) * sc);
    sw = Math.min(bmp.width - sx, Math.abs(region.x2 - region.x) * sc);
    sh = Math.min(bmp.height - sy, Math.abs(region.y2 - region.y) * sc);
    if (sw < 4 || sh < 4) throw new Error("zoom needs a region: x,y and x2,y2 corners in the last screenshot.");
  }
  const fit = region ? Math.min(MAX_SHOT / sw, MAX_SHOT / sh, 4) : Math.min(1, MAX_SHOT / sw, MAX_SHOT / sh);
  const w = Math.round(sw * fit), h = Math.round(sh * fit);
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext("2d").drawImage(bmp, sx, sy, sw, sh, 0, 0, w, h);
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 });
  const url = `data:image/jpeg;base64,${base64(await blob.arrayBuffer())}`;
  if (!region) s.scale = 1 / (devicePerCss * fit);
  return { url, w, h, vp };
}

// ---------------------------------------------------------------- actions

async function footer(tab) {
  const t = await chrome.tabs.get(tab.id).catch(() => tab);
  const s = state(tab.id);
  const lines = [];
  if (s.notes.length) lines.push(...s.notes.splice(0));
  if (s.dialog) lines.push(`A ${s.dialog.type} dialog is open: "${s.dialog.message}". Answer it with action dialog.`);
  if (s.newErrors) {
    lines.push(`(${s.newErrors} new console error${s.newErrors === 1 ? "" : "s"}: action console shows them)`);
    s.newErrors = 0;
  }
  lines.push(`[tab ${t.id} · ${t.title || "(no title)"} — ${t.url}]`);
  return lines.join("\n");
}

const hostOf = (url) => {
  try {
    const u = new URL(url);
    return u.protocol === "file:" ? "local files" : u.host || u.protocol.replace(":", "");
  } catch {
    return "";
  }
};

async function run(c, action, a) {
  if (action === "tabs") {
    const list = await groupTabs(c);
    if (!list.length) return { text: "No tabs in jcoder's group yet: navigate or new_tab opens one." };
    return { text: list.map((t) => `${t.id}${t.id === c.lastTab ? " (current)" : ""} · ${t.title || "(no title)"} — ${t.url}`).join("\n") };
  }
  if (action === "where") {
    const tab = await target(c, a.tab, false);
    return { text: tab ? tab.url : "", host: tab ? hostOf(tab.pendingUrl || tab.url) : "" };
  }
  if (action === "new_tab") {
    const tab = await newTab(c, a.url);
    return { text: `Opened tab ${tab.id}.\n${await footer(tab)}` };
  }
  if (action === "close_tab") {
    const tab = await target(c, a.tab, false);
    if (!tab) return { text: "No tab to close.", error: true };
    await chrome.tabs.remove(tab.id);
    c.lastTab = -1;
    return { text: `Closed tab ${tab.id}.` };
  }

  const tab = await target(c, a.tab);
  const id = tab.id;
  await attach(id);
  const s = state(id);
  if (s.dialog && action !== "dialog" && action !== "console" && action !== "network") throw dialogError(s);
  // Actions that need the page shown: Chrome doesn't paint tabs in the background.
  if (["screenshot", "zoom", "click", "double_click", "right_click", "hover", "type", "key", "drag", "scroll"].includes(action) && !tab.active)
    await chrome.tabs.update(id, { active: true }), await sleep(150);
  const done = async (text) => ({ text: `${text}\n${await footer(tab)}`, host: hostOf(tab.url) });

  switch (action) {
    case "navigate": {
      if (!a.url) throw new Error("navigate needs url.");
      await navigate(id, String(a.url));
      return done(`Opened ${a.url}.`);
    }
    case "back":
    case "forward":
    case "reload": {
      if (action === "reload") await send(id, "Page.reload");
      else {
        const h = await send(id, "Page.getNavigationHistory");
        const to = h.entries[h.currentIndex + (action === "back" ? -1 : 1)];
        if (!to) return done(`Nothing to go ${action} to.`);
        await send(id, "Page.navigateToHistoryEntry", { entryId: to.id });
      }
      s.loading = true;
      await untilLoaded(s, 15_000);
      return done(action === "reload" ? "Reloaded." : `Went ${action}.`);
    }
    case "read_page":
      return done(await helper(id, "read", a.ref ?? null, !!a.all));
    case "find":
      if (!a.text) throw new Error("find needs text: what to look for.");
      return done(await helper(id, "find", String(a.text)));
    case "text": {
      const t = await helper(id, "text");
      return done(`# ${tab.title}\n\n${t || "(no text on the page)"}`);
    }
    case "screenshot": {
      const shot = await capture(id);
      const r = await done(`Screenshot ${shot.w}x${shot.h} (the page is ${shot.vp[0]}x${shot.vp[1]} CSS px); x,y in it work for click and the rest.`);
      return { ...r, image: shot.url };
    }
    case "zoom": {
      const shot = await capture(id, { x: Number(a.x), y: Number(a.y), x2: Number(a.x2), y2: Number(a.y2) });
      const r = await done(`Close-up of ${a.x},${a.y}–${a.x2},${a.y2} at ${shot.w}x${shot.h}; use the full screenshot's x,y for actions.`);
      return { ...r, image: shot.url };
    }
    case "click":
    case "double_click":
    case "right_click":
    case "hover": {
      const p = await point(id, a);
      if (action === "hover") await mouse(id, "mouseMoved", p.x, p.y);
      else await click(id, p.x, p.y, action === "right_click" ? "right" : "left", action === "double_click" ? 2 : 1);
      await settle(id);
      const verb = { click: "Clicked", double_click: "Double-clicked", right_click: "Right-clicked", hover: "Hovering over" }[action];
      return done(`${verb} ${p.what}${p.covered ? ` (something was on top of it there: ${p.covered}; if nothing happened, close that first)` : ""}.`);
    }
    case "type": {
      if (a.text === undefined) throw new Error("type needs text.");
      let where = "the focused element";
      if (a.ref) {
        const p = await point(id, a);
        await click(id, p.x, p.y);
        where = p.what;
      }
      await send(id, "Input.insertText", { text: String(a.text) });
      await settle(id, 150);
      return done(`Typed ${JSON.stringify(String(a.text).slice(0, 80))} into ${where}.`);
    }
    case "key": {
      const keys = await pressKeys(id, a.text ?? "");
      await settle(id, 250);
      return done(`Pressed ${keys}.`);
    }
    case "scroll": {
      if (a.ref && !a.direction) {
        const p = await helper(id, "point", a.ref);
        return done(`Scrolled ${p.what} into view; ${await helper(id, "scrollInfo")}.`);
      }
      const vp = await evaluate(id, "[innerWidth, innerHeight]");
      const p = (await point(id, a, false)) ?? { x: vp[0] / 2, y: vp[1] / 2 };
      const n = (Number(a.amount) || 5) * 100;
      const dir = a.direction ?? "down";
      const dx = dir === "left" ? -n : dir === "right" ? n : 0, dy = dir === "up" ? -n : dir === "down" ? n : 0;
      await mouse(id, "mouseWheel", p.x, p.y, { deltaX: dx, deltaY: dy });
      await sleep(300);
      return done(`Scrolled ${dir}; the page is ${await helper(id, "scrollInfo")}.`);
    }
    case "drag": {
      const sc = s.scale ?? 1;
      if ([a.x, a.y, a.x2, a.y2].some((v) => v === undefined)) throw new Error("drag needs x,y (from) and x2,y2 (to).");
      const [x1, y1, x2, y2] = [a.x, a.y, a.x2, a.y2].map((v) => Number(v) * sc);
      await mouse(id, "mouseMoved", x1, y1);
      await mouse(id, "mousePressed", x1, y1, { button: "left", buttons: 1, clickCount: 1 });
      for (let i = 1; i <= 10; i++) await mouse(id, "mouseMoved", x1 + ((x2 - x1) * i) / 10, y1 + ((y2 - y1) * i) / 10, { button: "left", buttons: 1 });
      await mouse(id, "mouseReleased", x2, y2, { button: "left", buttons: 0, clickCount: 1 });
      await settle(id, 250);
      return done(`Dragged from ${a.x},${a.y} to ${a.x2},${a.y2}.`);
    }
    case "set": {
      if (!a.ref) throw new Error("set needs ref and text (the value).");
      const r = await helper(id, "set", a.ref, a.text ?? "");
      await settle(id, 150);
      return done(r + ".");
    }
    case "upload": {
      if (!a.ref) throw new Error("upload needs ref: the file input, or the place to drop the files.");
      return done(await helper(id, "files", a.ref, a.files ?? []) + ".");
    }
    case "dialog": {
      if (!s.dialog) return done("No dialog is open.");
      const t = String(a.text ?? "accept").trim();
      const accept = !/^(dismiss|cancel|no)$/i.test(t);
      const d = s.dialog;
      await send(id, "Page.handleJavaScriptDialog", { accept, ...(d.type === "prompt" && accept && !/^(accept|ok|yes)$/i.test(t) ? { promptText: t } : {}) });
      s.dialog = null;
      await settle(id, 300);
      return done(`${accept ? "Accepted" : "Dismissed"} the ${d.type} "${d.message}".`);
    }
    case "js": {
      if (!a.text) throw new Error("js needs text: the JavaScript to run.");
      const r = await send(id, "Runtime.evaluate", { expression: String(a.text), replMode: true, awaitPromise: true, userGesture: true, timeout: 30_000, generatePreview: true });
      if (r.dialogOpened) return done("The code opened a dialog and is waiting on it.");
      if (r.exceptionDetails) {
        const d = r.exceptionDetails;
        return { ...(await done(`Error: ${d.exception?.description ?? d.text}`)), error: true };
      }
      let out;
      const o = r.result;
      if (o.objectId && o.type === "object" && !["node", "error", "regexp", "date"].includes(o.subtype)) {
        const j = await send(id, "Runtime.callFunctionOn", {
          objectId: o.objectId,
          functionDeclaration: "function(){try{return JSON.stringify(this,null,2)}catch(e){return String(this)}}",
          returnByValue: true,
        });
        out = j.result.value;
      } else if (o.subtype === "node") {
        const j = await send(id, "Runtime.callFunctionOn", {
          objectId: o.objectId,
          functionDeclaration: "function(){const h=this.outerHTML??this.textContent??'';return h.length>3000?h.slice(0,3000)+'…':h}",
          returnByValue: true,
        });
        out = j.result?.value || o.description;
      }
      else out = remote(o);
      if (o.objectId) send(id, "Runtime.releaseObject", { objectId: o.objectId }).catch(() => {});
      await settle(id, 150);
      return done(out === undefined ? "undefined" : String(out));
    }
    case "console": {
      let re;
      try {
        re = a.text ? new RegExp(String(a.text), "i") : null;
      } catch (e) {
        throw new Error(`Bad pattern: ${e.message}`);
      }
      const from = a.all ? 0 : s.consoleShown;
      const list = s.console.slice(from).filter((e) => !re || re.test(e.text) || re.test(e.level));
      s.consoleShown = s.console.length;
      s.newErrors = 0;
      const older = from ? ` (${from} older entries already shown; all: true for them too)` : "";
      if (!list.length) return done(`No ${from ? "new " : ""}console messages${re ? " matching" : ""}${older}.`);
      return done(list.slice(-300).map((e) => `[${e.level}] ${e.text}${e.where ? `  (${e.where})` : ""}`).join("\n") + (older ? `\n${older.trim()}` : ""));
    }
    case "network": {
      if (a.ref) {
        const req = s.requests.get(String(a.ref));
        const r = await send(id, "Network.getResponseBody", { requestId: String(a.ref) }).catch((e) => {
          throw new Error(`No body for request ${a.ref}: ${e.message}. Bodies are kept only for a while after the response.`);
        });
        const body = r.base64Encoded ? (/json|text|xml|javascript/.test(req?.mime ?? "") ? atob(r.body) : `(binary, ${Math.round((r.body.length * 3) / 4)} bytes)`) : r.body;
        return done(`${req ? `${req.method} ${req.status} ${req.url}\n${req.post ? `Request body: ${req.post}\n` : ""}` : ""}\n${body}`);
      }
      let re;
      try {
        re = a.text ? new RegExp(String(a.text), "i") : null;
      } catch (e) {
        throw new Error(`Bad pattern: ${e.message}`);
      }
      const from = a.all ? 0 : s.netShown;
      const list = s.order.slice(from).map((k) => s.requests.get(k)).filter((r) => r && (!re || re.test(r.url) || re.test(r.method)));
      s.netShown = s.order.length;
      if (!list.length) return done(`No ${from ? "new " : ""}requests${re ? " matching" : ""}.`);
      const kb = (n) => (n ? (n > 1024 ? `${(n / 1024).toFixed(1)}KB` : `${n}B`) : "");
      return done(
        list
          .slice(-200)
          .map((r) => `${r.id} ${r.method} ${r.failed ? `failed: ${r.failed}` : r.status || "pending"} ${r.type.toLowerCase()} ${r.url.length > 200 ? r.url.slice(0, 200) + "…" : r.url} ${kb(r.size)}`.trim())
          .join("\n") + "\n(ref: a request's id for its response body)",
      );
    }
    case "wait": {
      const secs = Math.min(60, Math.max(0, Number(a.seconds) || (a.text ? 10 : 2)));
      if (!a.text) {
        await sleep(secs * 1000);
        return done(`Waited ${secs}s.`);
      }
      const want = String(a.text);
      const end = Date.now() + secs * 1000;
      while (Date.now() < end) {
        if (s.dialog) throw dialogError(s);
        const found = await evaluate(id, `document.body ? document.body.innerText.includes(${JSON.stringify(want)}) : false`).catch(() => false);
        if (found) return done(`"${want}" is on the page.`);
        await sleep(400);
      }
      return { ...(await done(`"${want}" didn't appear within ${secs}s.`)), error: true };
    }
    case "resize": {
      if (!a.x || !a.y) throw new Error("resize needs x and y: the window's width and height.");
      await chrome.windows.update(tab.windowId, { state: "normal" });
      await chrome.windows.update(tab.windowId, { width: Number(a.x), height: Number(a.y) });
      await sleep(300);
      s.scale = null;
      const vp = await evaluate(id, "[innerWidth, innerHeight]");
      return done(`Window resized; the page is now ${vp[0]}x${vp[1]} CSS px. Take a new screenshot before using x,y.`);
    }
  }
  throw new Error(`Unknown action ${action}.`);
}

// ---------------------------------------------------------------- wake-ups and the popup

chrome.alarms.create("connect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => connectAll());
chrome.runtime.onStartup.addListener(() => connectAll());
chrome.runtime.onInstalled.addListener(() => connectAll());
chrome.storage.onChanged.addListener(async (_, area) => {
  if (area !== "local") return;
  await loadSettings();
  for (const c of conns.values()) c.ws.close();
  conns.clear();
  connectAll();
});

chrome.runtime.onMessage.addListener((m, _, reply) => {
  if (m.type === "status") {
    connectAll();
    reply({
      settings,
      sessions: [...conns.values()].filter((c) => c.session).map((c) => ({ name: c.name, url: c.url.replace(/[?&]token=[^&]*/, ""), groupId: c.groupId })),
    });
  }
});

// While awake, look for jcoders often; asleep, the alarm wakes us every 30s.
setInterval(connectAll, 3000);
loadSettings().then(connectAll);
