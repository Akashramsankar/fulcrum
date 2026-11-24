// Puzzle quality analyzer (spec §17). Development only: scores are for
// evaluation and playtest comparison, not automatic publication.
//
// For each board in the bank it reports:
//  1. uniqueness   — distinct par-length solutions (word sets with arms)
//  2. decisions    — steps on the solver's line where several moves keep par AND some don't
//  3. forced       — steps on that line where exactly one move keeps par
//  4. deadEnds     — share of legal openings that can't balance even within the move cap;
//                    trapRate: share of "closer to level" openings that miss par
//  5. wordDep      — par minus the moves pure torque arithmetic would need if letters were free;
//                    > 0 means letter supply, not arithmetic, is what makes it hard
//  6. elegance     — tiles used by the line, spare tiles, everyday-words-only, mean word length
//
// Writes data/quality.json (full diagnostics) and prints a summary table.
// Usage: node scripts/analyze.mjs [limit] [from-date]
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
globalThis.self = globalThis;
require(join(root, 'js', 'words.js'));
require(join(root, 'js', 'puzzles.js'));
const E = require(join(root, 'js', 'engine.js'));
E.loadDictionary(self.FULCRUM_WORDS.split(' '), self.FULCRUM_COMMON.split(' '));

const limit = Number(process.argv[2] || Infinity);
const from = process.argv[3] || '';
const SOLUTION_CAP = 200000;

function analyze(key, p) {
  const s = E.makeSolver(p.rack);
  const t0 = Date.now();

  // 1. uniqueness: enumerate par-length solutions in canonical candidate order.
  let classSets = 0;
  let wordSets = 0;
  (function enumerate(S, net, r, start, mult) {
    if (wordSets >= SOLUTION_CAP) return;
    if (r === 0) { if (E.isBalanced(net)) { classSets++; wordSets += mult; } return; }
    if (E.isBalanced(net)) return; // would have ended earlier: not a par-length line
    const { d } = s.decode(S);
    for (let i = start; i < s.cands.length; i++) {
      const c = s.cands[i];
      if (!c.need.every(([j, n]) => d[j] >= n)) continue;
      for (const side of [-1, 1]) {
        const n2 = net + side * c.t;
        if (!s.canFinish(S - c.v, n2, r - 1)) continue;
        enumerate(S - c.v, n2, r - 1, i, mult * c.words.length);
      }
    }
  })(s.full, p.start, p.par, 0, 1);

  // 2–3. decisions and forced moves along the solver's line.
  const steps = [];
  let S = s.full;
  let net = p.start;
  for (let k = 0; k < p.line.length; k++) {
    const r = p.par - k;
    const { d } = s.decode(S);
    let legal = 0;
    for (const c of s.cands) if (c.need.every(([j, n]) => d[j] >= n)) legal += 2;
    const good = s.goodMoves(S, net, r).length;
    steps.push({ legal, good });
    const m = p.line[k];
    const c = s.cands.find((x) => x.words.includes(m.word));
    S -= c.v;
    net += (m.side === 'R' ? 1 : -1) * c.t;
  }
  const decisions = steps.filter((x) => x.good >= 2 && x.good < x.legal).length;
  const forced = steps.filter((x) => x.good === 1).length;

  // 4. dead ends from the opening.
  let openings = 0;
  let dead = 0;
  let tempting = 0;
  let temptingMiss = 0;
  for (const c of s.cands) {
    for (const side of [-1, 1]) {
      openings++;
      const n2 = p.start + side * c.t;
      if (!s.canFinish(s.full - c.v, n2, p.maxMoves - 1)) dead++;
      if (Math.abs(n2) < Math.abs(p.start)) {
        tempting++;
        if (!s.canFinish(s.full - c.v, n2, p.par - 1)) temptingMiss++;
      }
    }
  }

  // 5. word dependency: fewest moves if every candidate torque could be reused freely.
  const torques = [...new Set(s.cands.map((c) => c.t))];
  let frontier = new Set([p.start]);
  let torqueOnly = Infinity;
  for (let k = 1; k <= p.par && torqueOnly === Infinity; k++) {
    const next = new Set();
    for (const n of frontier) for (const t of torques) for (const v of [n + t, n - t]) {
      if (E.isBalanced(v)) torqueOnly = k;
      if (Math.abs(v) <= Math.abs(p.start) + 60) next.add(v);
    }
    frontier = next;
  }

  // 6. elegance of the published line.
  const tilesUsed = p.line.reduce((n, m) => n + m.word.length, 0);
  const allCommon = p.line.every((m) => E.isCommon(m.word));

  return {
    date: key, difficulty: p.difficulty, par: p.par, rack: p.rack, start: p.start,
    line: p.line.map((m) => m.word + m.side).join(' '),
    uniqueness: { classSets, wordSets, capped: wordSets >= SOLUTION_CAP },
    decisions: { count: decisions, steps },
    forced,
    deadEnds: { openings, dead, rate: +(dead / openings).toFixed(3), tempting, temptingMiss, trapRate: +(temptingMiss / (tempting || 1)).toFixed(3) },
    wordDep: { torqueOnlyMin: torqueOnly === Infinity ? null : torqueOnly, score: torqueOnly === Infinity ? p.par : p.par - torqueOnly },
    elegance: { tilesUsed, spare: p.rack.length - tilesUsed, allCommon, meanWordLen: +(tilesUsed / p.line.length).toFixed(2) },
    ms: Date.now() - t0,
    solver: s.stats(),
  };
}

const rows = [];
for (const [key, p] of Object.entries(self.FULCRUM_BANK.days)) {
  if (key < from) continue;
  if (rows.length >= limit) break;
  rows.push(analyze(key, p));
}
writeFileSync(join(root, 'data', 'quality.json'), JSON.stringify(rows, null, 1));

const pad = (s, n) => String(s).padEnd(n);
console.log(pad('date', 11) + pad('diff', 7) + pad('par', 4) + pad('solutions', 11) + pad('decide', 7) + pad('forced', 7) + pad('dead%', 7) + pad('trap%', 7) + pad('wordDep', 8) + pad('spare', 6) + 'line');
for (const r of rows) {
  console.log(pad(r.date, 11) + pad(r.difficulty, 7) + pad(r.par, 4) + pad(r.uniqueness.wordSets + (r.uniqueness.capped ? '+' : ''), 11) +
    pad(r.decisions.count, 7) + pad(r.forced, 7) + pad(Math.round(r.deadEnds.rate * 100), 7) + pad(Math.round(r.deadEnds.trapRate * 100), 7) +
    pad(r.wordDep.score, 8) + pad(r.elegance.spare, 6) + r.line);
}
const by = (d) => rows.filter((r) => r.difficulty === d);
for (const d of ['easy', 'medium', 'hard']) {
  const rs = by(d);
  if (!rs.length) continue;
  const med = (f) => { const v = rs.map(f).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
  console.log(`${d}: ${rs.length} boards · median solutions ${med((r) => r.uniqueness.wordSets)} · median trap ${Math.round(med((r) => r.deadEnds.trapRate) * 100)}% · median dead ${Math.round(med((r) => r.deadEnds.rate) * 100)}% · wordDep>0 on ${rs.filter((r) => r.wordDep.score > 0).length}`);
}
console.log(`wrote data/quality.json (${rows.length} boards)`);
