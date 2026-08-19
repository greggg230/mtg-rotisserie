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
}

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
