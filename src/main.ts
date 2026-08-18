import "./style.css";
import { parseTable } from "./csv";
import { buildDraft, type Draft, type Pick } from "./draft";
import { CardLoader, normalizeName, type CardInfo } from "./scryfall";
import { SAMPLE_CSV } from "./sample";

const app = document.querySelector<HTMLDivElement>("#app")!;

interface State {
  draft: Draft | null;
  current: number; // 0..totalPicks
}
const state: State = { draft: null, current: 0 };

// Card elements keyed by normalized card name (a name can be picked more than
// once across a pool, so each key maps to a list).
let cardEls = new Map<string, HTMLElement[]>();
let loader: CardLoader | null = null;
let observer: IntersectionObserver | null = null;
let chromeRO: ResizeObserver | null = null;

// Per-player, the picks in that player's own pick order (with global numbers).
function picksByPlayer(draft: Draft): Pick[][] {
  const out: Pick[][] = draft.players.map(() => []);
  for (const p of draft.order) out[p.playerIndex].push(p);
  return out;
}

// ---------- Load screen ----------
function renderLoader() {
  teardownReview();
  app.innerHTML = `
    <div class="loader">
      <h1>Rotisserie Draft Review</h1>
      <p class="sub">Paste your draft spreadsheet (copy the cells straight from Google
      Sheets, or paste CSV). Players across the top, each player's picks running down
      their column.</p>
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
      <p id="err" class="err"></p>
    </div>`;

  const csv = app.querySelector<HTMLTextAreaElement>("#csv")!;
  const err = app.querySelector<HTMLParagraphElement>("#err")!;

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
    const text = csv.value.trim();
    if (!text) {
      err.textContent = "Nothing to load — paste your sheet first.";
      return;
    }
    try {
      const table = parseTable(text);
      const draft = buildDraft(table);
      if (draft.players.length < 2) {
        err.textContent =
          "Couldn't find at least 2 player columns. Check that player names are in one row across the top.";
        return;
      }
      if (draft.order.length === 0) {
        err.textContent = "Found players but no picks below them.";
        return;
      }
      state.draft = draft;
      state.current = 0; // start at the beginning — nothing revealed yet
      startReview();
    } catch (e) {
      err.textContent = "Parse error: " + (e as Error).message;
    }
  });
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

function startLoading() {
  const draft = state.draft!;
  const bar = app.querySelector<HTMLDivElement>("#loadbar-inner")!;
  const label = app.querySelector<HTMLSpanElement>("#loadbar-label")!;
  const loadbar = app.querySelector<HTMLDivElement>("#loadbar")!;

  loader = new CardLoader({
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
        <div class="meta">${draft.players.length} players · ${draft.order.length} picks</div>
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
      <input type="range" id="slider" min="0" max="${draft.order.length}" value="${state.current}" />
      <button id="next" class="ctrl" title="Next pick (→)">&#x25B6;</button>
      <button id="last" class="ctrl" title="End">&#x23ED;</button>
      <div class="readout" id="readout"></div>
    </div>`;

  app.querySelector("#back")!.addEventListener("click", () => {
    state.draft = null;
    renderLoader();
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
  const total = state.draft!.order.length;
  let v = state.current + delta;
  if (delta === Infinity) v = total;
  if (delta === -Infinity) v = 0;
  state.current = Math.max(0, Math.min(total, v));
  const slider = app.querySelector<HTMLInputElement>("#slider");
  if (slider) slider.value = String(state.current);
  update();
}

// Reveal/hide cards + highlight current pick based on state.current.
function update() {
  const draft = state.draft!;
  const current = state.current;
  // Revealing cards can bring a scrollbar in or out — remeasure before we
  // scroll to the current pick, so its scroll-margin is right.
  measureChrome();

  for (const pk of draft.order) {
    const el = document.getElementById(`card-${pk.pickNumber}`);
    if (!el) continue;
    const revealed = pk.pickNumber <= current;
    el.classList.toggle("hidden", !revealed);
    el.classList.toggle("current", pk.pickNumber === current);
  }

  // per-player counts
  const counts = new Array(draft.players.length).fill(0);
  for (const pk of draft.order) if (pk.pickNumber <= current) counts[pk.playerIndex]++;
  counts.forEach((c, i) => {
    const el = document.getElementById(`pcount-${i}`);
    if (el) el.textContent = String(c);
  });

  // readout caption
  const readout = document.getElementById("readout");
  if (!readout) return;
  if (current === 0) {
    readout.innerHTML = `<span class="muted">Draft not started — press → to reveal pick 1</span>`;
  } else {
    const pk = draft.order[current - 1];
    const pl = draft.players[pk.playerIndex];
    readout.innerHTML =
      `<span class="rpick">Pick ${pk.pickNumber}</span>` +
      `<span class="rround">Round ${pk.round}</span>` +
      `<span class="rdot" style="background:${pl.color}"></span>` +
      `<span class="rplayer">${escapeHtml(pl.name)}</span>` +
      `<span class="rarrow">took</span>` +
      `<span class="rcard">${escapeHtml(pk.cardName)}</span>`;
    // The pick being narrated matters most — put it at the head of the queue.
    loader?.prioritize([pk.cardName]);
    const el = document.getElementById(`card-${pk.pickNumber}`);
    el?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }
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

// Auto-load the sample draft when visiting with ?sample — handy for demos
// and for sharing a link that lands straight on the board.
function boot() {
  const params = new URLSearchParams(location.search);
  if (params.has("sample")) {
    try {
      const draft = buildDraft(parseTable(SAMPLE_CSV));
      state.draft = draft;
      const pick = Number(params.get("pick"));
      state.current =
        Number.isFinite(pick) && params.has("pick")
          ? Math.max(0, Math.min(draft.order.length, pick))
          : 0;
      startReview();
      return;
    } catch {
      /* fall through to loader */
    }
  }
  renderLoader();
}

boot();
