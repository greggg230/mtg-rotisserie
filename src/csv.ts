// Minimal but correct CSV parser: handles quoted fields, escaped quotes ("")
// embedded commas, and both \n and \r\n line endings. Returns a 2D array of
// raw string cells (no trimming — callers decide).
export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      pushField();
      i++;
      continue;
    }
    if (c === "\r") {
      // swallow \r; \n (if present) handled next iteration
      i++;
      continue;
    }
    if (c === "\n") {
      pushRow();
      i++;
      continue;
    }
    field += c;
    i++;
  }
  // flush trailing field/row if any content was accumulated
  if (field.length > 0 || row.length > 0) pushRow();
  return rows;
}

// Also handle tab-separated paste (Google Sheets copy/paste uses TAB, not comma).
// Sniff the delimiter across several lines rather than just the first: a title
// row often holds a single cell, and if its leading tabs have been trimmed away
// it looks delimiter-free — which used to send a whole TSV paste down the CSV
// path and collapse it to one column. Card names ("Jace, the Mind Sculptor")
// put a few commas in a TSV, but never as many as there are column separators.
export function parseTable(text: string): string[][] {
  const sample = text
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .slice(0, 20)
    .join("\n");
  const tabs = (sample.match(/\t/g) || []).length;
  const commas = (sample.match(/,/g) || []).length;
  if (tabs > commas) {
    // TSV: quotes are rare in sheet paste; simple split is fine.
    return text
      .split(/\r?\n/)
      .filter((l, idx, arr) => !(idx === arr.length - 1 && l === ""))
      .map((l) => l.split("\t"));
  }
  return parseCSV(text);
}
