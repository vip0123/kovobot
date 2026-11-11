// Web pages a Bot reads in full while it researches: fetched as a browser would, then cut down
// to their title, text and links. What a page says is Outside content.

/** A page as the model reads it. */
export interface Page {
  /** Where the page ended up, after any redirects. */
  url: string;
  title: string;
  text: string;
  links: Array<{ text: string; url: string }>;
}

/** The most of a page read: big enough for long articles, small enough to read quickly. */
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const PAGE_TIMEOUT_MS = 20_000;
/** The most of a page's text the model sees: about 3,000 tokens. */
export const MAX_PAGE_TEXT = 12_000;
/** The most links listed from one page. */
const MAX_LINKS = 40;

const READABLE = /^(text\/html|application\/xhtml\+xml|text\/plain|text\/markdown|application\/json)\b/i;

/** Reads one page, or says why it couldn't. */
export async function readPage(fetcher: typeof fetch, address: string): Promise<Page | string> {
  let response: Response;
  try {
    response = await fetcher(address, {
      headers: { accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5", "user-agent": "Kovobot (reads pages for its Customer)" },
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    });
  } catch (error) {
    return `That page couldn't be reached: ${(error as Error).message}`;
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return `That page answered with HTTP ${response.status}.`;
  }
  const type = response.headers.get("content-type") ?? "text/html";
  if (!READABLE.test(type)) {
    await response.body?.cancel().catch(() => {});
    return `That page is ${type.split(";")[0]}, which can't be read here: only web pages and text.`;
  }
  const bytes = await firstBytes(response, MAX_PAGE_BYTES);
  const body = decode(bytes, /charset=([\w-]+)/i.exec(type)?.[1]);
  const url = response.url || address;
  if (!/html/i.test(type)) return { url, title: url, text: body, links: [] };
  return { url, ...fromHtml(body, url) };
}

/** A page as the model sees it: what it is, its text, and where it links to. */
export function pageForModel(page: Page): string {
  const text = page.text.length > MAX_PAGE_TEXT ? `${page.text.slice(0, MAX_PAGE_TEXT)}\n[The rest of the page is cut off.]` : page.text;
  const links = page.links.length > 0 ? `\n\nLinks on the page:\n${page.links.map((link) => `- ${link.text}: ${link.url}`).join("\n")}` : "";
  return `${page.title}\n${page.url}\n\n${text || "[The page has no text.]"}${links}`;
}

/** The http and https addresses in some text, as written. */
export function addressesIn(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s<>"'`)\]]+/gi)].map((match) => match[0].replace(/[.,;:!?]+$/, ""));
}

/** One spelling of an address, so the same page is the same whichever way it was written: no fragment. */
export function sameAddress(address: string): string | null {
  try {
    const url = new URL(address);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

async function firstBytes(response: Response, limit: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  await reader.cancel().catch(() => {});
  return Buffer.concat(chunks).subarray(0, limit);
}

function decode(bytes: Uint8Array, charset: string | undefined): string {
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** A page's title, readable text and links, from its HTML. */
function fromHtml(html: string, base: string): Omit<Page, "url"> {
  const title = clean(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "") || base;
  const body = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(head|script|style|noscript|svg|template|iframe|nav|footer|form)\b[\s\S]*?<\/\1\s*>/gi, " ");
  const links: Page["links"] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi)) {
    if (links.length >= MAX_LINKS) break;
    const href = decodeEntities(match[1] ?? match[2] ?? match[3] ?? "");
    let url: string | null;
    try {
      url = sameAddress(new URL(href, base).href);
    } catch {
      url = null;
    }
    const text = clean(match[4] ?? "");
    if (!url || !text || seen.has(url) || url === sameAddress(base)) continue;
    seen.add(url);
    links.push({ text: text.slice(0, 120), url });
  }
  const text = decodeEntities(
    body
      .replace(/<li\b[^>]*>/gi, "\n- ")
      .replace(/<(br|hr)\b[^>]*>/gi, "\n")
      .replace(/<\/?(p|div|section|article|main|header|aside|h[1-6]|ul|ol|table|tr|blockquote|pre|figure|figcaption|dl|dt|dd)\b[^>]*>/gi, "\n\n")
      .replace(/<\/?(td|th)\b[^>]*>/gi, " ")
      .replace(/<[^>]+>/g, ""),
  )
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text, links };
}

/** Text from a piece of HTML, on one line. */
function clean(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  copy: "©",
  reg: "®",
  trade: "™",
  euro: "€",
  pound: "£",
  middot: "·",
  bull: "•",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}
