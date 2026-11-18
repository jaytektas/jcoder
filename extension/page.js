// jcoder in Chrome — Copyright (C) 2026 Jason Roughley — SPDX-License-Identifier: GPL-3.0-or-later
//
// Runs inside the page (sent with Runtime.evaluate, so it is self-contained):
// the page as a tree of elements with refs, finding elements, and the parts
// of acting on them that need the DOM. Installed once per document as
// window.__jcoder.

export function pageHelper() {
  const V = 3;
  if (window.__jcoder && window.__jcoder.v === V) return;

  const refs = new Map(); // "e12" -> WeakRef(element)
  const ids = new WeakMap(); // element -> "e12"
  let next = 1;
  const refOf = (el) => {
    let r = ids.get(el);
    if (!r) {
      r = "e" + next++;
      ids.set(el, r);
      refs.set(r, new WeakRef(el));
    }
    return r;
  };
  const byRef = (r) => {
    const el = refs.get(String(r).replace(/^\[|\]$/g, ""))?.deref();
    if (!el || !el.isConnected) throw new Error(`ref ${r} is gone (the page changed): read_page or find again`);
    return el;
  };

  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "META", "LINK", "HEAD", "BR", "WBR"]);
  const INPUT_ROLE = {
    button: "button", submit: "button", reset: "button", image: "button", checkbox: "checkbox", radio: "radio",
    range: "slider", number: "spinbutton", search: "searchbox", file: "file input", color: "color input",
  };
  const INTERACTIVE = new Set([
    "link", "button", "textbox", "searchbox", "checkbox", "radio", "combobox", "listbox", "slider", "spinbutton", "switch",
    "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "treeitem", "file input", "color input", "clickable",
  ]);
  const LANDMARK = { NAV: "navigation", MAIN: "main", HEADER: "banner", FOOTER: "contentinfo", ASIDE: "complementary", FORM: "form", DIALOG: "dialog" };

  const clean = (s, n = 80) => {
    s = String(s ?? "").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  };

  function role(el) {
    const r = el.getAttribute("role");
    if (r) return r.split(" ")[0];
    const t = el.tagName;
    if (t === "A") return el.hasAttribute("href") ? "link" : null;
    if (t === "BUTTON" || t === "SUMMARY") return "button";
    if (t === "INPUT") return el.type === "hidden" ? null : INPUT_ROLE[el.type] ?? "textbox";
    if (t === "TEXTAREA") return "textbox";
    if (t === "SELECT") return el.multiple ? "listbox" : "combobox";
    if (t === "OPTION") return "option";
    if (/^H[1-6]$/.test(t)) return "heading";
    if (t === "IMG") return el.alt ? "img" : null;
    if (t === "IFRAME" || t === "FRAME") return "iframe";
    if (t === "TABLE") return "table";
    if (t === "VIDEO" || t === "AUDIO") return t.toLowerCase();
    if (t === "CANVAS") return "canvas";
    if (LANDMARK[t]) return LANDMARK[t];
    if (el.isContentEditable && (!el.parentElement || !el.parentElement.isContentEditable)) return "textbox";
    if (el.hasAttribute("onclick") || (el.tabIndex >= 0 && el.hasAttribute("tabindex"))) return "clickable";
    return null;
  }

  function labelText(el) {
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = by.split(/\s+/).map((id) => el.ownerDocument.getElementById(id)?.innerText ?? "").join(" ");
      if (t.trim()) return t;
    }
    if (el.id) {
      try {
        const l = el.ownerDocument.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (l) return l.innerText;
      } catch {}
    }
    const wrap = el.closest("label");
    if (wrap) return wrap.innerText;
    return "";
  }

  function name(el, r) {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria;
    const t = el.tagName;
    if (t === "INPUT" || t === "TEXTAREA" || t === "SELECT") {
      if (["button", "submit", "reset"].includes(el.type)) return el.value || el.type;
      return labelText(el) || el.placeholder || el.title || el.name || "";
    }
    if (t === "IMG") return el.alt;
    if (t === "IFRAME") return el.title || el.name || el.src;
    if (["link", "button", "heading", "tab", "menuitem", "option", "clickable", "switch", "treeitem"].includes(r))
      return el.innerText || el.title || el.querySelector?.("img[alt]")?.alt || el.querySelector?.("svg title")?.textContent || "";
    if (r === "checkbox" || r === "radio") return labelText(el) || el.title || "";
    return el.title || "";
  }

  function visible(el) {
    if (el.getAttribute("aria-hidden") === "true") return false;
    if (el.checkVisibility) return el.checkVisibility({ visibilityProperty: true, opacityProperty: false });
    const s = getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden";
  }

  function details(el, r) {
    const out = [];
    const t = el.tagName;
    if (r === "heading") out.push(`h${t[1] || el.getAttribute("aria-level") || "?"}`);
    if (r === "link") {
      const h = el.getAttribute("href") || "";
      if (h && !h.startsWith("javascript:")) out.push("→ " + clean(h, 100));
    }
    if ((t === "INPUT" && !INPUT_ROLE[el.type]) || t === "TEXTAREA" || r === "searchbox" || r === "spinbutton" || r === "slider") {
      if (el.type && el.type !== "text" && t === "INPUT") out.push(el.type);
      if (el.type === "password") out.push(el.value ? "value=••••" : "empty");
      else out.push(el.value ? `value="${clean(el.value, 100)}"` : "empty");
    }
    if (t === "SELECT") {
      const sel = [...el.selectedOptions].map((o) => clean(o.text, 40));
      out.push(`selected="${sel.join(", ")}"`);
      const opts = [...el.options].map((o) => clean(o.text, 30));
      out.push(`options: ${opts.slice(0, 15).join(" | ")}${opts.length > 15 ? ` | …${opts.length - 15} more` : ""}`);
    }
    if (t === "INPUT" && el.type === "file" && el.files?.length) out.push(`${el.files.length} file(s)`);
    if (el.isContentEditable && r === "textbox" && t !== "INPUT" && t !== "TEXTAREA") out.push(el.innerText.trim() ? `value="${clean(el.innerText, 100)}"` : "empty");
    const checked = el.checked ?? (el.getAttribute("aria-checked") === "true" ? true : undefined);
    if (r === "checkbox" || r === "radio" || r === "switch" || r === "menuitemcheckbox") out.push(checked ? "checked" : "unchecked");
    if (el.getAttribute("aria-expanded")) out.push(el.getAttribute("aria-expanded") === "true" ? "expanded" : "collapsed");
    if (el.getAttribute("aria-selected") === "true") out.push("selected");
    if (el.getAttribute("aria-current") && el.getAttribute("aria-current") !== "false") out.push("current");
    if (el.disabled || el.getAttribute("aria-disabled") === "true") out.push("disabled");
    if (el.required) out.push("required");
    if (el === el.ownerDocument.activeElement && t !== "BODY") out.push("focused");
    return out.join(", ");
  }

  function line(el, r, depth) {
    const n = clean(name(el, r));
    const d = details(el, r);
    return `${"  ".repeat(depth)}- ${r}${n ? ` "${n.replace(/"/g, "'")}"` : ""} [${refOf(el)}]${d ? ` ${d}` : ""}`;
  }

  /** Direct text of an element, not its children's. */
  function ownText(el) {
    let s = "";
    for (const c of el.childNodes) if (c.nodeType === 3) s += c.nodeValue;
    return clean(s, 300);
  }

  function children(el) {
    // A shadow root's slots bring in the light children that are shown.
    if (el.shadowRoot) return [...el.shadowRoot.children];
    if (el.tagName === "SLOT") {
      const a = el.assignedElements();
      return a.length ? a : [...el.children];
    }
    return [...el.children];
  }

  const LIMIT = 4000;

  function tree(root, all) {
    const out = [];
    let count = 0;
    const walk = (el, depth) => {
      if (count > LIMIT || SKIP.has(el.tagName)) return;
      if (!visible(el)) return;
      const r = role(el);
      let shown = false;
      if (r && r !== "generic" && r !== "none" && r !== "presentation") {
        const n = name(el, r);
        const structural = r in { navigation: 1, main: 1, banner: 1, contentinfo: 1, complementary: 1, form: 1, dialog: 1, table: 1, list: 1, region: 1 };
        // Unnamed structure only shows when it holds something, which is decided below.
        if (!structural || n || all) {
          out.push(line(el, r, depth));
          count++;
          shown = true;
        }
      }
      if (all && !shown) {
        const t = ownText(el);
        if (t) {
          out.push(`${"  ".repeat(depth)}- text: ${t}`);
          count++;
        }
      } else if (all && shown && !["link", "button", "heading", "option"].includes(r)) {
        const t = ownText(el);
        if (t && t !== clean(name(el, r))) out.push(`${"  ".repeat(depth + 1)}- text: ${t}`);
      }
      // A link's or button's insides are already in its name.
      if (shown && ["link", "button", "option", "heading", "menuitem", "tab"].includes(r) && !all) return;
      if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
        try {
          const b = el.contentDocument?.body;
          if (b) walk(b, depth + 1);
        } catch {}
        return;
      }
      if (el.tagName === "SELECT") return;
      for (const c of children(el)) walk(c, shown ? depth + 1 : depth);
    };
    walk(root, 0);
    if (count > LIMIT) out.push(`… stopped at ${LIMIT} elements: read_page a ref for one part, or use find`);
    return out;
  }

  /** Every visible element worth matching, for find. */
  function candidates(root) {
    const out = [];
    const walk = (el) => {
      if (out.length > 20000 || SKIP.has(el.tagName) || !visible(el)) return;
      const r = role(el);
      const t = ownText(el);
      if (r || t) out.push([el, r]);
      if (el.tagName === "IFRAME") {
        try {
          if (el.contentDocument?.body) walk(el.contentDocument.body);
        } catch {}
        return;
      }
      for (const c of children(el)) walk(c);
    };
    walk(root);
    return out;
  }

  /** Where an element is in the top viewport, adding the offsets of the frames it's in. */
  function rectOf(el) {
    let r = el.getBoundingClientRect();
    if (!r.width && !r.height) {
      const rs = el.getClientRects();
      if (rs.length) r = rs[0];
    }
    let x = r.left, y = r.top;
    let win = el.ownerDocument.defaultView;
    while (win && win !== window && win.frameElement) {
      const f = win.frameElement.getBoundingClientRect();
      x += f.left + win.frameElement.clientLeft;
      y += f.top + win.frameElement.clientTop;
      win = win.parent;
    }
    return { x, y, w: r.width, h: r.height };
  }

  const describe = (el) => {
    const r = role(el) ?? el.tagName.toLowerCase();
    const n = clean(name(el, r) || el.innerText || "", 60);
    return `${r}${n ? ` "${n}"` : ""}`;
  };

  window.__jcoder = {
    v: V,
    read(ref, all) {
      const root = ref ? byRef(ref) : document.body ?? document.documentElement;
      const lines = tree(root, !!all);
      const sx = Math.round(scrollX), sy = Math.round(scrollY);
      const H = document.documentElement.scrollHeight;
      const head = ref ? "" : `Viewport ${innerWidth}x${innerHeight}, scrolled to ${sy} of ${H} px${sx ? ` (x ${sx})` : ""}.\n`;
      return head + (lines.join("\n") || "(nothing visible)");
    },
    find(query) {
      const q = String(query).toLowerCase().trim();
      const words = q.split(/\s+/).filter(Boolean);
      const scored = [];
      for (const [el, r] of candidates(document.body ?? document.documentElement)) {
        const n = (r ? name(el, r) : "") || "";
        const hay = [r ?? "", n, ownText(el), el.placeholder ?? "", el.id, el.getAttribute("name") ?? "", el.getAttribute("title") ?? "", el.getAttribute("data-testid") ?? "", typeof el.className === "string" ? el.className : ""]
          .join(" ")
          .toLowerCase();
        let s = hay.includes(q) ? 10 : 0;
        const hits = words.filter((w) => hay.includes(w)).length;
        if (!s && hits < Math.ceil(words.length / 2)) continue;
        s += hits;
        if (r && INTERACTIVE.has(r)) s += 2;
        if (clean(n).toLowerCase() === q) s += 5;
        scored.push([s, el, r]);
      }
      scored.sort((a, b) => b[0] - a[0]);
      // Inner matches whose parent matched as well say the same thing twice.
      const picked = [];
      for (const [, el, r] of scored) {
        if (picked.length >= 20) break;
        if (picked.some(([p]) => p.contains(el) && !INTERACTIVE.has(r))) continue;
        picked.push([el, r]);
      }
      if (!picked.length) return `Nothing matches "${query}".`;
      return picked.map(([el, r]) => (r ? line(el, r, 0) : `- text "${clean(ownText(el))}" [${refOf(el)}] in ${describe(el.parentElement ?? el)}`)).join("\n");
    },
    /** Scrolls the element into view and gives its centre, and what is on top of it there if that's something else. */
    point(ref) {
      const el = byRef(ref);
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      const r = rectOf(el);
      if (!r.w && !r.h) throw new Error(`${ref} (${describe(el)}) has no size on screen: it may be hidden`);
      const x = r.x + r.w / 2, y = r.y + r.h / 2;
      let covered = "";
      if (el.ownerDocument === document) {
        const hit = document.elementFromPoint(x, y);
        if (hit && hit !== el && !el.contains(hit) && !hit.contains(el) && !(hit.shadowRoot && hit.contains(el))) covered = describe(hit);
      }
      return { x, y, what: describe(el), covered };
    },
    focus(ref) {
      const el = byRef(ref);
      el.focus();
      return describe(el);
    },
    set(ref, value) {
      const el = byRef(ref);
      const v = String(value ?? "");
      const fire = () => {
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      };
      if (el.tagName === "SELECT") {
        const want = v.toLowerCase();
        const wants = el.multiple ? want.split(/\s*,\s*/) : [want];
        let n = 0;
        for (const o of el.options) {
          const hit = wants.includes(o.text.trim().toLowerCase()) || wants.includes(o.value.toLowerCase());
          if (el.multiple) o.selected = hit;
          else if (hit && !n) el.value = o.value;
          if (hit) n++;
        }
        if (!n) throw new Error(`no option "${v}" in ${describe(el)}; options: ${[...el.options].map((o) => o.text.trim()).join(" | ")}`);
        fire();
        return `${describe(el)} set to "${[...el.selectedOptions].map((o) => o.text.trim()).join(", ")}"`;
      }
      if (el.type === "checkbox" || el.type === "radio" || ["checkbox", "radio", "switch"].includes(el.getAttribute("role"))) {
        const on = /^(true|on|yes|1|checked|check)$/i.test(v);
        const now = el.checked ?? el.getAttribute("aria-checked") === "true";
        if (now !== on) el.click();
        return `${describe(el)} ${on ? "checked" : "unchecked"}`;
      }
      if (el.isContentEditable) {
        el.focus();
        el.textContent = v;
        el.dispatchEvent(new InputEvent("input", { bubbles: true }));
        return `${describe(el)} set`;
      }
      if ("value" in el) {
        el.focus();
        const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        // The native setter, so frameworks that track the value (React) see the change.
        Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, v);
        fire();
        return `${describe(el)} set to "${clean(v, 60)}"`;
      }
      throw new Error(`${describe(el)} has no value to set; click it or type into it instead`);
    },
    files(ref, files) {
      const el = byRef(ref);
      const dt = new DataTransfer();
      for (const f of files) {
        const bin = atob(f.data);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        dt.items.add(new File([bytes], f.name, { type: f.type || "" }));
      }
      if (el.tagName === "INPUT" && el.type === "file") {
        el.files = dt.files;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return `${files.length} file(s) given to ${describe(el)}`;
      }
      // Anything else is treated as a drop zone.
      for (const type of ["dragenter", "dragover", "drop"]) el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
      return `${files.length} file(s) dropped on ${describe(el)}`;
    },
    text() {
      const main = document.querySelector("main, article, [role=main]");
      const el = main && main.innerText.length > 500 ? main : document.body;
      return (el?.innerText ?? "").replace(/\n{3,}/g, "\n\n").trim();
    },
    scrollInfo() {
      return `scrolled to ${Math.round(scrollY)} of ${document.documentElement.scrollHeight - innerHeight} px${scrollX ? `, x ${Math.round(scrollX)}` : ""}`;
    },
  };
}
