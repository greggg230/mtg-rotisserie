// Fetches card images from Scryfall, always preferring the OLDEST / original
// printing of each card.
//
// Getting the oldest printing without one request per card is the tricky part:
//   - /cards/collection batches, but only ever returns a card's DEFAULT
//     (usually newest) printing and can't be sorted.
//   - unique=cards ignores the sort when choosing WHICH printing to return
//     (it'll happily hand back a 2026 Sol Ring), so it's useless here.
//   - unique=prints + order=released&dir=asc returns every printing of every
//     matched card, oldest first. So we OR a batch of exact names into one
//     query and take the FIRST occurrence of each name — that's its original
//     printing. ~12 cards per request instead of one request per card.
//
// Requests go through a shared gate (spacing + concurrency cap) and are retried
// with backoff. Note that when Scryfall rate-limits you it responds without
// CORS headers, so the browser surfaces it as a thrown fetch rather than a 429 —
// hence thrown fetches are treated as retryable, not as "card not found".
//
// CardLoader streams results as they land and lets the caller re-prioritise the
// queue (the UI pushes on-screen cards to the front), so visible cards fill in
// first and the rest load in the background. Results cache in localStorage.

export interface CardInfo {
  name: string; // Scryfall's canonical name
  set: string | null; // set code of the printing we chose
  released: string | null; // release date of that printing (YYYY-MM-DD)
  image: string | null; // normal-size face image
  backImage: string | null; // back face for double-faced cards
  scryfallUri: string | null;
  found: boolean;
}

const CACHE_KEY = "scryfall-cache-v3-oldest";
const SEARCH_URL = "https://api.scryfall.com/cards/search";
const NAMED_URL = "https://api.scryfall.com/cards/named";

// ---------- Locally-hosted cube images ----------
// scripts/fetch_cube_images.py ships the cube's cards with the site, so the
// common case never touches Scryfall at all — no rate limiting, no dropped
// images, and they're already sized for the board. Anything not in the cube
// (or a card whose local copy fails to load) still goes to the API.
export type LocalCards = Map<string, CardInfo>;

export async function loadLocalCards(baseUrl: string): Promise<LocalCards> {
  const out: LocalCards = new Map();
  try {
    const resp = await fetch(`${baseUrl}cards/index.json`);
    if (!resp.ok) return out;
    const data = await resp.json();
    for (const [key, entry] of Object.entries<any>(data?.cards ?? {})) {
      const [file, name, set, released, collector] = entry as string[];
      if (!file) continue;
      out.set(key, {
        name: name || key,
        set: set || null,
        released: released || null,
        image: `${baseUrl}cards/${file}`,
        backImage: null,
        scryfallUri: set && collector ? `https://scryfall.com/card/${set}/${collector}` : null,
        found: true,
      });
    }
  } catch {
    /* no manifest (dev without a fetch run, or a failed deploy) — use the API */
  }
  return out;
}

// Batching keeps us far under Scryfall's limits, so we can afford to be polite:
// ~8 req/sec ceiling with only a few in flight.
const MIN_GAP_MS = 130;
const MAX_CONCURRENT = 3;
const BATCH_SIZE = 12; // names per search query
const MAX_PAGES = 4; // pages to follow before giving up on a batch
const MAX_ATTEMPTS = 4; // per request, before declaring failure

type Cache = Record<string, CardInfo>;

function loadCache(): Cache {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
  } catch {
    return {};
  }
}

export function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}
const norm = normalizeName;

function imagesFromCard(card: any): { front: string | null; back: string | null } {
  if (card.image_uris) {
    return { front: card.image_uris.normal ?? card.image_uris.large ?? null, back: null };
  }
  if (Array.isArray(card.card_faces)) {
    const front = card.card_faces[0]?.image_uris?.normal ?? null;
    const back = card.card_faces[1]?.image_uris?.normal ?? null;
    return { front, back };
  }
  return { front: null, back: null };
}

function infoFromCard(card: any, fallbackName: string): CardInfo {
  const { front, back } = imagesFromCard(card);
  return {
    name: card.name ?? fallbackName,
    set: card.set ?? null,
    released: card.released_at ?? null,
    image: front,
    backImage: back,
    scryfallUri: card.scryfall_uri ?? null,
    found: true,
  };
}

function notFound(name: string): CardInfo {
  return { name, set: null, released: null, image: null, backImage: null, scryfallUri: null, found: false };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- Rate-limit gate ----------
let active = 0;
let nextSlot = 0; // earliest timestamp the next request may start
const waiting: Array<() => void> = [];

function pump() {
  while (active < MAX_CONCURRENT && waiting.length > 0) {
    const now = Date.now();
    const start = Math.max(now, nextSlot);
    nextSlot = start + MIN_GAP_MS;
    active++;
    const go = waiting.shift()!;
    setTimeout(go, start - now);
  }
}

// Resolves to null on 404 (genuinely no match) and throws on transient failure.
async function apiGet(url: string): Promise<any | null> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(600 * 2 ** (attempt - 1)); // 0.6s, 1.2s, 2.4s
    await new Promise<void>((resolve) => {
      waiting.push(resolve);
      pump();
    });
    try {
      const resp = await fetch(url);
      if (resp.status === 404) return null; // no cards matched — not retryable
      if (!resp.ok) {
        // 429/5xx — back off and try again.
        lastErr = new Error(`HTTP ${resp.status}`);
        continue;
      }
      return await resp.json();
    } catch (e) {
      // Rate-limit responses arrive without CORS headers => thrown. Retryable.
      lastErr = e;
    } finally {
      active--;
      pump();
    }
  }
  throw lastErr ?? new Error("request failed");
}

// ---------- Batched oldest-printing resolution ----------
function buildQuery(names: string[]): string {
  const ors = names.map((n) => `!"${n.replace(/"/g, "")}"`).join(" or ");
  return `(${ors}) game:paper`;
}

function searchUrl(q: string): string {
  return `${SEARCH_URL}?unique=prints&order=released&dir=asc&q=${encodeURIComponent(q)}`;
}

// Resolve a batch of names to their oldest printings in as few requests as
// possible. Returns a map of normalized-name -> CardInfo for everything found.
async function resolveBatch(keys: string[]): Promise<Map<string, CardInfo>> {
  const out = new Map<string, CardInfo>();
  const want = new Set(keys);
  // Face-name matches are a fallback: "Lightning Bolt" shouldn't be claimed by
  // a DFC named "Emeritus of Conflict // Lightning Bolt" if the real card exists.
  const faceMatches = new Map<string, CardInfo>();

  let url: string | null = searchUrl(buildQuery(keys));
  for (let page = 0; page < MAX_PAGES && url && want.size > 0; page++) {
    let data: any;
    try {
      data = await apiGet(url);
    } catch {
      break; // transient failure already retried — leave the rest to fallback
    }
    if (!data || !Array.isArray(data.data)) break;

    // Results are oldest-first, so the first time we see a name is its original.
    for (const card of data.data) {
      const full = norm(card.name ?? "");
      if (want.has(full) && !out.has(full)) {
        out.set(full, infoFromCard(card, card.name));
        want.delete(full);
        continue;
      }
      if (typeof card.name === "string" && card.name.includes("//")) {
        for (const face of card.name.split("//")) {
          const fk = norm(face);
          if (want.has(fk) && !faceMatches.has(fk)) faceMatches.set(fk, infoFromCard(card, face));
        }
      }
    }
    url = data.has_more ? data.next_page : null;
  }

  for (const [k, info] of faceMatches) {
    if (want.has(k)) {
      out.set(k, info);
      want.delete(k);
    }
  }
  return out;
}

// Per-card fallback for anything the batch missed (digital-only cards,
// misspellings, tokens, etc.).
async function resolveOne(key: string): Promise<CardInfo> {
  // Exact name across all games (batch already tried paper-only).
  try {
    const data = await apiGet(searchUrl(`!"${key.replace(/"/g, "")}"`));
    const card = data && Array.isArray(data.data) ? data.data[0] : null;
    if (card) return infoFromCard(card, key);
  } catch {
    /* fall through to fuzzy */
  }
  // Fuzzy name -> canonical name -> oldest printing of that.
  try {
    const named = await apiGet(`${NAMED_URL}?fuzzy=${encodeURIComponent(key)}`);
    if (named?.name) {
      try {
        const data = await apiGet(searchUrl(`!"${String(named.name).replace(/"/g, "")}"`));
        const card = data && Array.isArray(data.data) ? data.data[0] : null;
        if (card) return infoFromCard(card, named.name);
      } catch {
        /* use the fuzzy hit directly */
      }
      return infoFromCard(named, key);
    }
  } catch {
    /* give up */
  }
  return notFound(key);
}

// ---------- Streaming, re-prioritisable loader ----------
export interface LoaderOptions {
  // Called as soon as a card resolves (or immediately, for cache hits).
  onCard: (key: string, info: CardInfo) => void;
  onProgress?: (done: number, total: number) => void;
  local?: LocalCards; // locally-hosted images, consulted before the API
}

export class CardLoader {
  private cache: Cache = loadCache();
  private queue: string[] = []; // pending keys, front = highest priority
  private seen = new Set<string>(); // every key ever added
  private local: LocalCards;
  private refetched = new Set<string>(); // local copies we've already given up on
  private doneCount = 0;
  private total = 0;
  private workers = 0;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private opts: LoaderOptions) {
    this.local = opts.local ?? new Map();
  }

  // Queue names for loading. Local and cached hits are delivered synchronously.
  add(names: string[]) {
    for (const raw of names) {
      const key = norm(raw);
      if (!key || this.seen.has(key)) continue;
      this.seen.add(key);
      this.total++;
      const hit = this.local.get(key) ?? this.cache[key];
      if (hit) {
        this.doneCount++;
        this.opts.onCard(key, hit);
      } else {
        this.queue.push(key);
      }
    }
    this.opts.onProgress?.(this.doneCount, this.total);
    this.spawn();
  }

  // A local copy that won't load (missing file, half-finished deploy) shouldn't
  // leave a hole in the board — drop it and resolve that card from the API.
  // Once per card, so a genuinely broken image can't loop.
  refetch(name: string) {
    const key = norm(name);
    if (this.refetched.has(key)) return;
    this.refetched.add(key);
    this.local.delete(key);
    delete this.cache[key];
    this.doneCount = Math.max(0, this.doneCount - 1);
    this.queue.unshift(key);
    this.opts.onProgress?.(this.doneCount, this.total);
    this.spawn();
  }

  // Move these names to the front of the queue, in the order given. Names
  // already loaded or in flight are ignored. Cheap enough to call on scroll.
  prioritize(names: string[]) {
    if (this.queue.length === 0) return;
    const queued = new Set(this.queue);
    const front: string[] = [];
    const wanted = new Set<string>();
    for (const raw of names) {
      const key = norm(raw);
      if (queued.has(key) && !wanted.has(key)) {
        wanted.add(key);
        front.push(key);
      }
    }
    if (front.length === 0) return;
    this.queue = [...front, ...this.queue.filter((k) => !wanted.has(k))];
  }

  private spawn() {
    while (this.workers < MAX_CONCURRENT && this.queue.length > 0) {
      this.workers++;
      void this.work();
    }
  }

  private async work() {
    try {
      while (this.queue.length > 0) {
        // Taking from the front preserves the priority ordering.
        const batch = this.queue.splice(0, BATCH_SIZE);
        let found = new Map<string, CardInfo>();
        try {
          found = await resolveBatch(batch);
        } catch {
          /* fall through: each miss retried individually below */
        }
        for (const key of batch) {
          let info = found.get(key);
          if (!info) {
            try {
              info = await resolveOne(key);
            } catch {
              info = notFound(key);
            }
          }
          this.cache[key] = info;
          this.doneCount++;
          this.opts.onCard(key, info);
          this.opts.onProgress?.(this.doneCount, this.total);
        }
        this.scheduleSave();
      }
    } finally {
      // Must always run, or a stray error would silently retire the worker.
      this.workers--;
    }
  }

  // Batch localStorage writes — serialising the whole cache per card is wasteful.
  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(this.cache));
      } catch {
        /* quota — ignore */
      }
    }, 500);
  }
}
