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

Either point it at a Google Sheet:

1. Share the sheet with **Anyone with the link** (it's read straight from the
   browser — see below).
2. Paste the sheet URL into the box and click **Load sheet**. It can be a link
   to **any tab** — the Cube tab, the rules tab, whatever was on screen when you
   copied it — the draft tab is found by name. The address bar becomes
   `?sheet=<id>&gid=<tab>` pointing at the tab it settled on, ready to bookmark.
3. **↻ Refresh** re-reads the sheet without losing your place, so the view
   follows a draft that's still being filled in.

…or paste the cells:

1. In Google Sheets, select the cells (players across one row, each player's
   picks running down their column) and copy — or export/paste CSV.
2. Paste into the textarea (or upload a `.csv` / `.tsv`) and click **Load draft**.

Either way, use the slider, ◀ ▶ buttons, or the **←/→ arrow keys** to step
through the draft. Click **Load sample** to see a worked example.

### URL parameters

| Param | Meaning |
| --- | --- |
| `?sheet=` | Google Sheets URL or bare document ID |
| `&tab=` | tab to read, by name (default: the one called **Draft**) |
| `&gid=` | tab id — used only if no tab matches by name |
| `?sample` | the built-in sample draft |
| `&pick=N` | open at pick N — the turn containing it is revealed |
| `&doubleAfter=N` | override the round after which turns take two picks |
| `?draft=` | follow a live draft run by the queue app — see below |
| `&app=` | which queue app to ask (default `https://rotisserie.greggg230.com`) |

## Watching a live draft

`?draft=<id>` follows a draft that is still being drafted, using its id in the
[rotisserie queue app](https://rotisserie.greggg230.com) (the `<id>` in
`/d/<id>`). It shows the whole grid — players across, rounds down — and updates
itself every 30 seconds:

- The newest turn is outlined, and picks that landed since the last look glow
  briefly. The bottom bar narrates the newest turn and who's up next; tap it to
  jump to that pick.
- A speech bubble on a card means the picker left a rationale. Hover it on a
  desktop (click to pin it open), or tap it on a phone, where it opens as a
  sheet along the bottom. Tap the card again, the ×, or anywhere else in the
  grid to close it.
- Scroll position and an open rationale survive every refresh. The grid scrolls
  inside its own pane in both directions, with the player row and round column
  pinned, so the page itself never scrolls sideways on a phone.
- Polling pauses while the tab is hidden and catches up when it's looked at
  again; once the draft is complete it drops to every five minutes. If the app
  can't be reached the last good grid stays up with a notice, and it backs off
  to retrying every two minutes at most.

Data comes from the app's `GET /api/drafts/<id>/picks`, not from the sheet: the
app already reads the sheet (cached, so a room full of spectators costs Google
one read), numbers seats and rounds the way the rationales are keyed, and has
matched each rationale to the card actually in its cell — one consistent
snapshot. That endpoint answers cross-origin with `Access-Control-Allow-Origin:
*`. Add `&sheet=<id>` to fall back to reading the sheet directly when the app
can't be reached; the grid keeps moving and the rationales return with the app.

Against an app that doesn't serve rationales yet, the grid still works and a
notice says so. In development, `&app=/rotisserie-proxy` reads the production
app through the Vite dev server (see `vite.config.ts`), same-origin, so it works
whether or not the app sends CORS headers; `&app=http://desktop-j05412i:5181`
reads a local `wrangler dev`.

### Reading a sheet from the browser

There's no API key and no server: `docs.google.com/.../export?format=csv`
answers cross-origin requests for a link-shared sheet, so the page fetches it
directly. A sheet that isn't shared either refuses the read or answers with a
sign-in page — both are reported as "share it with Anyone with the link".

### Finding the draft tab

A Sheets link points at whichever tab you were looking at, so the app resolves
the tab itself rather than trusting the `gid`. There's no tab listing without an
API key, but the **htmlview** page bootstraps its own tab switcher with one —
`items.push({name: "Draft", … gid: "123"})` — and it's readable cross-origin
like the CSV export. The app reads that list, picks the tab named `draft`
(case-insensitive, `&tab=` to override), and fetches it by gid.

A `gid` in the link wins only when it already points at a draft tab, so linking
a tab called "Draft 2" does what you'd expect. If no tab matches, the error
names every tab in the sheet.

Two dead ends worth recording:

- `gviz/tq?sheet=<name>` reads a tab **by name** and is pleasantly
  case-insensitive — but a name that doesn't exist silently returns the **first
  tab** with a 200 instead of erroring, so you can't tell success from failure.
- `gviz` also folds the title rows into its header and mangles the layout unless
  you pass `headers=0`. `export?format=csv` never does, so that's what's used.

## Expected sheet shape

```
                Rotisserie Draft            <- title (one cell)
   Mack   Squirrel   Mark R   ...           <- one row of player names
   Lotus  Academy    Recall   ...           <- round 1 picks
   ...                                       <- round 2, 3, ... down the columns
```

- Players are **columns**; picks run **down** each column.
- The header row is found by structure, not by counting: it's the widest run
  of adjacent filled cells, mostly names (cells with letters in them), whose
  row above doesn't span the same columns — with the data below it only as a
  tiebreak. That's what keeps round numbers, turn-order arrows, and a "Draft
  Status" side panel from being mistaken for players — those rows have *more*
  filled cells than the header does, and a draft only a few picks in has far
  more numbers and arrows down its side than cards under its players. Same
  rule as the queue app's parser.
- Leading blank columns/rows are tolerated; the title row and header row are
  auto-detected (header = the row with the most filled cells).
- **Snake order is reconstructed automatically**: round 1 goes left→right,
  round 2 right→left, and so on. Works for any number of players and for a
  partial final round.
- **Double picks** are supported. A sheet saying `Double Picks After: | 18` in
  its status panel switches to two-card turns after round 18: rounds pair up,
  the snake keeps alternating once per *turn row*, and the scrubber reveals
  both cards of a turn in one step. Because round 18 comes back right-to-left
  and ends on seat 1, that seat opens the doubling with its 19th and 20th
  picks. Override with `&doubleAfter=N`, or leave it off entirely.
- Card names with commas must be quoted if you paste raw CSV (Sheets copy/paste
  uses tabs, so this only matters for hand-written CSV).

## How it works

- `src/csv.ts` — CSV/TSV parser (quoted fields, tab-paste detection).
- `src/sheets.ts` — Google Sheets URL/ID parsing + CSV fetch.
- `src/draft.ts` — header/player detection, snake order, double-pick turns.
- `src/scryfall.ts` — locally-hosted images first, then the **oldest / original
  printing** from Scryfall, batched, with a streaming loader. See below.
- `src/live.ts` — the `?draft=` live view: polling, the patched-in-place grid,
  and the rationale popover / bottom sheet.
- `scripts/fetch_cube_images.py` — one-off fetch of the cube's images.

## Image loading

The board renders immediately with skeleton placeholders; images stream in
behind it, **on-screen cards first**. An `IntersectionObserver` pushes whatever
scrolls into view (or gets revealed by the scrubber) to the front of the queue,
so you never wait on cards you can't see.

### Self-hosted cube images

The cube is stable, so its images ship with the site rather than being fetched
per visitor. That removes the common case from Scryfall entirely — no rate
limiting, no images that quietly fail to appear, and no per-card round trip.

```
python scripts/fetch_cube_images.py            # incremental; only fetches what's missing
python scripts/fetch_cube_images.py --force    # refetch everything
```

It reads the **Cube** tab of the draft sheet, resolves each name to the same
oldest printing the app would have chosen, and writes `public/cards/<slug>.webp`
plus `public/cards/index.json`. Images are resized to 300px wide — exactly 2x
the 150px the board renders them at — which is ~26 kB each against Scryfall's
137 kB JPEG, so the whole cube is ~19 MB.

The manifest keys each card by **both** the cube sheet's spelling and Scryfall's
canonical name, so a draft sheet that writes it either way still hits the local
copy. `CardLoader` checks the manifest before the network; anything not in it
(joke cards, a card added mid-draft, a typo) goes to the API as before. If a
local image fails to load, that card falls back to Scryfall once rather than
leaving a gap.

Re-run the script when cards are added to the cube. Card images are copyright
Wizards of the Coast, served here via Scryfall for a private draft review.

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
