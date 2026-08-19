// Draft data model + snake-order reconstruction.

export interface Player {
  name: string;
  color: string;
  // Card names indexed by round-1, i.e. by the row they sit in. Sparse: a
  // player who hasn't taken their turn yet leaves a hole rather than shifting.
  picks: (string | undefined)[];
}

export interface Pick {
  pickNumber: number; // 1-based global order across the whole draft
  round: number; // 1-based
  playerIndex: number;
  cardName: string;
  turn: number; // 0-based; one turn takes two picks once doubling starts
}

export interface Draft {
  title: string;
  players: Player[];
  order: Pick[]; // every pick, sorted by global snake order
  turns: Pick[][]; // the same picks grouped into turns — what the scrubber steps
  doubleAfter: number | null; // round after which a turn takes two picks
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
  doubleAfter?: number | null; // override the sheet's own "Double Picks After"
}

// Maximal runs of adjacent non-empty cells in a row, two cells or wider.
// Players sit side by side, so their names always form one such run — and
// taking a run (rather than every filled cell in the row) is what keeps a
// side panel off to the right from being mistaken for more players.
function filledRuns(row: string[]): number[][] {
  const runs: number[][] = [];
  let run: number[] = [];
  for (let c = 0; c < row.length; c++) {
    if (nonEmpty(row[c])) {
      run.push(c);
    } else if (run.length) {
      runs.push(run);
      run = [];
    }
  }
  if (run.length) runs.push(run);
  return runs.filter((r) => r.length >= 2);
}

// Find the row of player names, and which columns they occupy.
//
// Counting filled cells per row isn't enough: a sheet that numbers its rounds
// in column A, marks the turn order with arrows, and parks a "Draft Status"
// panel off to the right gives every PICK row more filled cells than the
// header. Two things separate a header from a pick row:
//
//  - Player names sit at the TOP of their block, so the row above a header
//    doesn't span the same columns. A pick row always has one above it.
//  - The header's columns are the ones with the draft hanging below them.
//
// Score on raw cell count below, not density — a draft in progress leaves most
// of its grid empty, and dividing by height would favour a two-column run of
// incidental notes over nine real players.
function detectHeader(rows: string[][]): { row: number; cols: number[] } | null {
  let best: { row: number; cols: number[] } | null = null;
  let bestScore = 0;
  for (let r = 0; r < Math.min(rows.length, 10); r++) {
    for (const cols of filledRuns(rows[r] ?? [])) {
      const above = r === 0 ? 0 : cols.filter((c) => nonEmpty(rows[r - 1]?.[c])).length;
      if (above >= 2) continue;
      let below = 0;
      for (let rr = r + 1; rr < rows.length; rr++) {
        for (const c of cols) if (nonEmpty(rows[rr]?.[c])) below++;
      }
      if (below > bestScore) {
        bestScore = below;
        best = { row: r, cols };
      }
    }
  }
  return best;
}

export function buildDraft(table: string[][], opts: ParseOptions = {}): Draft {
  const rows = table.map((r) => r.slice());

  const found =
    opts.headerRow === undefined
      ? detectHeader(rows)
      : { row: opts.headerRow, cols: filledRuns(rows[opts.headerRow] ?? [])[0] ?? [] };
  const headerRow = found?.row ?? 0;
  const playerCols = found?.cols ?? [];
  const header = rows[headerRow] ?? [];

  // Title: the first thing written above the players. Sheets often put it in a
  // merged cell alongside other blurbs ("Next Pick: …"), so take the leftmost
  // cell of the topmost non-empty row rather than requiring a row of its own.
  let title = "Rotisserie Draft";
  for (let r = 0; r < headerRow; r++) {
    const cell = rows[r]?.find(nonEmpty);
    if (cell) {
      title = cell.trim();
      break;
    }
  }

  const players: Player[] = playerCols.map((c, i) => ({
    name: header[c].trim(),
    color: playerColor(i),
    picks: [],
  }));

  // Collect picks going down each player's column, keeping each card in the
  // ROW it was written in. Compacting non-empty cells instead would let one
  // gap — a player who hasn't filled their cell while the player after them
  // has — pull every later pick in that column up a round.
  for (let r = headerRow + 1; r < rows.length; r++) {
    playerCols.forEach((c, i) => {
      const v = rows[r][c];
      if (nonEmpty(v)) players[i].picks[r - headerRow - 1] = v.trim();
    });
  }

  const doubleAfter =
    opts.doubleAfter !== undefined ? opts.doubleAfter : detectDoubleAfter(rows);
  const order = snakeOrder(players, doubleAfter);
  return { title, players, order, turns: groupTurns(order), doubleAfter };
}

// Reconstruct global pick order from per-player picks using snake seating:
// round 1 goes players L->R, round 2 R->L, etc. Ragged columns are fine —
// a pick only exists where a card is present.
//
// Some drafts switch to double picks partway through: after round `doubleAfter`
// a player takes two cards when their turn comes round, so rounds pair up. The
// snake keeps alternating once per TURN row rather than once per round, which
// is what makes the doubling open with seat 1 — round 18 comes back right-to-
// left and ends on seat 1, who then takes rounds 19 and 20 back to back.
export function snakeOrder(players: Player[], doubleAfter: number | null = null): Pick[] {
  const P = players.length;
  const maxRounds = players.reduce((m, p) => Math.max(m, p.picks.length), 0);
  const order: Pick[] = [];
  let pickNumber = 0;
  let turn = -1;
  let stage = 0; // one per turn row: a single round, or a pair once doubled

  for (let round = 1; round <= maxRounds; stage++) {
    const doubled = doubleAfter !== null && round > doubleAfter;
    const rounds = doubled ? [round, round + 1] : [round];
    const seq =
      stage % 2 === 0 ? [...Array(P).keys()] : [...Array(P).keys()].reverse();

    for (const i of seq) {
      const cards = rounds.flatMap((r) => {
        const cardName = players[i].picks[r - 1];
        return cardName === undefined ? [] : [{ round: r, cardName }];
      });
      if (!cards.length) continue; // player hasn't reached this turn yet
      turn++;
      for (const c of cards) {
        pickNumber++;
        order.push({
          pickNumber,
          round: c.round,
          playerIndex: i,
          cardName: c.cardName,
          turn,
        });
      }
    }
    round += rounds.length;
  }
  return order;
}

export function groupTurns(order: Pick[]): Pick[][] {
  const turns: Pick[][] = [];
  for (const p of order) (turns[p.turn] ??= []).push(p);
  return turns;
}

// Sheets that switch to double picks tend to say so in a status panel, as a
// "Double Picks After:" label with the round in the next cell along. Read it
// rather than hardcoding a rule that's really a property of the draft.
function detectDoubleAfter(rows: string[][]): number | null {
  for (const row of rows) {
    for (let c = 0; c < row.length; c++) {
      if (!/double\s*picks?\s*after/i.test(row[c] ?? "")) continue;
      for (let cc = c + 1; cc < row.length; cc++) {
        const v = (row[cc] ?? "").trim();
        if (!v) continue;
        const n = Number(v);
        return Number.isInteger(n) && n > 0 ? n : null;
      }
    }
  }
  return null;
}
