# MTG Rotisserie Draft Review

A static site that turns a rotisserie draft spreadsheet into a pick-by-pick,
snake-order review. Each player gets a vertical stack of card images; a scrubber
steps through the draft one pick at a time. Card images come from
[Scryfall](https://scryfall.com/docs/api).

## Run

```
npm install
npm run dev      # http://desktop-j05412i:5180  (binds 0.0.0.0)
```

Also registered in the dev hub (port 5180).

## Using it

1. In Google Sheets, select the cells (players across one row, each player's
   picks running down their column) and copy — or export/paste CSV.
2. Paste into the textarea (or upload a `.csv` / `.tsv`) and click **Load draft**.
3. Use the slider, ◀ ▶ buttons, or the **←/→ arrow keys** to step through picks.

Click **Load sample** to see a worked example, or visit `/?sample` to jump
straight to it (`/?sample&pick=11` opens at a specific pick).

## Expected sheet shape

```
                Rotisserie Draft            <- title (one cell)
   Mack   Squirrel   Mark R   ...           <- one row of player names
   Lotus  Academy    Recall   ...           <- round 1 picks
   ...                                       <- round 2, 3, ... down the columns
```

- Players are **columns**; picks run **down** each column.
- Leading blank columns/rows are tolerated; the title row and header row are
  auto-detected (header = the row with the most filled cells).
- **Snake order is reconstructed automatically**: round 1 goes left→right,
  round 2 right→left, and so on. Works for any number of players and for a
  partial final round.
- Card names with commas must be quoted if you paste raw CSV (Sheets copy/paste
  uses tabs, so this only matters for hand-written CSV).

## How it works

- `src/csv.ts` — CSV/TSV parser (quoted fields, tab-paste detection).
- `src/draft.ts` — header/player detection + snake-order reconstruction.
- `src/scryfall.ts` — resolves the **oldest / original printing** of each card,
  batched, with a streaming loader. See below.

## Image loading

The board renders immediately with skeleton placeholders; images stream in
behind it, **on-screen cards first**. An `IntersectionObserver` pushes whatever
scrolls into view (or gets revealed by the scrubber) to the front of the queue,
so you never wait on cards you can't see.

Getting the *oldest* printing without one request per card is the fiddly part:

- `/cards/collection` batches, but only returns each card's **default** (usually
  newest) printing and can't be sorted.
- `unique=cards` **ignores the sort** when picking which printing to return —
  it'll hand back a 2026 Sol Ring. Useless here.
- `unique=prints&order=released&dir=asc` returns every printing of every matched
  card, oldest first. So we OR ~12 exact names into one query and take the
  **first occurrence** of each name — that's its original printing.

That's ~15 requests for a 160-card draft instead of 300. Anything a batch misses
(digital-only cards, typos) falls back to a per-card exact then fuzzy lookup.

Requests pass through a gate that caps concurrency and spaces them out, and are
retried with backoff. One gotcha worth knowing: when Scryfall rate-limits you it
responds **without CORS headers**, so the browser surfaces it as a thrown fetch
rather than a 429 — thrown fetches are therefore treated as retryable, not as
"card not found". Everything is cached in `localStorage` for instant re-runs.

`test-loading.py` is a Playwright harness that measures this end-to-end on a
cold cache (needs the dev server running).
- `src/main.ts` — UI, scrubber, reveal/highlight logic.
