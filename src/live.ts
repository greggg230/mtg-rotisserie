// Live spectator view of a draft run by the rotisserie queue app:
//
//   ?draft=<id>                    the draft's id in the app (rotisserie.greggg230.com/d/<id>)
//   &app=<origin or /path>         which app to ask (default: the production one)
//   &sheet=<id|url>                optional: read the sheet directly if the app can't be reached
//
// Where the review screen replays a finished draft one pick at a time, this
// follows one that's still being drafted: the whole grid at once, new picks
// highlighted as they land, and the picker's reason for each card on hover —
// or on tap, since most people watching are on a phone.
//
// Data comes from the app's GET /api/drafts/<id>/picks rather than from the
// sheet plus a second request for the reasons. The app already reads the sheet
// (cached, so a room full of spectators costs Google one read), it numbers
// seats and rounds exactly the way the reasons are keyed, and it has already
// matched each reason to the card actually in its cell. One response is one
// consistent snapshot; two sources polled separately could disagree about
// which card a reason belongs to. The sheet is only a fallback, for when the
// app can't be reached and a `&sheet=` was given: the grid keeps moving, the
// reasons wait for the app to come back.

import { parseTable } from "./csv";
import { buildDraft, playerColor } from "./draft";
import { escapeHtml } from "./html";
import { CardLoader, normalizeName, type CardInfo, type LocalCards } from "./scryfall";
import { fetchSheetCsv, parseSheetRef, resolveSheet, type SheetRef } from "./sheets";

export const DEFAULT_APP = "https://rotisserie.greggg230.com";

const POLL_MS = 30_000; // a pick lands every minute or so; this is plenty
const DONE_POLL_MS = 5 * 60_000; // a finished draft can still be corrected
const MAX_RETRY_MS = 2 * 60_000;
const FETCH_TIMEOUT_MS = 15_000;
const FRESH_MS = 6_000; // how long a just-landed pick glows

export interface LiveOptions {
  draftId: string;
  app: string | null;
  sheet: string | null;
  tab: string | null;
  gid: string | null;
  doubleAfter?: number | null;
  localCards: Promise<LocalCards>;
  onExit: () => void;
}

export interface LiveHandle {
  stop(): void;
}

interface LivePick {
  pickNumber: number;
  round: number;
  seat: number;
  cardName: string;
  turn: number;
  note: string | null;
  /** When the pick was made (ms), from its note; null when the app didn't say. */
  at: number | null;
}

// "ok": the app serves reasons (a null note means none was given).
// "unsupported": an app from before reasons existed. "failed": the app does,
// but couldn't read them this time. "sheet": the picks came from the sheet.
type NotesState = "ok" | "unsupported" | "failed" | "sheet";

interface Feed {
  draftName: string;
  players: string[];
  doubleAfter: number | null;
  totalRounds: number | null;
  upNow: { seat: number; round: number } | null;
  order: LivePick[];
  notes: NotesState;
}

class FeedError extends Error {
  constructor(
    message: string,
    readonly retry: boolean,
  ) {
    super(message);
  }
}

const key = (seat: number, round: number) => `${seat}:${round}`;
const cellId = (seat: number, round: number) => `lc-${seat}-${round}`;

function appBase(raw: string | null): string {
  const s = (raw ?? "").trim().replace(/\/+$/, "");
  if (!s) return DEFAULT_APP;
  if (s.startsWith("/")) return s; // same-origin path, e.g. the dev proxy
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}

// ---------- Reading the app ----------

const int = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);

/**
 * Did `a` happen after `b`?
 *
 * Pick numbers count grid positions, not time, and the two part ways whenever a
 * conspiracy picks out of turn: Quantity Over Quality puts a card in round 38
 * during round 1, and by position that card stays "the latest pick" all draft.
 * When the app sends each pick's time, that wins.
 */
function later(a: LivePick, b: LivePick): boolean {
  if (a.at !== null && b.at !== null) return a.at > b.at;
  if (a.at !== null || b.at !== null) return a.at !== null;
  return a.pickNumber > b.pickNumber;
}

/** The cells of the most recent turn: by time when the app sends it, else by grid order. */
function mostRecentTurn(order: LivePick[]): Set<string> {
  const last = order.reduce<LivePick | null>((m, p) => (!m || later(p, m) ? p : m), null);
  if (!last) return new Set();
  return new Set(order.filter((p) => p.turn === last.turn && p.seat === last.seat).map((p) => key(p.seat, p.round)));
}

// The response is someone else's JSON: take what makes sense, drop the rest.
function parseFeed(data: unknown): Feed {
  const d = (data ?? {}) as Record<string, unknown>;
  if (!Array.isArray(d.players) || !Array.isArray(d.order)) {
    throw new FeedError("The draft app sent something that isn't a pick list.", true);
  }
  const players = d.players.map((p) => String(p ?? "").trim() || "?");
  let sawNotes = typeof d.notesRead === "boolean";
  const order: LivePick[] = [];
  for (const raw of d.order as unknown[]) {
    const p = (raw ?? {}) as Record<string, unknown>;
    const seat = int(p.seat);
    const round = int(p.round);
    const cardName = typeof p.cardName === "string" ? p.cardName.trim() : "";
    if (seat === null || round === null || seat < 0 || seat >= players.length || round < 1 || !cardName) continue;
    if ("note" in p) sawNotes = true;
    const note = typeof p.note === "string" && p.note.trim() ? p.note.trim() : null;
    const at = int(p.at);
    order.push({ pickNumber: int(p.pickNumber) ?? 0, round, seat, cardName, turn: int(p.turn) ?? -1, note, at });
  }
  const up = (d.upNow ?? null) as Record<string, unknown> | null;
  const upSeat = up ? int(up.seat) : null;
  const upRound = up ? int(up.round) : null;
  return {
    draftName: typeof d.draftName === "string" && d.draftName.trim() ? d.draftName.trim() : "Rotisserie Draft",
    players,
    doubleAfter: int(d.doubleAfter),
    totalRounds: int(d.totalRounds),
    upNow: upSeat !== null && upRound !== null ? { seat: upSeat, round: upRound } : null,
    order,
    notes: d.notesRead === false ? "failed" : sawNotes ? "ok" : "unsupported",
  };
}

async function fetchAppFeed(app: string, draftId: string): Promise<Feed> {
  const url = `${app}/api/drafts/${encodeURIComponent(draftId)}/picks`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    // No credentials: this is a public read, and the app only allows it
    // cross-origin on those terms. No browser cache either: a copy the
    // browser was told it could keep for hours froze the draft mid-round.
    res = await fetch(url, { credentials: "omit", cache: "no-store", signal: ctl.signal });
  } catch {
    // A refused cross-origin read and a dead network look the same from here.
    throw new FeedError(
      ctl.signal.aborted
        ? "The draft app took too long to answer."
        : "Couldn't reach the draft app (it may be down, or not yet sharing picks with this site).",
      true,
    );
  } finally {
    clearTimeout(timer);
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON — reported below by status, or as a bad pick list */
  }
  if (!res.ok) {
    const said = (body as { error?: unknown } | null)?.error;
    const message = typeof said === "string" && said ? said : `The draft app answered ${res.status}.`;
    // A wrong id or a draft with no sheet won't fix itself by asking again.
    throw new FeedError(message, res.status >= 500 || res.status === 429);
  }
  return parseFeed(body);
}

// The sheet marks whose turn it is by decorating that player's heading
// ("◈  Bot 1  ◈"), and the marker moves. The app strips it; do the same.
function tidyName(name: string): string {
  return name.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").trim() || name.trim();
}

function feedFromSheet(csv: string, doubleAfter: number | null | undefined): Feed {
  const draft = buildDraft(parseTable(csv), { doubleAfter });
  if (draft.players.length < 2) throw new FeedError("The sheet doesn't look like a draft.", true);
  return {
    draftName: draft.title,
    players: draft.players.map((p) => tidyName(p.name)),
    doubleAfter: draft.doubleAfter,
    totalRounds: null,
    upNow: null,
    order: draft.order.map((p) => ({
      pickNumber: p.pickNumber,
      round: p.round,
      seat: p.playerIndex,
      cardName: p.cardName,
      turn: p.turn,
      note: null,
      at: null,
    })),
    notes: "sheet",
  };
}

// ---------- The view ----------

export function startLive(app: HTMLElement, opts: LiveOptions): LiveHandle {
  const base = appBase(opts.app);
  const sheetRef: SheetRef | null = opts.sheet
    ? (() => {
        const r = parseSheetRef(opts.sheet);
        return r ? { ...r, gid: opts.gid ?? r.gid, tab: opts.tab } : null;
      })()
    : null;
  let resolvedSheet: SheetRef | null = null;

  let feed: Feed | null = null;
  let source: "app" | "sheet" | null = null;
  let lastOk = 0; // when the picks on screen were read
  let error: FeedError | null = null; // the app's, when the last attempt failed
  let failures = 0;
  let stopped = false;
  let inflight = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastAttempt = 0;
  // Reasons seen from the app, kept so a stretch on the sheet fallback
  // doesn't blank the ones already on screen. Keyed by cell, with the card
  // they were given for.
  const knownNotes = new Map<string, { card: string; note: string }>();

  // What the grid showed last time, to tell which picks just landed.
  let shown: Map<string, string> | null = null; // cell -> normalized card
  let latest = new Set<string>(); // cells highlighted as the most recent turn
  let latestPick: LivePick | null = null;

  let hoverKey: string | null = null;
  let pinnedKey: string | null = null;
  let tipKey: string | null = null;
  let hoverClear: ReturnType<typeof setTimeout> | null = null;
  let sheetScrolled = false; // the bottom sheet has already nudged its card clear

  const infoByKey = new Map<string, CardInfo>(); // normalized name -> resolved image
  let loader: CardLoader | null = null;
  let observer: IntersectionObserver | null = null;
  let chromeRO: ResizeObserver | null = null;
  const sheetMode = window.matchMedia("(max-width: 640px)");
  const savedTitle = document.title;

  document.documentElement.classList.add("live");
  app.innerHTML = `
    <div class="appbar">
      <div class="topbar live-top">
        <button id="back" class="ghost small">&larr; New</button>
        <h1 class="title" id="ltitle">Loading draft…</h1>
        <span class="livepill" id="lpill">Live</span>
        <div class="meta" id="lmeta"></div>
        <button id="lrefresh" class="ghost small" title="Check for new picks now">&#x21bb; Refresh</button>
      </div>
      <div id="lnotice" class="lnotice" hidden></div>
      <div id="loadbar" class="hidden"><div id="loadbar-inner"></div><span id="loadbar-label"></span></div>
    </div>
    <div class="lpane" id="lpane">
      <div class="lgrid" id="lgrid"></div>
      <p class="lempty" id="lempty">Reading the draft…</p>
    </div>
    <div class="scrubber nowbar">
      <button id="lnow" class="lnow readout" type="button"></button>
      <div class="lnext" id="lnext"></div>
    </div>
    <div id="tip" class="tip" role="dialog" aria-label="Pick details" hidden></div>`;

  const $ = <T extends HTMLElement>(sel: string) => app.querySelector<T>(sel)!;
  const pane = $<HTMLDivElement>("#lpane");
  const grid = $<HTMLDivElement>("#lgrid");
  const tip = $<HTMLDivElement>("#tip");
  const empty = $<HTMLParagraphElement>("#lempty");

  $("#back").addEventListener("click", () => opts.onExit());
  $("#lrefresh").addEventListener("click", () => {
    failures = 0;
    void poll();
  });
  $("#lnow").addEventListener("click", () => {
    if (!latestPick) return;
    pinnedKey = key(latestPick.seat, latestPick.round);
    hoverKey = null;
    sheetScrolled = true; // this scroll does the job the sheet's nudge would
    renderTip();
    document
      .getElementById(cellId(latestPick.seat, latestPick.round))
      ?.querySelector(".lcard")
      ?.scrollIntoView({ block: sheetMode.matches ? "start" : "nearest", inline: "nearest", behavior: "smooth" });
  });

  // ---------- chrome ----------
  function measureChrome() {
    const root = document.documentElement;
    root.style.setProperty("--header-h", `${$(".appbar").offsetHeight}px`);
    root.style.setProperty("--scrub-h", `${$(".nowbar").offsetHeight}px`);
    root.style.setProperty("--hbar-h", "0px"); // the window never scrolls here
    placeTip();
  }
  chromeRO = new ResizeObserver(measureChrome);
  chromeRO.observe($(".appbar"));
  chromeRO.observe($(".nowbar"));
  window.addEventListener("resize", measureChrome);
  measureChrome();

  // ---------- images ----------
  void opts.localCards.then((local) => {
    if (stopped) return;
    const bar = $<HTMLDivElement>("#loadbar-inner");
    const label = $<HTMLSpanElement>("#loadbar-label");
    const loadbar = $<HTMLDivElement>("#loadbar");
    loader = new CardLoader({
      local,
      onCard: (k, info) => {
        infoByKey.set(k, info);
        for (const el of grid.querySelectorAll<HTMLElement>(`.lcard[data-nkey="${CSS.escape(k)}"]`)) fill(el, info);
        if (tipKey) renderTip();
      },
      onProgress: (done, total) => {
        bar.style.width = (total ? Math.round((done / total) * 100) : 100) + "%";
        loadbar.classList.toggle("hidden", done >= total);
        label.textContent = `Loading card images… ${done}/${total}`;
      },
    });
    observer = new IntersectionObserver(
      (entries) => {
        const names = entries
          .filter((e) => e.isIntersecting)
          .map((e) => (e.target as HTMLElement).dataset.name ?? "")
          .filter(Boolean);
        if (names.length) loader?.prioritize(names);
      },
      { root: pane, rootMargin: "300px" },
    );
    const cards = [...grid.querySelectorAll<HTMLElement>(".lcard")];
    for (const el of cards) observer.observe(el);
    loader.add(visibleNames());
    loader.add(cards.map((el) => el.dataset.name ?? ""));
  });

  function visibleNames(): string[] {
    const box = pane.getBoundingClientRect();
    const out: string[] = [];
    for (const el of grid.querySelectorAll<HTMLElement>(".lcard")) {
      const r = el.getBoundingClientRect();
      if (r.bottom > box.top - 300 && r.top < box.bottom + 300 && r.right > box.left - 300 && r.left < box.right + 300) {
        out.push(el.dataset.name ?? "");
      }
    }
    return out;
  }

  function fill(el: HTMLElement, info: CardInfo) {
    const wrap = el.querySelector<HTMLDivElement>(".cardimg");
    if (!wrap || wrap.dataset.filled === "1") return;
    wrap.dataset.filled = "1";
    wrap.classList.remove("skeleton");
    if (!info.image) {
      wrap.classList.add("noimg");
      wrap.textContent = el.dataset.name || info.name;
      return;
    }
    const img = document.createElement("img");
    img.src = info.image;
    img.alt = el.dataset.name || info.name;
    img.loading = "lazy";
    img.decoding = "async";
    // A locally-hosted copy that won't load goes back to Scryfall, once.
    img.addEventListener("error", () => {
      img.remove();
      wrap.dataset.filled = "";
      wrap.classList.add("skeleton");
      infoByKey.delete(el.dataset.nkey ?? "");
      loader?.refetch(el.dataset.name || info.name);
    });
    wrap.appendChild(img);
  }

  // ---------- the grid ----------
  // One cell per seat and round, so a row reads as a round across the table.
  // Rendered once and patched on every refresh — never rebuilt — so scroll
  // position, focus and an open tooltip all survive new picks arriving.
  function nextCells(f: Feed): Set<string> {
    const out = new Set<string>();
    if (!f.upNow) return out;
    const { seat, round } = f.upNow;
    // Once doubling starts a turn is two cells; mark both while they're empty.
    const doubled = f.doubleAfter !== null && round > f.doubleAfter;
    const first = doubled ? round - ((round - f.doubleAfter! - 1) % 2) : round;
    const rounds = doubled ? [first, first + 1] : [round];
    for (const r of rounds) if (!(f.totalRounds && r > f.totalRounds)) out.add(key(seat, r));
    return out;
  }

  function cardHtml(p: LivePick, color: string): string {
    const who = feed!.players[p.seat] ?? "";
    return `
      <div class="card lcard" tabindex="0" data-key="${key(p.seat, p.round)}" data-name="${escapeHtml(p.cardName)}"
        data-nkey="${escapeHtml(normalizeName(p.cardName))}" style="--pc:${color}"
        aria-label="${escapeHtml(`Pick ${p.pickNumber}, ${who}: ${p.cardName}`)}">
        <div class="cardimg skeleton"></div>
        <div class="badge">#${p.pickNumber}</div>
        ${p.note ? NOTE_MARK : ""}
      </div>`;
  }

  function renderGrid(f: Feed, first: boolean) {
    const P = f.players.length;
    const sameSeats =
      grid.dataset.players === JSON.stringify(f.players) && grid.childElementCount > 0;
    if (!sameSeats) {
      // A seat added or renamed mid-draft: rebuild, but keep the scroll.
      const { scrollTop, scrollLeft } = pane;
      grid.innerHTML =
        `<div class="lcorner"></div>` +
        f.players
          .map(
            (name, i) => `
          <div class="lhead" style="grid-column:${i + 2}">
            <div class="phead" style="background:${playerColor(i)}" title="${escapeHtml(name)}">
              <span class="pname">${escapeHtml(name)}</span>
              <span class="pcount" id="lpc-${i}"></span>
            </div>
          </div>`,
          )
          .join("");
      grid.dataset.players = JSON.stringify(f.players);
      grid.dataset.rows = "0";
      grid.style.setProperty("--players", String(P));
      pane.scrollTop = scrollTop;
      pane.scrollLeft = scrollLeft;
    }

    const cells = new Map<string, LivePick>();
    let maxRound = 0;
    for (const p of f.order) {
      cells.set(key(p.seat, p.round), p);
      maxRound = Math.max(maxRound, p.round);
    }
    const next = nextCells(f);
    for (const k of next) maxRound = Math.max(maxRound, Number(k.split(":")[1]));
    const rows = Math.max(maxRound, 1);

    // Grow (or, after a correction, shrink) to the rounds in play.
    let have = Number(grid.dataset.rows || 0);
    for (; have < rows; have++) {
      const r = have + 1;
      const row = document.createDocumentFragment();
      const label = document.createElement("div");
      label.className = "lround";
      label.dataset.row = String(r);
      label.style.gridRow = String(r + 1);
      label.textContent = String(r);
      if (f.doubleAfter !== null && r > f.doubleAfter) label.classList.add("dbl");
      row.appendChild(label);
      for (let s = 0; s < P; s++) {
        const cell = document.createElement("div");
        cell.className = "lcell";
        cell.id = cellId(s, r);
        cell.dataset.row = String(r);
        cell.style.gridRow = String(r + 1);
        cell.style.gridColumn = String(s + 2);
        row.appendChild(cell);
      }
      grid.appendChild(row);
    }
    for (; have > rows; have--) {
      for (const el of grid.querySelectorAll<HTMLElement>(`[data-row="${have}"]`)) el.remove();
    }
    grid.dataset.rows = String(rows);

    // Which picks just landed: anything in a cell that held something else,
    // or nothing, last time. The first read has no "last time" — its most
    // recent turn stands in.
    const now = new Map<string, string>();
    for (const [k, p] of cells) now.set(k, normalizeName(p.cardName));
    const arrived = shown ? [...now.keys()].filter((k) => shown!.get(k) !== now.get(k)) : [];
    if (arrived.length) {
      latest = new Set(arrived);
    } else if (!shown || [...latest].some((k) => !cells.has(k))) {
      latest = mostRecentTurn(f.order);
    }
    const newest = [...latest].map((k) => cells.get(k)!).filter(Boolean);
    latestPick = newest.reduce<LivePick | null>((m, p) => (!m || later(p, m) ? p : m), null);
    shown = now;

    const added: HTMLElement[] = [];
    for (let r = 1; r <= rows; r++) {
      for (let s = 0; s < P; s++) {
        const k = key(s, r);
        const cell = document.getElementById(cellId(s, r));
        if (!cell) continue;
        const p = cells.get(k);
        const color = playerColor(s);
        // Rows past the draft's last round only exist for a seat granted extra
        // picks; the other seats' cells there are not picks anyone is owed.
        const sig = p
          ? `c|${p.cardName}|${p.pickNumber}|${p.note ? 1 : 0}`
          : next.has(k)
            ? "next"
            : f.totalRounds && r > f.totalRounds
              ? "none"
              : "empty";
        if (cell.dataset.sig !== sig) {
          const wasName = cell.dataset.sig?.split("|")[1];
          if (p && wasName === p.cardName) {
            // Same card, renumbered or newly explained: patch in place so the
            // image doesn't reload.
            const el = cell.querySelector<HTMLElement>(".lcard")!;
            el.querySelector(".badge")!.textContent = `#${p.pickNumber}`;
            el.setAttribute("aria-label", `Pick ${p.pickNumber}, ${f.players[p.seat] ?? ""}: ${p.cardName}`);
            el.querySelector(".notemark")?.remove();
            if (p.note) el.insertAdjacentHTML("beforeend", NOTE_MARK);
          } else if (p) {
            cell.innerHTML = cardHtml(p, color);
            const el = cell.firstElementChild as HTMLElement;
            const info = infoByKey.get(el.dataset.nkey ?? "");
            if (info) fill(el, info);
            added.push(el);
          } else if (sig === "next") {
            cell.innerHTML = `<div class="lslot next" style="--pc:${color}"><span>Up next</span></div>`;
          } else if (sig === "none") {
            cell.innerHTML = "";
          } else {
            cell.innerHTML = `<div class="lslot"></div>`;
          }
          cell.dataset.sig = sig;
        }
        const card = cell.querySelector<HTMLElement>(".lcard");
        if (card) {
          card.classList.toggle("current", latest.has(k));
          if (!first && arrived.includes(k)) {
            card.classList.remove("fresh");
            void card.offsetWidth; // restart the glow if it's already running
            card.classList.add("fresh");
            setTimeout(() => card.classList.remove("fresh"), FRESH_MS);
          }
        }
      }
    }

    // Per-seat counts, as the review screen shows them.
    const counts = new Array(P).fill(0);
    for (const p of f.order) counts[p.seat]++;
    counts.forEach((c, i) => {
      const el = document.getElementById(`lpc-${i}`);
      if (el) el.textContent = String(c);
    });

    if (added.length && loader && observer) {
      for (const el of added) observer.observe(el);
      loader.add(added.map((el) => el.dataset.name ?? ""));
    }
    empty.hidden = true;
  }

  // ---------- status ----------
  function complete(f: Feed): boolean {
    if (f.totalRounds && f.order.length >= f.players.length * f.totalRounds) return true;
    return source === "app" && f.order.length > 0 && f.upNow === null;
  }

  function ago(ms: number): string {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 5) return "just now";
    if (s < 60) return `${s}s ago`;
    const m = Math.round(s / 60);
    return m < 60 ? `${m} min ago` : new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  function renderMeta() {
    const meta = $("#lmeta");
    const f = feed;
    if (f) {
      const total = f.totalRounds ? f.players.length * f.totalRounds : null;
      meta.textContent = [
        `${f.players.length} players`,
        // Conspiracies can grant extra picks past the last round.
        total && f.order.length <= total ? `${f.order.length} of ${total} picks` : `${f.order.length} picks`,
        f.doubleAfter ? `double picks after round ${f.doubleAfter}` : "",
        lastOk ? `updated ${ago(lastOk)}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
    } else {
      meta.textContent = error ? "" : "Reading the draft…";
    }
  }

  function renderStatus() {
    const pill = $("#lpill");
    const notice = $("#lnotice");
    const f = feed;
    const done = f ? complete(f) : false;

    pill.classList.toggle("done", done && !error);
    pill.classList.toggle("warn", !!error);
    pill.textContent = error ? (error.retry ? "Retrying" : "Stopped") : done ? "Complete" : "Live";
    if (f) $("#ltitle").textContent = f.draftName;
    renderMeta();

    let msg = "";
    if (error && f) {
      msg =
        source === "sheet"
          ? `The draft app can't be reached, so this is read straight from the sheet — rationales will show again once it's back. (${error.message})`
          : `${error.message} Showing picks as of ${new Date(lastOk).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}${error.retry ? " — trying again shortly." : "."}`;
    } else if (f?.notes === "unsupported") {
      msg = "This draft app doesn't share pick rationales yet — showing picks only.";
    } else if (f?.notes === "failed") {
      msg = "Couldn't load the rationales just now; they'll be back on the next refresh.";
    }
    notice.textContent = msg;
    notice.hidden = !msg;

    if (!f) {
      empty.hidden = false;
      empty.textContent = error
        ? `Couldn't load this draft: ${error.message}${error.retry ? " Trying again shortly…" : ""}`
        : "Reading the draft…";
    }

    // The bottom bar narrates the newest turn, like the review's scrubber.
    const now = $<HTMLButtonElement>("#lnow");
    const nextEl = $("#lnext");
    if (f && latestPick) {
      const turn = f.order
        .filter((p) => p.seat === latestPick!.seat && (p.turn === latestPick!.turn || p === latestPick))
        .sort((a, b) => a.pickNumber - b.pickNumber);
      const span = (a: number[]) => (a.length > 1 ? `${a[0]}–${a[a.length - 1]}` : `${a[0]}`);
      now.innerHTML =
        `<span class="rpick">${turn.length > 1 ? "Picks" : "Pick"} ${span(turn.map((p) => p.pickNumber))}</span>` +
        `<span class="rround">${turn.length > 1 ? "Rounds" : "Round"} ${span(turn.map((p) => p.round))}</span>` +
        `<span class="rdot" style="background:${playerColor(latestPick.seat)}"></span>` +
        `<span class="rplayer">${escapeHtml(f.players[latestPick.seat] ?? "")}</span>` +
        `<span class="rarrow">took</span>` +
        `<span class="rcard">${turn.map((p) => escapeHtml(p.cardName)).join(" + ")}</span>`;
      now.disabled = false;
      now.title = "Show this pick";
    } else {
      now.innerHTML = `<span class="muted">${f ? "Waiting for the first pick" : "—"}</span>`;
      now.disabled = true;
    }
    if (f?.upNow && !done) {
      nextEl.innerHTML = `<span class="muted">Up next</span> <span class="rdot" style="background:${playerColor(f.upNow.seat)}"></span> <b>${escapeHtml(f.players[f.upNow.seat] ?? "")}</b>`;
    } else {
      nextEl.innerHTML = done ? `<span class="muted">Draft complete</span>` : "";
    }

    if (f) document.title = `${f.draftName} · ${f.order.length} picks · live`;
  }
  const clock = setInterval(() => {
    if (feed && lastOk) renderMeta();
  }, 5_000);

  // ---------- polling ----------
  async function read(): Promise<{ feed: Feed; from: "app" | "sheet" }> {
    try {
      const f = await fetchAppFeed(base, opts.draftId);
      return { feed: f, from: "app" };
    } catch (e) {
      const err = e instanceof FeedError ? e : new FeedError(String(e), true);
      if (!sheetRef || !err.retry) throw err;
      // The app is unreachable but we know the sheet: keep the grid moving.
      try {
        if (!resolvedSheet) resolvedSheet = (await resolveSheet(sheetRef)).ref;
        const csv = await fetchSheetCsv(resolvedSheet);
        const f = feedFromSheet(csv, opts.doubleAfter);
        if (feed) f.draftName = feed.draftName;
        for (const p of f.order) {
          const kept = knownNotes.get(key(p.seat, p.round));
          if (kept && kept.card === normalizeName(p.cardName)) p.note = kept.note;
        }
        error = err; // still worth saying: the reasons are missing
        return { feed: f, from: "sheet" };
      } catch {
        throw err; // the app's failure is the one worth reporting
      }
    }
  }

  async function poll() {
    if (stopped || inflight) return;
    inflight = true;
    lastAttempt = Date.now();
    if (timer) clearTimeout(timer);
    timer = null;
    try {
      error = null;
      const { feed: f, from } = await read();
      if (stopped) return;
      const first = !feed;
      feed = f;
      source = from;
      lastOk = Date.now();
      // Any successful read resets the backoff: on the sheet fallback the
      // grid still moves, and one attempt at the app per poll is no burden.
      failures = 0;
      if (from === "app") {
        for (const p of f.order) {
          if (p.note) knownNotes.set(key(p.seat, p.round), { card: normalizeName(p.cardName), note: p.note });
        }
      }
      renderGrid(f, first);
      if (tipKey) renderTip();
    } catch (e) {
      if (stopped) return;
      error = e instanceof FeedError ? e : new FeedError(String(e), true);
      failures++;
    } finally {
      inflight = false;
    }
    renderStatus();
    schedule();
  }

  function schedule() {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = null;
    if (error && !error.retry) return; // a wrong id; ↻ tries again on demand
    if (document.hidden) return; // resumed by visibilitychange
    let wait = POLL_MS;
    if (failures > 0) wait = Math.min(MAX_RETRY_MS, POLL_MS * 2 ** (failures - 1));
    else if (feed && complete(feed)) wait = DONE_POLL_MS;
    timer = setTimeout(poll, wait);
  }

  // Nobody is watching a hidden tab or a locked phone: stop asking, and catch
  // up the moment it's looked at again.
  function onVisibility() {
    if (document.hidden) {
      if (timer) clearTimeout(timer);
      timer = null;
    } else if (Date.now() - lastAttempt >= POLL_MS) {
      void poll();
    } else {
      schedule();
    }
  }
  document.addEventListener("visibilitychange", onVisibility);

  // ---------- the reason, on hover or tap ----------
  function pickAt(k: string | null): LivePick | null {
    if (!k || !feed) return null;
    const [s, r] = k.split(":").map(Number);
    return feed.order.find((p) => p.seat === s && p.round === r) ?? null;
  }

  function noteHtml(p: LivePick): string {
    if (p.note) return `<p class="tip-note">${escapeHtml(p.note)}</p>`;
    const why: Record<NotesState, string> = {
      ok: "No rationale was recorded for this pick.",
      unsupported: "Rationales aren't available from the draft app yet.",
      failed: "Couldn't load the rationale for this pick just now.",
      sheet: "The rationale will show once the draft app is reachable again.",
    };
    return `<p class="tip-none">${why[feed!.notes]}</p>`;
  }

  // Shows whichever pick is hovered, else whichever is pinned. Called again
  // after every refresh, so an open tooltip stays open on the same pick and
  // picks up a rationale that arrived since.
  function renderTip() {
    const k = hoverKey ?? pinnedKey;
    const p = pickAt(k);
    for (const el of grid.querySelectorAll(".lcard.shown")) el.classList.remove("shown");
    if (!p) {
      if (k === pinnedKey) pinnedKey = null; // that pick is gone
      tipKey = null;
      tip.hidden = true;
      grid.style.paddingBottom = "";
      return;
    }
    const color = playerColor(p.seat);
    const info = infoByKey.get(normalizeName(p.cardName));
    const html = `
      <div class="tip-head">
        <span class="rdot" style="background:${color}"></span>
        <span class="tip-who">${escapeHtml(feed!.players[p.seat] ?? "")}</span>
        <span class="tip-when">Round ${p.round} · Pick ${p.pickNumber}</span>
        <button class="tip-x" type="button" aria-label="Close">&times;</button>
      </div>
      <div class="tip-body">
        ${info?.image ? `<img class="tip-img" src="${escapeHtml(info.image)}" alt="" />` : ""}
        <div class="tip-text">
          <div class="tip-card">${escapeHtml(p.cardName)}</div>
          ${noteHtml(p)}
          ${info?.scryfallUri ? `<a class="tip-link" href="${escapeHtml(info.scryfallUri)}" target="_blank" rel="noopener">Scryfall &#x2197;</a>` : ""}
        </div>
      </div>`;
    if (tip.dataset.html !== html) {
      tip.innerHTML = html;
      tip.dataset.html = html;
    }
    tip.style.setProperty("--pc", color);
    tip.classList.toggle("pinned", pinnedKey === k);
    tipKey = k;
    tip.hidden = false;
    document.getElementById(cellId(p.seat, p.round))?.querySelector(".lcard")?.classList.add("shown");
    placeTip();
  }

  function placeTip() {
    if (tip.hidden || !tipKey) return;
    const [s, r] = tipKey.split(":").map(Number);
    const cell = document.getElementById(cellId(s, r));
    if (!cell) return;
    if (sheetMode.matches) {
      // A bottom sheet on a phone. Leave room under the grid so the card it's
      // about can always be scrolled clear of it.
      tip.style.left = tip.style.top = "";
      tip.style.visibility = "";
      grid.style.paddingBottom = `${tip.offsetHeight + 16}px`;
      const rect = cell.getBoundingClientRect();
      const over = rect.bottom - (window.innerHeight - tip.offsetHeight) + 12;
      if (over > 0 && !sheetScrolled) {
        sheetScrolled = true;
        pane.scrollBy({ top: over, behavior: "smooth" });
      }
      return;
    }
    grid.style.paddingBottom = "";
    const r0 = cell.getBoundingClientRect();
    const box = pane.getBoundingClientRect();
    const head = grid.querySelector<HTMLElement>(".lcorner")?.offsetHeight ?? 0;
    const gutter = grid.querySelector<HTMLElement>(".lcorner")?.offsetWidth ?? 0;
    const inView =
      r0.bottom > box.top + head && r0.top < box.bottom && r0.right > box.left + gutter && r0.left < box.right;
    tip.style.visibility = inView ? "" : "hidden";
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const gap = 10;
    const cardRight = r0.left + (cell.querySelector<HTMLElement>(".lcard")?.offsetWidth ?? r0.width);
    let left = cardRight + gap;
    if (left + tw > window.innerWidth - 8) left = r0.left - gap - tw;
    if (left < 8) left = Math.min(Math.max(8, r0.left), window.innerWidth - tw - 8);
    const top = Math.max(box.top + 8, Math.min(r0.top, box.bottom - th - 8));
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  }

  const cardOf = (t: EventTarget | null) => (t instanceof Element ? t.closest<HTMLElement>(".lcard") : null);
  const cancelHoverClear = () => {
    if (hoverClear) clearTimeout(hoverClear);
    hoverClear = null;
  };
  const clearHoverSoon = () => {
    cancelHoverClear();
    // A beat's grace, so the pointer can cross the gap into the tooltip.
    hoverClear = setTimeout(() => {
      hoverClear = null;
      hoverKey = null;
      renderTip();
    }, 150);
  };
  const close = () => {
    cancelHoverClear();
    hoverKey = null;
    pinnedKey = null;
    renderTip();
  };
  const toggle = (k: string) => {
    cancelHoverClear();
    pinnedKey = pinnedKey === k ? null : k;
    // A tap has no hover to fall back on, so closing it closes it.
    if (pinnedKey === null) hoverKey = null;
    sheetScrolled = false;
    renderTip();
  };

  // Hover is for a mouse only. A touch fires pointerover too, just before its
  // click — acting on both would open and immediately toggle shut.
  pane.addEventListener("pointerover", (e) => {
    if (e.pointerType !== "mouse") return;
    const card = cardOf(e.target);
    if (!card) return;
    cancelHoverClear();
    if (hoverKey !== card.dataset.key) {
      hoverKey = card.dataset.key ?? null;
      renderTip();
    }
  });
  pane.addEventListener("pointerout", (e) => {
    if (e.pointerType !== "mouse") return;
    const from = cardOf(e.target);
    if (from && from !== cardOf(e.relatedTarget)) clearHoverSoon();
  });
  tip.addEventListener("pointerenter", (e) => {
    if (e.pointerType === "mouse") cancelHoverClear();
  });
  tip.addEventListener("pointerleave", (e) => {
    if (e.pointerType === "mouse" && hoverKey) clearHoverSoon();
  });
  // Taps and clicks pin. The listener sits on the pane itself, not the
  // document: iOS only delivers taps on plain elements to a listener that is
  // actually attached along the way.
  pane.addEventListener("click", (e) => {
    const card = cardOf(e.target);
    if (card?.dataset.key) toggle(card.dataset.key);
    else if (pinnedKey) close();
  });
  pane.addEventListener("keydown", (e) => {
    const card = cardOf(e.target);
    if (card?.dataset.key && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      toggle(card.dataset.key);
    }
  });
  tip.addEventListener("click", (e) => {
    if ((e.target as Element).closest(".tip-x")) close();
  });
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && tipKey) close();
  };
  document.addEventListener("keydown", onKey);
  let raf = 0;
  pane.addEventListener(
    "scroll",
    () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (!sheetMode.matches) placeTip();
        loader?.prioritize(visibleNames());
      });
    },
    { passive: true },
  );
  const onMode = () => {
    sheetScrolled = false;
    placeTip();
  };
  sheetMode.addEventListener("change", onMode);

  void poll();
  renderStatus();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      cancelHoverClear();
      clearInterval(clock);
      observer?.disconnect();
      chromeRO?.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", measureChrome);
      sheetMode.removeEventListener("change", onMode);
      document.documentElement.classList.remove("live");
      document.title = savedTitle;
    },
  };
}

// A speech bubble in the card's corner: this pick has a reason to read.
const NOTE_MARK = `<span class="notemark" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M2.5 2h11A1.5 1.5 0 0 1 15 3.5v7a1.5 1.5 0 0 1-1.5 1.5H7l-3.5 3v-3h-1A1.5 1.5 0 0 1 1 10.5v-7A1.5 1.5 0 0 1 2.5 2z"/></svg></span>`;
