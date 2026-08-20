// Loading a draft straight from Google Sheets.
//
// A link-shared sheet can be read from the browser: the CSV export endpoint
// answers cross-origin requests. (The gviz endpoint answers too, but it folds
// the title row into its header and mangles the column layout, so `export` is
// the one to use.) Nothing here needs an API key — if a human with the link can
// open the sheet, so can this.

const ID_IN_URL = /\/spreadsheets\/d\/([A-Za-z0-9-_]+)/;
const BARE_ID = /^[A-Za-z0-9-_]{20,}$/;

export interface SheetRef {
  id: string;
  gid: string | null; // which tab; null means the sheet's first tab
  tab?: string | null; // tab to look for by name; defaults to "draft"
}

export interface SheetTab {
  name: string;
  gid: string;
}

export const DEFAULT_TAB = "draft";

// Accepts a full Sheets URL (any of the /edit#gid=, ?gid=, /view forms) or a
// bare document ID.
export function parseSheetRef(input: string): SheetRef | null {
  const s = input.trim();
  if (!s) return null;
  const id = s.match(ID_IN_URL)?.[1] ?? (BARE_ID.test(s) ? s : null);
  if (!id) return null;
  // On an edit URL the tab id lives in the fragment (#gid=123), elsewhere in
  // the query string — both look the same to this.
  const gid = s.match(/[#&?]gid=([0-9]+)/)?.[1] ?? null;
  return { id, gid };
}

export function csvUrl(ref: SheetRef): string {
  const gid = ref.gid ? `&gid=${encodeURIComponent(ref.gid)}` : "";
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(ref.id)}/export?format=csv${gid}`;
}

const SHARE_HINT = 'In Sheets: Share → General access → "Anyone with the link".';

// ---------- Finding the right tab ----------
// A Sheets link points at whichever tab you were looking at, which usually
// isn't the draft. There's no tab listing without an API key, but the htmlview
// page bootstraps its own tab switcher with one — items.push({name: "Draft",
// … gid: "123"}) — and it's readable cross-origin like the CSV export.
//
// The obvious alternative, gviz's ?sheet=<name>, is a trap: it's pleasantly
// case-insensitive, but a name that doesn't exist silently returns the FIRST
// tab with a 200 rather than erroring, so you can't tell "found it" from
// "didn't". Reading the real list and resolving to a gid avoids guessing.
const TAB_RE = /\{name:\s*"((?:\\.|[^"\\])*)"[\s\S]{0,400}?gid:\s*"(-?\d+)"/g;

function unescapeJs(s: string): string {
  return s
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\(.)/g, "$1");
}

export async function fetchTabs(id: string): Promise<SheetTab[]> {
  try {
    const resp = await fetch(`https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/htmlview`);
    if (!resp.ok) return [];
    const html = await resp.text();
    const tabs: SheetTab[] = [];
    const seen = new Set<string>();
    for (const m of html.matchAll(TAB_RE)) {
      const name = unescapeJs(m[1]).trim();
      if (name && !seen.has(m[2])) {
        seen.add(m[2]);
        tabs.push({ name, gid: m[2] });
      }
    }
    return tabs;
  } catch {
    return []; // fall back to whatever gid the link carried
  }
}

// Which tab to actually read. A gid the link already points at is honoured when
// it IS a draft tab — someone linking "Draft 2" means it — otherwise we go find
// the draft tab, which is the whole point: any tab's link should work.
export function chooseTab(tabs: SheetTab[], ref: SheetRef): SheetTab | null {
  const want = (ref.tab || DEFAULT_TAB).trim().toLowerCase();
  const matches = (t: SheetTab) => t.name.trim().toLowerCase() === want;
  const contains = (t: SheetTab) => t.name.toLowerCase().includes(want);

  const linked = ref.gid ? tabs.find((t) => t.gid === ref.gid) : undefined;
  if (linked && contains(linked)) return linked;

  return tabs.find(matches) ?? tabs.find(contains) ?? linked ?? null;
}

export interface ResolvedSheet {
  ref: SheetRef; // with gid filled in
  tab: SheetTab | null; // the tab we settled on, when we could name it
  tabs: SheetTab[]; // everything we found, for error messages
}

// Turn "a link to some tab" into "the draft tab of that sheet".
export async function resolveSheet(ref: SheetRef): Promise<ResolvedSheet> {
  const tabs = await fetchTabs(ref.id);
  const tab = chooseTab(tabs, ref);
  return { ref: { ...ref, gid: tab?.gid ?? ref.gid }, tab, tabs };
}

export async function fetchSheetCsv(ref: SheetRef): Promise<string> {
  let res: Response;
  try {
    res = await fetch(csvUrl(ref));
  } catch {
    // A sheet that isn't link-shared refuses the cross-origin read, which the
    // browser reports as a thrown fetch rather than a status code.
    throw new Error(`Couldn't read that sheet — it may not be shared publicly. ${SHARE_HINT}`);
  }
  if (!res.ok) {
    throw new Error(`Google Sheets returned ${res.status} for that link. ${SHARE_HINT}`);
  }
  const text = await res.text();
  // A private sheet can also answer with a sign-in page instead of failing.
  if (/^\s*</.test(text)) {
    throw new Error(`That link returned a web page instead of a sheet. ${SHARE_HINT}`);
  }
  return text;
}
