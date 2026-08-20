import "./style.css";
import { parseTable } from "./csv";
import { buildDraft, type Draft, type Pick } from "./draft";
import { CardLoader, loadLocalCards, normalizeName, type CardInfo } from "./scryfall";
import { SAMPLE_CSV } from "./sample";
import {
  DEFAULT_TAB,
  fetchSheetCsv,
  parseSheetRef,
  resolveSheet,
  type SheetRef,
} from "./sheets";

const app = document.querySelector<HTMLDivElement>("#app")!;

interface State {
  draft: Draft | null;
  current: number; // turns revealed, 0..draft.turns.length
  sheet: SheetRef | null; // set when loaded from Google Sheets, so we can refetch
  tabName: string | null; // the tab we actually read, once resolved
  doubleAfter?: number | null; // ?doubleAfter= override, kept across refreshes
}
const state: State = { draft: null, current: 0, sheet: null, tabName: null };

// Card elements keyed by normalized card name (a name can be picked more than
// once across a pool, so each key maps to a list).
let cardEls = new Map<string, HTMLElement[]>();
let loader: CardLoader | null = null;
// Start reading the local card manifest immediately — it's a same-origin file
// and we want it in hand by the time the board is ready for images.
const localCards = loadLocalCards(import.meta.env.BASE_URL);
let observer: IntersectionObserver | null = null;
let chromeRO: ResizeObserver | null = null;

// Per-player, the picks in that player's own pick order (with global numbers).
function picksByPlayer(draft: Draft): Pick[][] {
  const out: Pick[][] = draft.players.map(() => []);
  for (const p of draft.order) out[p.playerIndex].push(p);
  return out;
}

// Turn a parsed sheet into the review screen, or an error string explaining
// why it can't be. Shared by every entry point: paste, upload, sheet, sample.
function showDraft(text: string, sheet: SheetRef | null): string | null {
  let draft: Draft;
  try {
    draft = buildDraft(parseTable(text), { doubleAfter: state.doubleAfter });
  } catch (e) {
    return "Parse error: " + (e as Error).message;
  }
  if (draft.players.length < 2) {
    return "Couldn't find at least 2 player columns. Check that player names are in one row across the top.";
  }
  if (draft.order.length === 0) return "Found players but no picks below them.";
  state.draft = draft;
  state.sheet = sheet;
  state.current = 0; // start at the beginning — nothing revealed yet
  startReview();
  return null;
}

// ---------- Load screen ----------
function renderLoader(message = "") {
  teardownReview();
  app.innerHTML = `
    <div class="loader">
      <h1>Rotisserie Draft Review</h1>
      <p class="sub">Point it at a Google Sheet, or paste the cells straight from one.
      Players across the top, each player's picks running down their column.</p>
      <div class="loader-row sheetrow">
        <input id="sheeturl" type="url" spellcheck="false"
          placeholder="https://docs.google.com/spreadsheets/d/..." />
        <button id="loadsheet" class="primary">Load sheet</button>
      </div>
      <p class="hint">The sheet has to be shared with “Anyone with the link”. Loading one
      gives you a link you can bookmark or share — it re-reads the sheet each time,
      so it follows the draft as it fills in.</p>
      <div class="or"><span>or paste it</span></div>
      <textarea id="csv" placeholder="Paste sheet cells or CSV here..."></textarea>
      <div class="loader-row">
        <label class="filebtn">Upload .csv / .tsv
          <input type="file" id="file" accept=".csv,.tsv,.txt,text/csv" hidden />
        </label>
        <button id="sample" class="ghost">Load sample</button>
        <a class="dl" href="${import.meta.env.BASE_URL}sample-draft.csv" download>Download sample .csv</a>
        <div class="spacer"></div>
        <button id="load" class="primary">Load draft &rarr;</button>
      </div>
      <p id="err" class="err">${escapeHtml(message)}</p>
    </div>`;

  const csv = app.querySelector<HTMLTextAreaElement>("#csv")!;
  const err = app.querySelector<HTMLParagraphElement>("#err")!;
  const sheetInput = app.querySelector<HTMLInputElement>("#sheeturl")!;

  const loadSheet = async () => {
    err.textContent = "";
    const ref = parseSheetRef(sheetInput.value);
    if (!ref) {
      err.textContent = "That doesn't look like a Google Sheets link.";
      return;
    }
    err.textContent = "Reading sheet…";
    const message = await loadFromSheet(ref);
    if (message) {
      err.textContent = message;
      return;
    }
    // Put the RESOLVED sheet+tab in the URL, so the bookmark points at the
    // draft tab even when what was pasted pointed somewhere else.
    history.replaceState(null, "", sheetUrl(state.sheet ?? ref));
  };
  app.querySelector("#loadsheet")!.addEventListener("click", loadSheet);
  sheetInput.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") loadSheet();
  });

  app.querySelector("#file")!.addEventListener("change", (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      csv.value = String(reader.result || "");
    };
    reader.readAsText(f);
  });

  app.querySelector("#sample")!.addEventListener("click", () => {
    csv.value = SAMPLE_CSV;
  });

  app.querySelector("#load")!.addEventListener("click", () => {
    err.textContent = "";
    // Don't trim: leading tabs on the first line are real empty columns, and
    // dropping them hides that this is a tab-separated paste.
    const text = csv.value;
    if (!text.trim()) {
      err.textContent = "Nothing to load — paste your sheet first.";
      return;
    }
    err.textContent = showDraft(text, null) ?? "";
  });
}

// The shareable form of a sheet-backed view: ?sheet=<id>&gid=<tab>.
function sheetUrl(ref: SheetRef, pick?: number): string {
  const p = new URLSearchParams();
  p.set("sheet", ref.id);
  if (ref.gid) p.set("gid", ref.gid);
  if (ref.tab) p.set("tab", ref.tab);
  if (state.doubleAfter != null) p.set("doubleAfter", String(state.doubleAfter));
  if (pick) p.set("pick", String(pick));
  return `${location.pathname}?${p}`;
}

// Resolve the link to the draft tab, read it, and show it. The link can point
// at any tab of the sheet — the Cube tab, the rules tab, whatever was on screen
// when it was copied.
async function loadFromSheet(ref: SheetRef): Promise<string | null> {
  try {
    const { ref: resolved, tab, tabs } = await resolveSheet(ref);
    const csv = await fetchSheetCsv(resolved);
    state.tabName = tab?.name ?? null; // before showDraft: the board renders it
    const message = showDraft(csv, resolved);
    if (message && tabs.length) {
      // Name what we read and what else was on offer — far more useful than
      // "couldn't find player columns" when the wrong tab got picked.
      const want = ref.tab || DEFAULT_TAB;
      const names = tabs.map((t) => t.name).join(", ");
      return tab
        ? `${message}\n(Read the “${tab.name}” tab. Tabs in this sheet: ${names}. Add &tab=<name> to pick another.)`
        : `Couldn't find a tab named “${want}”. Tabs in this sheet: ${names}. Add &tab=<name> to pick one.`;
    }
    return message;
  } catch (e) {
    return (e as Error).message;
  }
}

// ---------- Review screen ----------
// Renders the board immediately with skeletons, then streams images in —
// on-screen cards first, everything else in the background.
function startReview() {
  renderBoardShell();
  update(); // apply reveal state before we measure what's on screen
  indexCards();
  startLoading();
}

function teardownReview() {
  observer?.disconnect();
  observer = null;
  chromeRO?.disconnect();
  chromeRO = null;
  loader = null;
  cardEls = new Map();
  document.removeEventListener("keydown", onKey);
  window.removeEventListener("scroll", onScroll);
  window.removeEventListener("resize", measureChrome);
}

function indexCards() {
  cardEls = new Map();
  for (const el of app.querySelectorAll<HTMLElement>(".card")) {
    const key = normalizeName(el.dataset.name || "");
    if (!key) continue;
    const list = cardEls.get(key);
    if (list) list.push(el);
    else cardEls.set(key, [el]);
  }
}

async function startLoading() {
  const draft = state.draft!;
  const bar = app.querySelector<HTMLDivElement>("#loadbar-inner")!;
  const label = app.querySelector<HTMLSpanElement>("#loadbar-label")!;
  const loadbar = app.querySelector<HTMLDivElement>("#loadbar")!;
  const local = await localCards;
  if (state.draft !== draft) return; // navigated away while the manifest loaded

  loader = new CardLoader({
    local,
    onCard: fillCard,
    onProgress: (done, total) => {
      const pct = total ? Math.round((done / total) * 100) : 100;
      bar.style.width = pct + "%";
      if (done >= total) {
        loadbar.classList.add("hidden");
      } else {
        loadbar.classList.remove("hidden");
        label.textContent = `Loading card images… ${done}/${total}`;
      }
    },
  });

  // Anything that scrolls into view (or gets revealed by the scrubber) jumps
  // the queue. rootMargin preloads a screenful ahead of the scroll.
  observer = new IntersectionObserver(
    (entries) => {
      const names: string[] = [];
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const n = (e.target as HTMLElement).dataset.name;
        if (n) names.push(n);
      }
      if (names.length) loader?.prioritize(names);
    },
    { rootMargin: "300px" },
  );
  for (const el of app.querySelectorAll<HTMLElement>(".card")) observer.observe(el);

  // Seed the queue: whatever's on screen first, then the rest in pick order —
  // which is also reveal order, so stepping forward from the start stays ahead
  // of the loader even when nothing is on screen yet.
  loader.add(visibleCardNames());
  loader.add(draft.order.map((p) => p.cardName));
}

// Cards currently within (or just outside) the viewport, top-to-bottom.
function visibleCardNames(): string[] {
  const out: string[] = [];
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const margin = 300;
  for (const el of app.querySelectorAll<HTMLElement>(".card:not(.hidden)")) {
    const r = el.getBoundingClientRect();
    const onScreen =
      r.bottom > -margin && r.top < vh + margin && r.right > -margin && r.left < vw + margin;
    if (onScreen && el.dataset.name) out.push(el.dataset.name);
  }
  return out;
}

function fillCard(key: string, info: CardInfo) {
  const els = cardEls.get(key);
  if (!els) return;
  for (const el of els) {
    const imgWrap = el.querySelector<HTMLDivElement>(".cardimg");
    if (!imgWrap || imgWrap.dataset.filled === "1") continue;
    imgWrap.dataset.filled = "1";
    imgWrap.classList.remove("skeleton");
    if (info.image) {
      const img = document.createElement("img");
      img.src = info.image;
      img.alt = info.name;
      img.loading = "lazy";
      img.decoding = "async";
      // If a locally-hosted copy won't load, put the card back to a skeleton
      // and let the loader resolve it from Scryfall instead of leaving a gap.
      img.addEventListener("error", () => {
        const name = el.dataset.name || info.name;
        img.remove();
        imgWrap.dataset.filled = "";
        imgWrap.classList.add("skeleton");
        el.querySelector(".cardlink")?.remove();
        loader?.refetch(name);
      });
      imgWrap.appendChild(img);
      if (info.scryfallUri) {
        const a = document.createElement("a");
        a.href = info.scryfallUri;
        a.target = "_blank";
        a.rel = "noopener";
        a.className = "cardlink";
        a.title = info.set ? `${info.name} — ${info.set.toUpperCase()} ${info.released ?? ""}`.trim() : info.name;
        el.appendChild(a);
      }
    } else {
      imgWrap.classList.add("noimg");
      imgWrap.textContent = el.dataset.name || info.name;
    }
  }
}

function renderBoardShell() {
  const draft = state.draft!;
  const cols = picksByPlayer(draft);

  app.innerHTML = `
    <div class="appbar">
      <div class="topbar">
        <button id="back" class="ghost small">&larr; New</button>
        <h1 class="title">${escapeHtml(draft.title)}</h1>
        ${state.sheet ? `<button id="refresh" class="ghost small" title="Re-read the ${escapeHtml(state.tabName ?? "sheet")} tab">&#x21bb; Refresh</button>` : ""}
        <div class="meta">${state.tabName ? `${escapeHtml(state.tabName)} tab · ` : ""}${draft.players.length} players · ${draft.order.length} picks${
          draft.doubleAfter ? ` · double picks after round ${draft.doubleAfter}` : ""
        }</div>
      </div>
      <div id="loadbar"><div id="loadbar-inner"></div><span id="loadbar-label"></span></div>
    </div>
    <div class="board" id="board">
      ${draft.players
        .map(
          (pl, i) => `
        <div class="column" data-player="${i}">
          <div class="phead" style="background:${pl.color}">
            <span class="pname">${escapeHtml(pl.name)}</span>
            <span class="pcount" id="pcount-${i}"></span>
          </div>
          <div class="stack" id="stack-${i}">
            ${cols[i]
              .map(
                (pk) => `
              <div class="card" id="card-${pk.pickNumber}" data-pick="${pk.pickNumber}" data-name="${escapeHtml(pk.cardName)}">
                <div class="cardimg skeleton"></div>
                <div class="badge">#${pk.pickNumber}</div>
              </div>`,
              )
              .join("")}
          </div>
        </div>`,
        )
        .join("")}
    </div>
    <div class="scrubber">
      <button id="first" class="ctrl" title="Start (0)">&#x23EE;</button>
      <button id="prev" class="ctrl" title="Previous pick (←)">&#x25C0;</button>
      <input type="range" id="slider" min="0" max="${draft.turns.length}" value="${state.current}" />
      <button id="next" class="ctrl" title="Next pick (→)">&#x25B6;</button>
      <button id="last" class="ctrl" title="End">&#x23ED;</button>
      <div class="readout" id="readout"></div>
    </div>`;

  app.querySelector("#back")!.addEventListener("click", () => {
    state.draft = null;
    state.sheet = null;
    history.replaceState(null, "", location.pathname);
    renderLoader();
  });

  // Re-read the sheet in place. A live draft grows while you're looking at it,
  // so hold the current turn rather than dropping back to the start.
  app.querySelector("#refresh")?.addEventListener("click", async () => {
    const ref = state.sheet;
    const meta = app.querySelector<HTMLDivElement>(".topbar .meta")!;
    const was = meta.textContent;
    meta.textContent = "Re-reading sheet…";
    const at = state.current;
    const message = ref ? await loadFromSheet(ref) : "No sheet to refresh.";
    if (message) {
      meta.textContent = was;
      renderLoader(message);
      return;
    }
    state.current = Math.min(at, state.draft!.turns.length);
    const s = app.querySelector<HTMLInputElement>("#slider");
    if (s) s.value = String(state.current);
    update();
  });
  const slider = app.querySelector<HTMLInputElement>("#slider")!;
  slider.addEventListener("input", () => {
    state.current = Number(slider.value);
    update();
  });
  app.querySelector("#first")!.addEventListener("click", () => step(-Infinity));
  app.querySelector("#prev")!.addEventListener("click", () => step(-1));
  app.querySelector("#next")!.addEventListener("click", () => step(1));
  app.querySelector("#last")!.addEventListener("click", () => step(Infinity));

  // Scrolling changes what's on screen — re-prioritise as it settles.
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", measureChrome);
  measureChrome();
  // The chrome resizes on its own too: the load bar collapses when the last
  // image lands, and the readout wraps to a second line on narrow windows.
  chromeRO = new ResizeObserver(measureChrome);
  for (const el of app.querySelectorAll(".appbar, .scrubber")) chromeRO.observe(el);

  document.addEventListener("keydown", onKey);
}

function onScroll() {
  loader?.prioritize(visibleCardNames());
}

// The topbar and scrubber are fixed, so the board has to pad around them.
// Publish their real heights instead of guessing.
function measureChrome() {
  const root = document.documentElement;
  const appbar = app.querySelector<HTMLElement>(".appbar");
  const scrub = app.querySelector<HTMLElement>(".scrubber");
  root.style.setProperty("--header-h", `${appbar?.offsetHeight ?? 0}px`);
  root.style.setProperty("--scrub-h", `${scrub?.offsetHeight ?? 0}px`);
  // A wide board puts a horizontal scrollbar at the very bottom of the window,
  // which the fixed scrubber would otherwise sit on top of. 0 with overlay bars.
  const hbar = Math.max(0, window.innerHeight - root.clientHeight);
  root.style.setProperty("--hbar-h", `${hbar}px`);
}

function onKey(e: KeyboardEvent) {
  if (!state.draft) return;
  if (e.key === "ArrowRight") {
    step(1);
    e.preventDefault();
  } else if (e.key === "ArrowLeft") {
    step(-1);
    e.preventDefault();
  }
}

function step(delta: number) {
  const total = state.draft!.turns.length;
  let v = state.current + delta;
  if (delta === Infinity) v = total;
  if (delta === -Infinity) v = 0;
  state.current = Math.max(0, Math.min(total, v));
  const slider = app.querySelector<HTMLInputElement>("#slider");
  if (slider) slider.value = String(state.current);
  update();
}

// Reveal/hide cards + highlight the current turn based on state.current.
// One step of the scrubber is one TURN, which is one pick for most of a draft
// and two once doubling starts — a double pick happened as a single decision,
// so it reveals as one.
function update() {
  const draft = state.draft!;
  const current = state.current;
  // Revealing cards can bring a scrollbar in or out — remeasure before we
  // scroll to the current pick, so its scroll-margin is right.
  measureChrome();

  for (const pk of draft.order) {
    const el = document.getElementById(`card-${pk.pickNumber}`);
    if (!el) continue;
    el.classList.toggle("hidden", pk.turn >= current);
    el.classList.toggle("current", pk.turn === current - 1);
  }

  // per-player counts
  const counts = new Array(draft.players.length).fill(0);
  for (const pk of draft.order) if (pk.turn < current) counts[pk.playerIndex]++;
  counts.forEach((c, i) => {
    const el = document.getElementById(`pcount-${i}`);
    if (el) el.textContent = String(c);
  });

  // readout caption
  const readout = document.getElementById("readout");
  if (!readout) return;
  if (current === 0) {
    readout.innerHTML = `<span class="muted">Draft not started — press → to reveal pick 1</span>`;
    return;
  }
  const turn = draft.turns[current - 1];
  const pl = draft.players[turn[0].playerIndex];
  const nums = turn.map((p) => p.pickNumber);
  const rounds = turn.map((p) => p.round);
  const span = (a: number[]) => (a.length > 1 ? `${a[0]}–${a[a.length - 1]}` : `${a[0]}`);
  readout.innerHTML =
    `<span class="rpick">${turn.length > 1 ? "Picks" : "Pick"} ${span(nums)}</span>` +
    `<span class="rround">${turn.length > 1 ? "Rounds" : "Round"} ${span(rounds)}</span>` +
    `<span class="rdot" style="background:${pl.color}"></span>` +
    `<span class="rplayer">${escapeHtml(pl.name)}</span>` +
    `<span class="rarrow">took</span>` +
    `<span class="rcard">${turn.map((p) => escapeHtml(p.cardName)).join(" + ")}</span>`;
  // The picks being narrated matter most — put them at the head of the queue.
  loader?.prioritize(turn.map((p) => p.cardName));
  // Scroll to the last card of the turn: it's the lower of the two, so bringing
  // it into view brings its partner with it.
  const el = document.getElementById(`card-${nums[nums.length - 1]}`);
  el?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

// URL entry points, so a view can be bookmarked or shared:
//   ?sheet=<id|url>&gid=<tab>   read a link-shared Google Sheet
//   ?sample                     the built-in sample draft
//   ?pick=N                     open at pick N (its whole turn is revealed)
//   ?doubleAfter=N              override the sheet's own double-pick round
async function boot() {
  const params = new URLSearchParams(location.search);

  const dbl = params.get("doubleAfter");
  if (dbl !== null) {
    const n = Number(dbl);
    state.doubleAfter = Number.isInteger(n) && n > 0 ? n : null;
  }

  // ?pick= is a pick NUMBER, not a turn index — it predates double picks and
  // stays stable as a citation. Resolve it to the turn holding that pick.
  const openAt = () => {
    const draft = state.draft;
    if (!draft) return;
    const pick = Number(params.get("pick"));
    if (!params.has("pick") || !Number.isFinite(pick)) return;
    const hit = draft.order.find((p) => p.pickNumber >= pick);
    state.current = hit ? hit.turn + 1 : draft.turns.length;
    update();
  };

  const sheet = params.get("sheet");
  if (sheet) {
    const ref = parseSheetRef(sheet);
    if (!ref) {
      renderLoader("That doesn't look like a Google Sheets link or ID.");
      return;
    }
    // Carry the gid and tab name from their own params when supplied separately.
    const gid = params.get("gid");
    const message = await loadFromSheet({
      ...ref,
      gid: gid ?? ref.gid,
      tab: params.get("tab"),
    });
    if (message) renderLoader(message);
    else openAt();
    return;
  }

  if (params.has("sample")) {
    if (!showDraft(SAMPLE_CSV, null)) {
      openAt();
      return;
    }
  }
  renderLoader();
}

boot();
