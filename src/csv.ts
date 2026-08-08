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
// Detect by comparing tab vs comma counts on the first non-empty line.
export function parseTable(text: string): string[][] {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  const tabs = (firstLine.match(/\t/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  if (tabs > commas) {
    // TSV: quotes are rare in sheet paste; simple split is fine.
    return text
      .split(/\r?\n/)
      .filter((l, idx, arr) => !(idx === arr.length - 1 && l === ""))
      .map((l) => l.split("\t"));
  }
  return parseCSV(text);
}
