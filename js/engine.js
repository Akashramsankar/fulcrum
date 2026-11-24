/* Fulcrum — game engine.
 * Pure logic, no DOM: tiers, torque, the par solver, the seeded daily generator
 * and hints. Runs in the browser (self.FulcrumEngine) and in Node (module.exports).
 *
 * Sign convention: net torque = right − left. Negative = left heavy.
 * A rack is a string of letters; letter counts are Uint8Array(26).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FulcrumEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = 2; // generator version: bump to change every future board
  const DICT_VERSION = 'enable1-3to5+common10k/2'; // the one dictionary used by generation and play
  const NOTCHES = 5;
  const MIN_WORD = 3;
  const MAX_WORD = 5; // rule change from the spec: see README, "Why words are capped at 5"
  const TOLERANCE = 1;

  const TIER_LETTERS = ['', 'AEIOU', 'LNRST', 'BCDGMP', 'FHVWY', 'JKQXZ'];
  const TIER = new Uint8Array(26);
  TIER_LETTERS.forEach((ls, t) => { for (const ch of ls) TIER[ch.charCodeAt(0) - 65] = t; });
  const tierOf = (ch) => TIER[ch.charCodeAt(0) - 65];

  // Par, rack size and move cap per difficulty. maxMoves = par + 1.
  // Par alone doesn't set difficulty (spec §16 G): the quality gate does too.
  //   good: how many distinct opening moves keep par within reach (fewer = tighter)
  //   trap: share of openings that bring the beam closer to level but miss par
  const DIFFICULTY = {
    easy: { name: 'Easy', par: 3, rack: 12, stars: 1, good: [40, 1e9], trap: 0 },
    medium: { name: 'Medium', par: 3, rack: 15, stars: 2, good: [10, 150], trap: 0.25 },
    hard: { name: 'Hard', par: 4, rack: 18, stars: 3, good: [5, 250], trap: 0.35 },
  };
  // UTC weekday → difficulty. Sunday = 0.
  const WEEK = ['hard', 'easy', 'easy', 'medium', 'medium', 'hard', 'medium'];

  /* ---------------- Word maths ---------------- */
  function notchOf(word) {
    let n = 0;
    for (const ch of word) n = Math.max(n, tierOf(ch));
    return n;
  }
  const massOf = (word) => word.length;
  const torqueOf = (word) => word.length * notchOf(word);
  const isBalanced = (net) => Math.abs(net) <= TOLERANCE;

  function countsOf(str) {
    const c = new Uint8Array(26);
    for (let i = 0; i < str.length; i++) c[str.charCodeAt(i) - 65]++;
    return c;
  }
  function fitsCounts(need, have) {
    for (let i = 0; i < 26; i++) if (need[i] > have[i]) return false;
    return true;
  }
  /** Can `word` be spelled from the letters in `rack` (a string)? */
  const canSpell = (word, rack) => fitsCounts(countsOf(word), countsOf(rack));
  /** `rack` with the letters of `word` removed (one tile per letter). */
  function consume(rack, word) {
    const out = [...rack];
    for (const ch of word) out.splice(out.indexOf(ch), 1);
    return out.join('');
  }

  /* ---------------- Dictionary ---------------- */
  let WORDS = null; // Set of every valid word
  let COMMON = null; // Set of everyday words
  let KEYS = null; // anagram classes: { sorted, len, t, mask, need:[[letter,count]...], words, common }
  let POOL = null; // words the generator builds racks from: everyday, 3–5 letters
  // Kept out of intended lines and hints: names that survive lower-casing, and
  // words that read as slurs. Players may still place any valid word.
  const POOL_BLOCK = new Set(('JOHN JOHNS KIRK KEN KAY JEW JEWS JIM JIMMY JOE JON JAN JUN JUL JOSH JACK MAX REX ROX TEX BETH BILLY BOBBY ' +
    'CHAD CHEVY DEV DOW HARRY HENRY HONG JENNY JERRY JILL KELLY KENT KERRY NANCY PERRY RALPH RICK RUTH SALLY TERRY ' +
    'TOMMY TONY TROY WELSH YANG HON GAY GAYS SPANK THONG WHATS ' +
    'FAG FAGS DYKE DYKES KIKE KIKES SPIC SPICS WOP WOPS JAP JAPS GOOK GOOKS HOMO FUCK FUCKS SHIT DICK DICKS COCK COCKS ' +
    'PISS TWAT JIZZ SPAZ KKK XXX PORN SEX SEXY HELL DAMN CRAP WANK SUCK SUCKS').split(' '));

  function maskOf(str) {
    let m = 0;
    for (let i = 0; i < str.length; i++) m |= 1 << (str.charCodeAt(i) - 65);
    return m;
  }

  function loadDictionary(words, common) {
    words = words.filter((w) => w.length >= MIN_WORD && w.length <= MAX_WORD);
    WORDS = new Set(words);
    COMMON = new Set(common.filter((w) => WORDS.has(w)));
    const byKey = new Map();
    for (const w of words) {
      const sorted = [...w].sort().join('');
      let k = byKey.get(sorted);
      if (!k) {
        const c = countsOf(sorted);
        const need = [];
        for (let i = 0; i < 26; i++) if (c[i]) need.push([i, c[i]]);
        k = { sorted, len: w.length, t: torqueOf(w), mask: maskOf(sorted), need, words: [], common: [] };
        byKey.set(sorted, k);
      }
      k.words.push(w);
      if (COMMON.has(w) && !POOL_BLOCK.has(w)) k.common.push(w);
    }
    KEYS = [...byKey.values()];
    POOL = [...COMMON].filter((w) => w.length >= MIN_WORD && w.length <= MAX_WORD && !POOL_BLOCK.has(w) && !/Q(?!U)/.test(w)).sort();
  }
  const isWord = (w) => !!WORDS && WORDS.has(w);
  const isCommon = (w) => !!COMMON && COMMON.has(w) && !POOL_BLOCK.has(w);

  /* ---------------- Solver ----------------
     A solution is a set of words (each on a side) whose letters fit the rack and
     whose signed torques bring the net into ±1. Order never changes the result,
     so the search runs over "sub-racks": the multiset of tiles still unused,
     packed into one mixed-radix integer. canFinish(S, net, r) is memoised on
     (sub-rack, net) → the deepest r already proven to fail, so the iterative
     deepening that proves par shares all its work.

     Words are grouped into anagram classes. Two different words never consume
     different tiles if they are anagrams, so the class is all the search needs;
     the "no repeated word" rule only matters when the same class is used twice,
     which the class's word count bounds. */
  function makeSolver(rack, { pool = 'all', used = null } = {}) {
    const rc = countsOf(rack);
    const letters = []; // distinct rack letters
    for (let i = 0; i < 26; i++) if (rc[i]) letters.push(i);
    const slot = new Int8Array(26).fill(-1);
    letters.forEach((l, j) => { slot[l] = j; });
    const place = [];
    let full = 0;
    let p = 1;
    for (const l of letters) { place.push(p); full += rc[l] * p; p *= rc[l] + 1; }
    const radix = letters.map((l) => rc[l] + 1);
    const rackMask = maskOf(rack);
    const tiers = letters.map((l) => TIER[l]);

    // Candidate classes: everything spellable from the whole rack.
    const cands = [];
    for (const k of KEYS) {
      if (k.len > rack.length || (k.mask & ~rackMask)) continue;
      let ok = true;
      for (const [l, n] of k.need) if (n > rc[l]) { ok = false; break; }
      if (!ok) continue;
      let words = pool === 'common' ? k.common : k.words;
      if (used && used.size) words = words.filter((w) => !used.has(w));
      if (!words.length) continue;
      let v = 0;
      const need = k.need.map(([l, n]) => { v += n * place[slot[l]]; return [slot[l], n]; });
      cands.push({ k, t: k.t, v, need, len: k.len, words });
    }
    cands.sort((a, b) => b.t - a.t || a.k.sorted.localeCompare(b.k.sorted));
    const byT = new Map();
    cands.forEach((c, i) => {
      if (!byT.has(c.t)) byT.set(c.t, []);
      byT.get(c.t).push(i);
    });

    const digits = new Int32Array(letters.length);
    function decode(S) {
      let letterCount = 0;
      let maxTier = 0;
      for (let j = 0; j < letters.length; j++) {
        const d = S % radix[j];
        S = (S - d) / radix[j];
        digits[j] = d;
        if (d) { letterCount += d; if (tiers[j] > maxTier) maxTier = tiers[j]; }
      }
      return { letterCount, maxTier, d: Array.from(digits) };
    }
    const fits = (c, d) => c.need.every(([j, n]) => d[j] >= n);

    const memo = new Map(); // (S, net) → deepest r proven to fail
    const NET_SPAN = 4096;
    const mkey = (S, net) => S * NET_SPAN + net + NET_SPAN / 2;
    let nodes = 0;

    function canFinish(S, net, r) {
      if (Math.abs(net) <= TOLERANCE) return true;
      if (r <= 0) return false;
      const key = mkey(S, net);
      const failed = memo.get(key);
      if (failed !== undefined && failed >= r) return false;
      nodes++;
      const { letterCount, maxTier, d } = decode(S);
      let ok = false;
      // Bound: r words can't add more than letterCount × maxTier torque.
      if (letterCount >= MIN_WORD && letterCount * maxTier >= Math.abs(net) - TOLERANCE) {
        if (r === 1) {
          const a = Math.abs(net);
          for (let t = a - TOLERANCE; t <= a + TOLERANCE && !ok; t++) {
            const list = byT.get(t);
            if (list) for (const i of list) if (fits(cands[i], d)) { ok = true; break; }
          }
        } else {
          for (const c of cands) {
            if (c.len > letterCount || !fits(c, d)) continue;
            const S2 = S - c.v;
            if (canFinish(S2, net + c.t, r - 1) || canFinish(S2, net - c.t, r - 1)) { ok = true; break; }
          }
        }
      }
      if (!ok) memo.set(key, Math.max(failed || 0, r));
      return ok;
    }

    /** Fewest words that balance from `net`, up to maxDepth (Infinity if none). */
    function minMoves(net, maxDepth) {
      for (let r = 0; r <= maxDepth; r++) if (canFinish(full, net, r)) return r;
      return Infinity;
    }

    /** Every good move from (S, net) with r words left: [{c, side}] (side +1 = right). */
    function goodMoves(S, net, r) {
      const out = [];
      if (r <= 0 || Math.abs(net) <= TOLERANCE) return out;
      const { d } = decode(S);
      for (const c of cands) {
        if (!fits(c, d)) continue;
        for (const side of [-1, 1]) if (canFinish(S - c.v, net + side * c.t, r - 1)) out.push({ c, side });
      }
      return out;
    }

    /** One shortest line from the full rack, as words with sides. */
    function line(net, maxDepth, usedWords = new Set()) {
      const m = minMoves(net, maxDepth);
      if (!isFinite(m)) return null;
      // The solver treats anagram classes as reusable; the rules don't let a word
      // repeat, so walk the good moves with backtracking until a line has no repeats.
      const taken = new Set(usedWords);
      let budget = 20000;
      function walk(S, n, r) {
        if (r === 0) return Math.abs(n) <= TOLERANCE ? [] : null;
        const opts = [];
        for (const mv of goodMoves(S, n, r)) {
          for (const w of mv.c.words) {
            if (taken.has(w)) continue;
            // Prefer everyday words, then moves that leave the beam closest to level.
            opts.push({ ...mv, w, score: (isCommon(w) ? 0 : 1000) + Math.abs(n + mv.side * mv.c.t) });
          }
        }
        opts.sort((a, b) => a.score - b.score || (a.w < b.w ? -1 : 1));
        for (const o of opts) {
          if (--budget < 0) return null;
          taken.add(o.w);
          const rest = walk(S - o.c.v, n + o.side * o.c.t, r - 1);
          taken.delete(o.w);
          if (rest) return [{ word: o.w, side: o.side > 0 ? 'R' : 'L', torque: o.c.t }, ...rest];
        }
        return null;
      }
      for (let r = m; r <= maxDepth; r++) {
        const seq = walk(full, net, r);
        if (seq) return seq;
      }
      return null;
    }

    return { full, cands, canFinish, minMoves, goodMoves, line, decode, stats: () => ({ nodes, memo: memo.size, cands: cands.length }) };
  }

  /* ---------------- Seeded randomness ---------------- */
  function hashString(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
  function shuffle(rng, arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // Spare tiles: roughly English frequencies, minus J/Q/X/Z (a stray Q is no fun).
  const SPARE_BAG = 'EEEEEAAAAIIIOOOUNNNRRRSSSTTTLLDDCCMMPPGGBBHHFFWYVK';
  // At most two copies of any tier-5 letter, so racks don't read as XXXXX.
  const heavyOk = (s) => { const c = countsOf(s); for (const ch of TIER_LETTERS[5]) if (c[ch.charCodeAt(0) - 65] > 2) return false; return true; };

  /* ---------------- Anchors ----------------
     Anchors are fixed blocks: { side: 'L'|'R', notch, mass }. Their torque is
     mass × notch. The generator picks anchors whose net equals the start torque. */
  function anchorsFor(rng, net) {
    const heavy = net > 0 ? 'R' : 'L';
    const light = heavy === 'R' ? 'L' : 'R';
    const out = [];
    let target = Math.abs(net);
    // Half the time, a counterweight on the light side makes the beam read as a tug of war.
    if (rng() < 0.5) {
      const notch = 1 + Math.floor(rng() * 4);
      const mass = 2 + Math.floor(rng() * 5);
      out.push({ side: light, notch, mass });
      target += notch * mass;
    }
    const single = (x) => {
      for (const n of shuffle(rng, [1, 2, 3, 4, 5])) if (x % n === 0 && x / n >= 2 && x / n <= 12) return { side: heavy, notch: n, mass: x / n };
      return null;
    };
    for (let tries = 0; tries < 200; tries++) {
      const parts = [];
      let rest = target;
      while (rest > 60 || (parts.length < 2 && rest > 0 && !single(rest))) {
        const n = 2 + Math.floor(rng() * 4);
        const m = 2 + Math.floor(rng() * 11);
        if (n * m > rest - 2) break;
        parts.push({ side: heavy, notch: n, mass: m });
        rest -= n * m;
      }
      const last = single(rest);
      if (last && parts.length < 3) return out.concat(parts, [last]);
    }
    return null;
  }
  const anchorNet = (anchors) => anchors.reduce((s, a) => s + (a.side === 'R' ? 1 : -1) * a.mass * a.notch, 0);

  /* ---------------- Daily generation ----------------
     With words capped at 5 letters, a single word tops out at 25 torque, so
     "one longer word" can't shortcut a big imbalance and ordinary racks support
     a provable par. For each salt:
     1. Build the rack from `par` everyday words plus spare tiles, shuffled.
     2. Scan start torques in a seeded order. Keep the first one where the full
        dictionary proves the minimum is exactly par, an everyday-word line of
        that length exists, and the quality gate for the difficulty passes.
     3. Build anchors that produce that start torque.
     The racks aren't engineered, so start torques and answers vary day to day. */
  function difficultyFor(dateKey) {
    const [y, m, d] = dateKey.split('-').map(Number);
    return WEEK[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  }

  const SCAN_PER_RACK = 24;

  function attempt(dateKey, diffKey, salt) {
    const cfg = DIFFICULTY[diffKey];
    const rng = mulberry32(hashString(`fulcrum:v${VERSION}:${DICT_VERSION}:${dateKey}:${diffKey}:${salt}`));
    // 1. rack
    const words = [];
    let total = 0;
    for (let k = 0; k < 2000 && words.length < cfg.par; k++) {
      const w = pick(rng, POOL);
      const after = cfg.par - words.length - 1;
      if (total + w.length + after * MIN_WORD <= cfg.rack - 1 && !words.includes(w)) { words.push(w); total += w.length; }
    }
    if (words.length < cfg.par) return null;
    let rack = words.join('');
    while (rack.length < cfg.rack) rack += pick(rng, SPARE_BAG);
    if (!heavyOk(rack)) return null;
    rack = shuffle(rng, [...rack]).join('');
    // 2. start torque
    const solver = makeSolver(rack);
    const easy = makeSolver(rack, { pool: 'common' });
    const sign = rng() < 0.5 ? -1 : 1;
    const mags = [];
    for (let m = TOLERANCE + 2; m <= NOTCHES * cfg.rack; m++) mags.push(m);
    for (const mag of shuffle(rng, mags).slice(0, SCAN_PER_RACK)) {
      const start = sign * mag;
      if (solver.minMoves(start, cfg.par) !== cfg.par) continue;
      if (!isFinite(easy.minMoves(start, cfg.par))) continue;
      // 3. anchors
      const anchors = anchorsFor(rng, start);
      if (!anchors || anchorNet(anchors) !== start) continue;
      const p = { dateKey, difficulty: diffKey, salt, rack, anchors, start, par: cfg.par, maxMoves: cfg.par + 1, solver };
      p.quality = quality(p);
      if (!acceptable(p.quality, diffKey)) continue;
      p.intended = easy.line(start, cfg.par) || solver.line(start, cfg.par);
      if (!p.intended) continue;
      return p;
    }
    return null;
  }

  /** Quality gate (spec §16 D–F): a few good openings, plenty of tempting bad ones. */
  function quality(p) {
    const s = p.solver;
    const good = s.goodMoves(s.full, p.start, p.par);
    const total = s.cands.length * 2;
    const goodClasses = new Set(good.map((m) => m.c.k.sorted + m.side)).size;
    // Openings that look right (they bring the beam closer to level) but can't make par.
    let tempting = 0;
    let temptingBad = 0;
    for (const c of s.cands) {
      for (const side of [-1, 1]) {
        const after = p.start + side * c.t;
        if (Math.abs(after) >= Math.abs(p.start)) continue;
        tempting++;
        if (!s.canFinish(s.full - c.v, after, p.par - 1)) temptingBad++;
      }
    }
    return { goodOpenings: goodClasses, openings: total, tempting, temptingBad, trapRate: tempting ? temptingBad / tempting : 0 };
  }

  function acceptable(q, diffKey) {
    const cfg = DIFFICULTY[diffKey];
    return q.goodOpenings >= cfg.good[0] && q.goodOpenings <= cfg.good[1] && q.trapRate >= cfg.trap;
  }

  /** The daily board for a UTC date key. Deterministic; `salt` replays a known build. */
  function buildDaily(dateKey, { salt: knownSalt = null, maxSalts = 4000 } = {}) {
    const diffKey = difficultyFor(dateKey);
    if (knownSalt !== null) {
      const p = attempt(dateKey, diffKey, knownSalt);
      if (p) return finalize(p);
    }
    for (let salt = 0; salt < maxSalts; salt++) {
      const p = attempt(dateKey, diffKey, salt);
      if (p) return finalize(p);
    }
    throw new Error(`No board for ${dateKey}`);
  }
  function finalize(p) {
    const { solver, ...rest } = p;
    return rest;
  }

  /* ---------------- In-game helpers ---------------- */
  function netOf(puzzle, placed) {
    let net = puzzle.start;
    for (const m of placed) net += (m.side === 'R' ? 1 : -1) * torqueOf(m.word);
    return net;
  }
  function rackAfter(puzzle, placed) {
    let r = puzzle.rack;
    for (const m of placed) r = consume(r, m.word);
    return r;
  }

  /** Reasons a word can't be placed, or '' if it can (spec §7). */
  function checkWord(word, rack, placed, movesLeft) {
    if (word.length < MIN_WORD) return 'Words need at least 3 letters';
    if (word.length > MAX_WORD) return 'Words are 3 to 5 letters';
    if (movesLeft <= 0) return 'No moves left';
    if (!canSpell(word, rack)) return 'Not enough tiles';
    if (placed.some((m) => m.word === word)) return `${word} is already on the beam`;
    if (!isWord(word)) return `${word} isn’t in the word list`;
    return '';
  }

  /** Is any word at all still spellable from `rack` (and unused)? */
  function hasAnyWord(rack, used) {
    const rc = countsOf(rack);
    const rm = maskOf(rack);
    for (const k of KEYS) {
      if (k.len > rack.length || (k.mask & ~rm)) continue;
      let ok = true;
      for (const [l, n] of k.need) if (n > rc[l]) { ok = false; break; }
      if (ok && k.words.some((w) => !used.has(w))) return true;
    }
    return false;
  }

  /** The shortest way to finish from here within `movesLeft`, preferring everyday words. */
  function hint(puzzle, placed) {
    const rack = rackAfter(puzzle, placed);
    const net = netOf(puzzle, placed);
    const left = puzzle.maxMoves - placed.length;
    const used = new Set(placed.map((m) => m.word));
    const all = makeSolver(rack, { used });
    const m = all.minMoves(net, left);
    if (!isFinite(m)) return null;
    const easy = makeSolver(rack, { pool: 'common', used });
    const seq = (isFinite(easy.minMoves(net, m)) && easy.line(net, m, used)) || all.line(net, m, used);
    return seq && seq.length ? { ...seq[0], remaining: m, line: seq } : null;
  }

  /** Can the board still be balanced within the moves left? */
  function stillSolvable(puzzle, placed) {
    return assess(puzzle, placed).status !== 'dead';
  }

  /** Fewest words that finish from this position within the move cap (Infinity if none). */
  function wordsToFinish(puzzle, placed) {
    const net = netOf(puzzle, placed);
    if (isBalanced(net)) return 0;
    const used = new Set(placed.map((m) => m.word));
    return makeSolver(rackAfter(puzzle, placed), { used }).minMoves(net, puzzle.maxMoves - placed.length);
  }

  /** Fewest undos that return to a position that can still make `goal` ('par' | 'cap'). */
  function undosTo(puzzle, placed, goal) {
    for (let k = 1; k <= placed.length; k++) {
      const back = placed.slice(0, -k);
      const m = wordsToFinish(puzzle, back);
      if (goal === 'cap' ? isFinite(m) : back.length + m <= puzzle.par) return k;
    }
    return placed.length;
  }

  /**
   * Where the player stands (hint step 1):
   *   'par'  — par is still reachable; `remaining` words to go
   *   'cap'  — par is gone, but the beam can still balance within the move cap
   *   'dead' — no way to balance from here within the cap
   * `undoToPar` / `undoToLive`: how many words to take back to get there again.
   */
  function assess(puzzle, placed) {
    const m = wordsToFinish(puzzle, placed);
    if (!isFinite(m)) return { status: 'dead', remaining: Infinity, undoToLive: undosTo(puzzle, placed, 'cap'), undoToPar: undosTo(puzzle, placed, 'par') };
    if (placed.length + m <= puzzle.par) return { status: 'par', remaining: m };
    return { status: 'cap', remaining: m, undoToPar: undosTo(puzzle, placed, 'par') };
  }

  /** Judge a move before it's made: the position it would lead to, or why it's illegal. */
  function judgeMove(puzzle, placed, word, side) {
    const why = checkWord(word, rackAfter(puzzle, placed), placed, puzzle.maxMoves - placed.length);
    if (why) return { illegal: why };
    const after = placed.concat([{ word, side }]);
    const net = netOf(puzzle, after);
    if (isBalanced(net)) return { status: after.length <= puzzle.par ? 'par' : 'cap', remaining: 0, wins: true };
    return assess(puzzle, after);
  }

  /** The letter in `word` that sets its notch (the first of the heaviest). */
  function heavyLetter(word) {
    const n = notchOf(word);
    return [...word].find((ch) => tierOf(ch) === n);
  }

  /** Identifies the exact rule set: anything cached against an older fingerprint is stale. */
  const fingerprint = () => `${VERSION}:${DICT_VERSION}:${MAX_WORD}:${JSON.stringify(DIFFICULTY)}:${WEEK.join(',')}`;

  return {
    VERSION, DICT_VERSION, NOTCHES, MIN_WORD, MAX_WORD, TOLERANCE, TIER_LETTERS, DIFFICULTY, WEEK,
    tierOf, notchOf, massOf, torqueOf, isBalanced, canSpell, consume, countsOf,
    loadDictionary, isWord, isCommon, makeSolver, anchorsFor, anchorNet,
    difficultyFor, attempt, quality, acceptable, buildDaily,
    netOf, rackAfter, checkWord, hasAnyWord, hint, stillSolvable, wordsToFinish, assess, judgeMove, heavyLetter, fingerprint,
    hashString, mulberry32,
  };
});
