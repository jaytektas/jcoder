import type { ToolResult } from "./tools.js";

const UA = "Mozilla/5.0 (X11; Linux x86_64) jcoder";
const fail = (content: string): ToolResult => ({ content, error: true });

async function get(url: string, signal: AbortSignal, timeoutMs = 20000): Promise<Response> {
  const t = AbortSignal.timeout(timeoutMs);
  return fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5" },
    signal: AbortSignal.any([signal, t]),
    redirect: "follow",
  });
}

export async function webSearch(searchUrl: string, query: string, count: number, signal: AbortSignal): Promise<ToolResult> {
  if (!searchUrl) return fail("Web search isn't set up: set searchUrl (a SearXNG server) in ~/.jcoder/config.json.");
  if (!query.trim()) return fail("query is empty.");
  let j: any;
  try {
    const r = await get(`${searchUrl.replace(/\/+$/, "")}/search?format=json&q=${encodeURIComponent(query)}`, signal);
    if (!r.ok) return fail(`Search failed: HTTP ${r.status} from ${searchUrl}`);
    j = await r.json();
  } catch (e: any) {
    return fail(`Search failed: ${e.cause?.message ?? e.message}`);
  }
  const results: any[] = (j.results ?? []).slice(0, Math.min(20, Math.max(1, count || 8)));
  if (!results.length) return { content: "No results.", display: "no results" };
  const out = results.map((r, i) => {
    const date = r.publishedDate ? ` (${String(r.publishedDate).slice(0, 10)})` : "";
    const snippet = String(r.content ?? "").replace(/\s+/g, " ").trim();
    return `${i + 1}. ${r.title}${date}\n   ${r.url}${snippet ? `\n   ${snippet}` : ""}`;
  });
  const answers: string[] = (j.answers ?? []).map((a: any) => (typeof a === "string" ? a : a.answer)).filter(Boolean);
  return {
    content: (answers.length ? `Answer: ${answers.join(" / ")}\n\n` : "") + out.join("\n\n"),
    display: `${results.length} results`,
  };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", copy: "©", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** HTML to readable text: the main content, headings, list items, code, links as text. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = decode((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").trim()).replace(/\s+/g, " ");
  let h = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|iframe|template|head)\b[\s\S]*?<\/\1>/gi, "");
  // Prefer the page's main content when it says where that is.
  const main = /<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(h);
  if (main && main[2].length > 500) h = main[2];
  else h = h.replace(/<(nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, "");
  h = h
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, code) => `\n\`\`\`\n${code.replace(/<[^>]+>/g, "")}\n\`\`\`\n`)
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, t) => `\n\n${"#".repeat(Number(n))} ${t.replace(/<[^>]+>/g, "").trim()}\n\n`)
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, t) => `\`${t}\``)
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(/<\/(p|div|section|tr|table|ul|ol|blockquote|dd|dt)>/gi, "\n\n")
    .replace(/<t[dh]\b[^>]*>/gi, " | ")
    .replace(/<[^>]+>/g, "");
  const text = decode(h)
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text };
}

export async function webFetch(url: string, signal: AbortSignal): Promise<ToolResult> {
  if (!/^https?:\/\//i.test(url)) return fail("url must start with http:// or https://");
  let r: Response;
  try {
    r = await get(url, signal);
  } catch (e: any) {
    return fail(`Fetch failed: ${e.cause?.message ?? e.message}`);
  }
  if (!r.ok) return fail(`HTTP ${r.status} from ${url}`);
  const type = r.headers.get("content-type") ?? "";
  if (/pdf|image|audio|video|octet-stream|zip/i.test(type)) return fail(`${url} is ${type}, not a web page.`);
  const body = await r.text();
  const final = r.url !== url ? ` (redirected to ${r.url})` : "";
  if (/html/i.test(type) || /^\s*</.test(body)) {
    const { title, text } = htmlToText(body);
    return {
      content: `${title ? `# ${title}\n` : ""}${r.url}${final ? "" : ""}\n\n${text || "(no readable text on the page)"}`,
      display: `${title || url} — ${text.length} chars`,
    };
  }
  return { content: `${r.url}${final}\n\n${body}`, display: `${type || "text"}, ${body.length} chars` };
}
