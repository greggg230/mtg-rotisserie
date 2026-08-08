// Draft data model + snake-order reconstruction.

export interface Player {
  name: string;
  color: string;
  picks: string[]; // card names, in the order they appear down the column
}

export interface Pick {
  pickNumber: number; // 1-based global order across the whole draft
  round: number; // 1-based
  playerIndex: number;
  cardName: string;
}

export interface Draft {
  title: string;
  players: Player[];
  order: Pick[]; // every pick, sorted by global snake order
}

// Distinct, reasonably colorblind-friendly palette. Cycles if more players.
const PALETTE = [
  "#c0392b", // red
  "#e67e22", // orange
  "#f1c40f", // yellow
  "#2ecc71", // green
  "#16a085", // teal
  "#3498db", // blue
  "#9b59b6", // purple
  "#e84393", // pink
  "#7f8c8d", // gray
  "#d35400", // dark orange
  "#27ae60", // dark green
  "#8e44ad", // dark purple
];

export function playerColor(i: number): string {
  return PALETTE[i % PALETTE.length];
}

function nonEmpty(s: string | undefined): boolean {
  return !!s && s.trim().length > 0;
}

// Auto-detect the header row (the one holding player names) and build the draft.
// Assumptions matching the reference sheet: players are COLUMNS, each player's
// picks run DOWN their column. Leading blank columns/rows are tolerated.
export interface ParseOptions {
  headerRow?: number; // 0-based override; if omitted, auto-detect
}

export function buildDraft(table: string[][], opts: ParseOptions = {}): Draft {
  // Trim fully-empty trailing rows.
  const rows = table.map((r) => r.slice());

  // Title = first row that has exactly one non-empty cell (if any).
  let title = "Rotisserie Draft";
  let titleRowIdx = -1;
  for (let r = 0; r < Math.min(rows.length, 5); r++) {
    const filled = rows[r].filter(nonEmpty);
    if (filled.length === 1) {
      title = filled[0].trim();
      titleRowIdx = r;
      break;
    }
  }

  // Header row: explicit override, else the row (after any title) with the most
  // non-empty cells among the first several rows.
  let headerRow = opts.headerRow;
  if (headerRow === undefined) {
    let best = -1;
    let bestCount = 1; // need at least 2 players to qualify
    for (let r = 0; r < Math.min(rows.length, 8); r++) {
      if (r === titleRowIdx) continue;
      const count = rows[r].filter(nonEmpty).length;
      if (count > bestCount) {
        bestCount = count;
        best = r;
      }
    }
    headerRow = best >= 0 ? best : titleRowIdx + 1;
  }

  const header = rows[headerRow] ?? [];
  // Columns that have a non-empty header become players.
  const playerCols: number[] = [];
  header.forEach((cell, c) => {
    if (nonEmpty(cell)) playerCols.push(c);
  });

  const players: Player[] = playerCols.map((c, i) => ({
    name: header[c].trim(),
    color: playerColor(i),
    picks: [],
  }));

  // Collect picks going down each player's column.
  for (let r = headerRow + 1; r < rows.length; r++) {
    playerCols.forEach((c, i) => {
      const v = rows[r][c];
      if (nonEmpty(v)) players[i].picks.push(v.trim());
    });
  }

  const order = snakeOrder(players);
  return { title, players, order };
}

// Reconstruct global pick order from per-player picks using snake seating:
// round 1 goes players L->R, round 2 R->L, etc. Ragged columns are fine —
// a pick only exists where a card is present.
export function snakeOrder(players: Player[]): Pick[] {
  const P = players.length;
  const maxRounds = players.reduce((m, p) => Math.max(m, p.picks.length), 0);
  const order: Pick[] = [];
  let pickNumber = 0;
  for (let r = 0; r < maxRounds; r++) {
    const leftToRight = r % 2 === 0;
    const seq = leftToRight
      ? [...Array(P).keys()]
      : [...Array(P).keys()].reverse();
    for (const i of seq) {
      const card = players[i].picks[r];
      if (card !== undefined) {
        pickNumber++;
        order.push({
          pickNumber,
          round: r + 1,
          playerIndex: i,
          cardName: card,
        });
      }
    }
  }
  return order;
}

// How many of each player's cards are revealed once we've advanced to a given
// global pick number. Returns an array parallel to players.
export function revealedCounts(draft: Draft, uptoPick: number): number[] {
  const counts = new Array(draft.players.length).fill(0);
  for (const p of draft.order) {
    if (p.pickNumber > uptoPick) break;
    counts[p.playerIndex]++;
  }
  return counts;
}
