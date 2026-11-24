// Engine checks: spec examples, word rules, the walkthrough line, the puzzle
// bank (re-proved from scratch), and hint speed.
// Usage: node scripts/test-engine.mjs [boardsToReprove=30]
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

let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.log('FAIL', msg); } };

// §3–4: tiers, notch, mass, torque
for (const [w, notch, torque] of [['SEA', 2, 6], ['STONE', 2, 10], ['GAME', 3, 12], ['WAVE', 4, 16], ['JAR', 5, 15]]) {
  ok(E.notchOf(w) === notch, `${w} notch ${E.notchOf(w)} ≠ ${notch}`);
  ok(E.torqueOf(w) === torque, `${w} torque ${E.torqueOf(w)} ≠ ${torque}`);
}
// §5: tolerance
ok([-1, 0, 1].every(E.isBalanced) && ![-2, 2].some(E.isBalanced), 'tolerance ±1');

// §7: word rules
const p0 = { rack: 'JARSEAT', start: -20, maxMoves: 3 };
ok(E.checkWord('JA', 'JARSEAT', [], 3) !== '', 'rejects 2 letters');
ok(E.checkWord('JARS', 'JARSEAT', [], 3) === '', 'accepts JARS');
ok(E.checkWord('JAZZ', 'JARSEAT', [], 3) !== '', 'rejects missing tiles');
ok(E.checkWord('SEAT', 'SEAT', [{ word: 'SEAT', side: 'L' }], 3) !== '', 'rejects repeated word');
ok(E.checkWord('XQZT', 'XQZT', [], 3) !== '', 'rejects non-words');
ok(E.checkWord('SEA', 'SEA', [], 0) !== '', 'rejects past move cap');
ok(E.netOf(p0, [{ word: 'JAR', side: 'R' }, { word: 'SEA', side: 'L' }]) === -20 + 15 - 6, 'net torque');
ok(E.rackAfter(p0, [{ word: 'JAR', side: 'R' }]) === 'SEAT', 'tiles consumed');

// Words are 3–5 letters.
ok(E.checkWord('STONE', 'STONES', [], 3) === '', 'accepts 5 letters');
ok(E.checkWord('STONES', 'STONES', [], 3) !== '', 'rejects 6 letters');
ok(!E.isWord('STONES'), 'dictionary holds no 6-letter words');

// How-to-play clips: the stories they tell must be true under the engine.
const clip = (anchors, rack, moves) => {
  const p = { rack, start: E.anchorNet(anchors) };
  const placed = [];
  for (const w of moves) {
    ok(E.checkWord(w, E.rackAfter(p, placed), placed, 9) === '', `clip word ${w} legal from ${rack}`);
    placed.push({ word: w, side: 'R' });
  }
  return E.netOf(p, placed);
};
ok(clip([{ side: 'L', notch: 3, mass: 9 }], 'JSAEROHWT', ['JAR', 'HOW']) === 0, 'level clip balances');
ok(clip([{ side: 'L', notch: 2, mass: 11 }], 'WAVESEA', ['WAVE', 'SEA']) === 0, 'torque clip balances');
const spendAnchors = [{ side: 'L', notch: 5, mass: 5 }, { side: 'L', notch: 3, mass: 2 }];
ok(!E.isBalanced(clip(spendAnchors, 'JOBKITE', ['JOKE', 'BIT'])), 'spend clip: JOKE then BIT stays tipped');
ok(E.isBalanced(clip(spendAnchors, 'JOBKITE', ['JOB', 'KIT'])), 'spend clip: JOB + KIT balances');

// Walkthrough: JAR then HOW on the right balances the practice beam exactly.
const tut = { rack: 'JSAEROHWT', anchors: [{ side: 'L', notch: 3, mass: 9 }], start: -27, par: 2, maxMoves: 3 };
ok(E.anchorNet(tut.anchors) === tut.start, 'tutorial anchors');
const tp = [];
for (const w of ['JAR', 'HOW']) {
  ok(E.checkWord(w, E.rackAfter(tut, tp), tp, tut.maxMoves - tp.length) === '', `tutorial ${w} legal`);
  tp.push({ word: w, side: 'R' });
}
ok(E.netOf(tut, tp) === 0, 'tutorial balances at 0');

// Hint step 1: position checks and move judging.
const a0 = E.assess(tut, []);
ok(a0.status === 'par' && a0.remaining === 2, `tutorial start is on par (${JSON.stringify(a0)})`);
const jR = E.judgeMove(tut, [], 'JAR', 'R');
ok(jR.status === 'par' && jR.remaining === 1, 'JAR right keeps par');
ok(E.judgeMove(tut, [], 'JAR', 'L').status === 'dead', 'JAR left is a dead end');
const aDead = E.assess(tut, [{ word: 'JAR', side: 'L' }]);
ok(aDead.status === 'dead' && aDead.undoToLive === 1 && aDead.undoToPar === 1, `dead end says undo 1 (${JSON.stringify(aDead)})`);
ok(E.judgeMove(tut, [{ word: 'JAR', side: 'R' }], 'HOW', 'R').wins, 'HOW right wins');
ok(E.judgeMove(tut, [], 'JA', 'R').illegal, 'judging a 2-letter word reports why');
ok(E.heavyLetter('WAVE') === 'W' && E.heavyLetter('JAZZ') === 'J', 'heavy letter');
// A 'cap' position exists on a real board: par lost, but still balanceable.
{
  let found = null;
  let key;
  let p;
  for ([key, p] of Object.entries(self.FULCRUM_BANK.days).slice(0, 7)) {
    for (const c of E.makeSolver(p.rack).cands) {
      for (const side of ['L', 'R']) {
        if (E.judgeMove(p, [], c.words[0], side).status === 'cap') { found = { word: c.words[0], side }; break; }
      }
      if (found) break;
    }
    if (found) break;
  }
  ok(found, 'the first week has an opening that loses par but stays balanceable');
  if (found) {
    const st = E.assess(p, [{ word: found.word, side: found.side }]);
    ok(st.status === 'cap' && st.undoToPar === 1 && st.remaining <= p.maxMoves - 1, `${key} cap position says undo 1 for par`);
  }
}

// Bank: every board's line replays legally; a sample is re-proved from scratch.
const bank = self.FULCRUM_BANK;
ok(bank && bank.v === E.fingerprint(), 'bank matches the rule fingerprint');
const days = Object.entries(bank.days);
const reprove = Number(process.argv[2] || 30);
let t = Date.now();
days.forEach(([key, p], i) => {
  ok(!E.isBalanced(p.start), `${key} starts balanced`);
  ok(E.anchorNet(p.anchors) === p.start, `${key} anchors`);
  ok(p.maxMoves === p.par + 1 && p.rack.length === E.DIFFICULTY[p.difficulty].rack, `${key} config`);
  ok(E.difficultyFor(key) === p.difficulty, `${key} weekday difficulty`);
  const placed = [];
  for (const m of p.line) {
    ok(E.checkWord(m.word, E.rackAfter(p, placed), placed, p.maxMoves - placed.length) === '', `${key} line word ${m.word}`);
    placed.push(m);
  }
  ok(placed.length === p.par && E.isBalanced(E.netOf(p, placed)), `${key} line balances at par`);
  if (i < reprove) ok(E.makeSolver(p.rack).minMoves(p.start, p.par) === p.par, `${key} par re-proof`);
});
console.log(`bank: ${days.length} boards, ${Math.min(reprove, days.length)} re-proved in ${Date.now() - t}ms`);

// Determinism: rebuilding a bank day from its date alone gives the same board.
const [k0, b0] = days.find(([, p]) => p.difficulty === 'medium');
const rebuilt = E.buildDaily(k0);
ok(rebuilt.rack === b0.rack && rebuilt.start === b0.start && rebuilt.salt === b0.salt, `${k0} rebuilds identically`);

// Hint speed from the opening position, the slowest case, per difficulty.
for (const diff of ['easy', 'medium', 'hard']) {
  const [key, p] = days.find(([, q]) => q.difficulty === diff);
  t = Date.now();
  const h = E.hint(p, []);
  const ms = Date.now() - t;
  ok(h && h.remaining === p.par, `${key} hint finds a par line`);
  console.log(`hint ${diff.padEnd(6)} ${key}: ${h ? `${h.word}${h.side} (${h.line.map((m) => m.word + m.side).join(' ')})` : 'none'} in ${ms}ms`);
}

console.log(fails ? `${fails} failure(s)` : 'all checks passed');
process.exit(fails ? 1 : 0);
