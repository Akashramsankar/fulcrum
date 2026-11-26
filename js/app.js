/* Fulcrum — UI: rack input, beam animation, persistence, archive, stats,
   sharing, leaderboard and the walkthrough. Game rules live in engine.js;
   shared conventions (modals, stats, leaderboard, ready card, coach) follow
   Cascade and Typeset so the workshop's games behave alike. */
(() => {
  'use strict';

  const E = self.FulcrumEngine;
  const $ = (id) => document.getElementById(id);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const pace = (ms) => (reduceMotion ? Math.min(ms, 120) : ms);

  /* ---------------- Puzzle selection (by local date) ----------------
     A new board at the player's local midnight. Day 0 = puzzle #1. Day numbers count
     calendar dates, so the local date is mapped onto a UTC timestamp before dividing. */
  const EPOCH = Date.UTC(2026, 10, 24); // months are 0-based -> 10 = November
  const DAY = 86400000;
  const pad = (n) => String(n).padStart(2, '0');
  const dayNumber = () => {
    const now = new Date();
    return Math.round((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - EPOCH) / DAY);
  };
  const dateForDay = (day) => new Date(EPOCH + day * DAY);
  const keyForDay = (day) => dateForDay(day).toISOString().slice(0, 10);
  const dayForKey = (key) => {
    const [y, m, d] = key.split('-').map(Number);
    return Math.round((Date.UTC(y, m - 1, d) - EPOCH) / DAY);
  };
  const fmtDate = (day, opts) => dateForDay(day).toLocaleDateString(undefined, { ...opts, timeZone: 'UTC' });

  /* ---------------- Storage ---------------- */
  const SAVE_KEY = 'fulcrum_progress_v1';
  const STATS_KEY = 'fulcrum_stats';
  const DAILY_KEY = 'fulcrum_daily_v1';
  const SEEN_KEY = 'fulcrum_seen';
  const readJSON = (key, fallback) => {
    try { return JSON.parse(localStorage.getItem(key) || 'null') || fallback; } catch (e) { return fallback; }
  };
  const writeJSON = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage blocked — progress just won't persist */ }
  };

  /* ---------------- State ---------------- */
  let activeDay = 0;
  let puzzle = null; // { day, dateKey, rack, anchors, start, par, maxMoves, difficulty, stars, line }
  let game = null; // { placed: [{word, side, tiles}], history, hints, won, time }
  let sel = []; // rack indices of the word being built, in order
  let arm = null; // 'L' | 'R'
  let busy = false;
  let hintData = null;
  let hintLevel = 0;
  let hintText = '';
  let tutorialMode = false;
  let tutStep = 0;
  let justPlaced = -1; // index in game.placed of the block to animate in

  const sigOf = (p) => `${E.fingerprint()}:${p.rack}:${p.start}`;
  const freshGame = () => ({ placed: [], history: [], hints: 0, won: false, time: 0 });

  function saveState() {
    if (tutorialMode || !game) return; // practice moves never touch a real day's save
    const all = readJSON(SAVE_KEY, {});
    all[activeDay] = { sig: sigOf(puzzle), ...game, time: elapsedNow() };
    writeJSON(SAVE_KEY, all);
  }
  function loadState(day) {
    const s = readJSON(SAVE_KEY, {})[day];
    return s && s.sig === sigOf(puzzle) && Array.isArray(s.placed) ? s : null;
  }

  /** A day's board: from the pre-built bank, then the local cache, else built here (same result). */
  function puzzleForDay(day) {
    const dateKey = keyForDay(day);
    const fp = E.fingerprint();
    const bank = self.FULCRUM_BANK;
    let p = bank && bank.v === fp ? bank.days[dateKey] : null;
    if (!p) {
      const cache = readJSON(DAILY_KEY, {});
      if (cache[dateKey] && cache[dateKey].v === fp) p = cache[dateKey].p;
      else {
        const b = E.buildDaily(dateKey);
        const line = E.hint({ ...b, maxMoves: b.par }, []);
        p = { difficulty: b.difficulty, salt: b.salt, rack: b.rack, anchors: b.anchors, start: b.start, par: b.par, maxMoves: b.maxMoves,
          line: line ? line.line.map(({ word, side }) => ({ word, side })) : b.intended };
        cache[dateKey] = { v: fp, p };
        writeJSON(DAILY_KEY, cache);
      }
    }
    return { day, dateKey, ...p, stars: E.DIFFICULTY[p.difficulty].stars };
  }

  /* ---------------- Derived state ---------------- */
  const net = () => E.netOf(puzzle, game.placed);
  const spentSet = () => new Set(game.placed.flatMap((m) => m.tiles));
  const rackLeft = () => { const s = spentSet(); return [...puzzle.rack].filter((_, i) => !s.has(i)).join(''); };
  const usedWords = () => new Set(game.placed.map((m) => m.word));
  const movesLeft = () => puzzle.maxMoves - game.placed.length;
  const selWord = () => sel.map((i) => puzzle.rack[i]).join('');
  const fmtNet = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');

  /* ---------------- Stats & streaks ----------------
     Currents' schema plus `solved`, so win % and Miss (played − solved) come for free.
     A day counts as played once a word is placed on today's beam. */
  const GRADE_KEYS = [['exceptional', 'Exceptional'], ['gold', 'Gold'], ['solved', 'Solved'], ['miss', 'Miss']];
  function loadStats() {
    const s = readJSON(STATS_KEY, {});
    for (const k of ['played', 'solved', 'currentStreak', 'maxStreak']) if (typeof s[k] !== 'number') s[k] = 0;
    if (typeof s.lastWonDay !== 'number') s.lastWonDay = -999;
    if (typeof s.lastPlayedDay !== 'number') s.lastPlayedDay = -999;
    if (!s.dist || typeof s.dist !== 'object') s.dist = {};
    GRADE_KEYS.forEach(([k]) => { if (typeof s.dist[k] !== 'number') s.dist[k] = 0; });
    return s;
  }
  const streakNow = (s) => (s.lastWonDay >= dayNumber() - 1 ? s.currentStreak : 0);
  const gradeKey = (diff) => (diff < 0 ? 'exceptional' : diff === 0 ? 'gold' : 'solved');
  function gradeFor(diff) {
    if (diff < 0) return ['EXCEPTIONAL', 'var(--jump)'];
    if (diff === 0) return ['GOLD', 'var(--color-close)'];
    return ['SOLVED', 'var(--accent)'];
  }
  function markPlayed() {
    if (tutorialMode || activeDay !== dayNumber()) return;
    const s = loadStats();
    if (s.lastPlayedDay === activeDay) return;
    s.played++;
    s.lastPlayedDay = activeDay;
    writeJSON(STATS_KEY, s);
  }
  // Only today's first solve counts; replays and archive solves are just for fun.
  function recordWin(diff) {
    const day = dayNumber();
    if (tutorialMode || activeDay !== day) return;
    const s = loadStats();
    if (s.lastWonDay === day) return;
    if (s.lastPlayedDay !== day) { s.played++; s.lastPlayedDay = day; }
    s.solved++;
    s.currentStreak = s.lastWonDay === day - 1 ? s.currentStreak + 1 : 1;
    s.maxStreak = Math.max(s.maxStreak, s.currentStreak);
    s.dist[gradeKey(diff)]++;
    s.lastWonDay = day;
    writeJSON(STATS_KEY, s);
  }
  function renderStats(prefix, s, curKey) {
    $(prefix + 'Played').textContent = s.played;
    $(prefix + 'Streak').textContent = streakNow(s);
    $(prefix + 'Max').textContent = s.maxStreak;
    if ($(prefix + 'Win')) $(prefix + 'Win').textContent = s.played ? Math.round((s.solved / s.played) * 100) : 0;
    const dist = { ...s.dist, miss: Math.max(0, s.played - s.solved - (s.lastPlayedDay === dayNumber() && s.lastWonDay !== dayNumber() ? 1 : 0)) };
    const keys = GRADE_KEYS.filter(([k]) => k !== 'exceptional' || dist[k] > 0); // under par shouldn't happen: par is proven
    const max = Math.max(1, ...keys.map(([k]) => dist[k] || 0));
    $(prefix + 'Dist').innerHTML = s.played === 0
      ? '<div class="sempty">Balance today\'s beam to start your distribution.</div>'
      : keys.map(([k, l]) => {
        const n = dist[k] || 0;
        const w = Math.max(10, (n / max) * 100);
        return `<div class="gd${k === curKey ? ' cur' : ''}"><span class="gl">${l}</span><div class="gb" style="width:${w}%">${n}</div></div>`;
      }).join('');
  }

  /* ---------------- Clock (as in Typeset) ----------------
     Runs while the board is on screen and unsolved; pauses while the tab is hidden.
     Undo and reset never rewind it, so the time a solve took is the leaderboard's tiebreak. */
  let runningSince = 0;
  const elapsedNow = () => (game ? game.time || 0 : 0) + (runningSince ? Date.now() - runningSince : 0);
  function startClock() { if (game && !tutorialMode && !game.won && !runningSince && !document.hidden) runningSince = Date.now(); }
  function pauseClock() { if (runningSince) { game.time = (game.time || 0) + Date.now() - runningSince; runningSince = 0; } }
  const fmtTime = (sec) => `${Math.floor(sec / 60)}:${pad(sec % 60)}`;
  function renderClock() {
    const txt = fmtTime(Math.floor(elapsedNow() / 1000));
    if ($('clock').textContent !== txt) $('clock').textContent = txt;
  }
  setInterval(() => { if (runningSince) renderClock(); }, 250);
  let resumeOnReturn = false;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { resumeOnReturn = !!runningSince; if (runningSince) { pauseClock(); saveState(); } }
    else if (resumeOnReturn) { resumeOnReturn = false; startClock(); }
  });
  window.addEventListener('pagehide', () => { if (runningSince) { pauseClock(); saveState(); } });

  /* ---------------- Beam ----------------
     Tilt is a picture of torque, not a simulation (spec §13): a gentle curve,
     capped so big imbalances stay readable, and nearly flat inside ±1. The beam
     follows a damped spring, so it overshoots slightly and settles. */
  const MAX_TILT = 15;
  function angleFor(n) {
    if (E.isBalanced(n)) return n * 0.4;
    return Math.sign(n) * Math.min(MAX_TILT, 2.5 + Math.abs(n) * 0.17);
  }
  const slotOf = (side, notch) => (side === 'L' ? 5 - notch : 5 + notch);

  function makeSpring(apply) {
    const s = { a: 0, v: 0, target: 0, raf: 0, last: 0 };
    function step(now) {
      const dt = Math.min(0.032, (now - s.last) / 1000);
      s.last = now;
      const acc = -95 * (s.a - s.target) - 10.5 * s.v; // ζ ≈ 0.54: one visible overshoot, then rest
      s.v += acc * dt;
      s.a += s.v * dt;
      if (Math.abs(s.a - s.target) < 0.01 && Math.abs(s.v) < 0.02) { s.a = s.target; s.v = 0; s.raf = 0; apply(s.a); return; }
      apply(s.a);
      s.raf = requestAnimationFrame(step);
    }
    s.to = (target, instant) => {
      s.target = target;
      if (instant || reduceMotion) { cancelAnimationFrame(s.raf); s.raf = 0; s.a = target; s.v = 0; apply(target); return; }
      if (!s.raf) { s.last = performance.now(); s.raf = requestAnimationFrame(step); }
    };
    return s;
  }
  const beamSpring = makeSpring((a) => $('beam').style.setProperty('--angle', `${a}deg`));

  function blockHTML(b, extra = '') {
    if (b.anchor) return `<div class="blk anchor${extra}" style="--m:${b.mass}" title="Anchor: mass ${b.mass}"><i></i><b>${b.mass}</b></div>`;
    return `<div class="blk${extra}" style="--m:${b.word.length}" title="${b.word}: ${b.word.length} × ${E.notchOf(b.word)} = ${E.torqueOf(b.word)}"><span>${b.word}</span></div>`;
  }

  /** Blocks per slot: anchors at the bottom, then words in the order they were placed. */
  function slotsFor(anchors, placed, ghost) {
    const slots = Array.from({ length: 11 }, () => []);
    anchors.forEach((a) => slots[slotOf(a.side, a.notch)].push({ anchor: true, mass: a.mass }));
    placed.forEach((m, k) => slots[slotOf(m.side, E.notchOf(m.word))].push({ word: m.word, k }));
    if (ghost) slots[slotOf(ghost.side, E.notchOf(ghost.word))].push({ word: ghost.word, ghost: true, bad: ghost.bad });
    return slots;
  }

  /** Letter-unit height so the tallest stack still fits, allowing for the beam's tilt. */
  function unitFor(scene, slots) {
    const h = scene.clientHeight || 240;
    const beamY = parseFloat(getComputedStyle(scene).getPropertyValue('--beam-y')) || 46;
    const half = (scene.clientWidth || 380) / 2;
    let u = 12;
    slots.forEach((list, i) => {
      const letters = list.reduce((n, b) => n + (b.anchor ? 0 : b.word.length), 0);
      if (!letters) return;
      const anchorsH = list.reduce((n, b) => n + (b.anchor ? 22 + Math.min(b.mass, 12) * 2 : 0), 0);
      const rise = Math.sin((MAX_TILT * Math.PI) / 180) * half * (Math.abs(i - 5) / 5.5);
      const room = h - beamY - 14 - rise - anchorsH - list.length * 2;
      u = Math.min(u, room / letters);
    });
    return Math.max(5, u);
  }

  function renderBeam({ instant = false } = {}) {
    const ghost = previewGhost();
    const slots = slotsFor(puzzle.anchors, game.placed, ghost);
    const scene = $('scene');
    scene.style.setProperty('--u', `${unitFor(scene, slots)}px`);
    $('stacks').innerHTML = slots.map((list) => `<div class="slot">${list.map((b) =>
      blockHTML(b, (b.ghost ? ` ghost${b.bad ? ' bad' : ''}` : '') + (b.k === justPlaced ? ' drop' : '') + (game.won && !b.ghost ? ' won' : ''))).join('')}</div>`).join('');
    justPlaced = -1;
    const landing = ghost ? slotOf(ghost.side, E.notchOf(ghost.word)) : -1;
    $('ticks').innerHTML = Array.from({ length: 11 }, (_, i) =>
      `<span class="${i === landing ? 'on' : ''}">${i === 5 ? '' : Math.abs(i - 5)}</span>`).join('');
    const n = net();
    beamSpring.to(angleFor(n), instant);
    const gb = $('ghostBeam');
    gb.classList.toggle('on', !!ghost && !ghost.bad && !game.won);
    if (ghost) gb.style.setProperty('--angle', `${angleFor(ghost.net)}deg`);
    renderGauge(n, ghost && !ghost.bad ? ghost.net : null);
    $('fulcrum').classList.toggle('lit', game.won);
    scene.classList.toggle('won', game.won);
  }

  function renderGauge(n, proj) {
    const range = Math.max(12, Math.abs(puzzle.start) * 1.08);
    const x = (v) => `${50 + Math.max(-1, Math.min(1, v / range)) * 48}%`;
    $('gaugeMark').style.setProperty('--x', x(n));
    $('gaugeGhost').classList.toggle('on', proj !== null && proj !== n);
    if (proj !== null) $('gaugeGhost').style.setProperty('--x', x(proj));
    $('gauge').classList.toggle('ok', E.isBalanced(n));
  }

  /* ---------------- Rack ---------------- */
  function renderRack({ enter = false } = {}) {
    const spent = spentSet();
    const word = selWord();
    const rack = $('rack');
    rack.style.setProperty('--cols', puzzle.rack.length === 15 ? 5 : 6);
    rack.classList.toggle('ok', word.length >= E.MIN_WORD && E.isWord(word));
    if (rack.children.length !== puzzle.rack.length || enter) {
      rack.innerHTML = [...puzzle.rack].map((ch, i) =>
        `<button class="tile${enter ? ' enter' : ''}" type="button" data-i="${i}" data-tier="${E.tierOf(ch)}" style="--delay:${i * 22}ms" aria-label="${ch}, tier ${E.tierOf(ch)}">${ch}<span class="tr">${E.tierOf(ch)}</span></button>`).join('');
    }
    [...rack.children].forEach((t, i) => {
      t.classList.toggle('spent', spent.has(i));
      t.classList.toggle('sel', sel.includes(i));
      t.disabled = spent.has(i);
    });
  }

  function tileEl(i) { return $('rack').children[i]; }

  /* ---------------- Word card & preview ---------------- */
  function previewGhost() {
    const word = selWord();
    if (!arm || word.length < E.MIN_WORD || game.won) return null;
    const ghostNet = net() + (arm === 'R' ? 1 : -1) * E.torqueOf(word);
    return { word, side: arm, net: ghostNet, bad: !E.isWord(word) };
  }

  function renderWord() {
    const word = selWord();
    const line = $('wordLine');
    if (!word) { showIdle(); }
    else {
      const ok = word.length >= E.MIN_WORD && E.isWord(word);
      line.className = `word-line${ok ? ' ok' : ''}`;
      line.innerHTML = `<span class="w">${word}</span>`;
    }
    // preview: mass, notch, torque, projected balance
    const pv = $('preview');
    const has = word.length > 0;
    pv.classList.toggle('idle', !has);
    $('pvMass').textContent = has ? word.length : '–';
    $('pvNotch').textContent = has ? E.notchOf(word) : '–';
    $('pvTorque').textContent = has ? E.torqueOf(word) : '–';
    const proj = has && arm ? net() + (arm === 'R' ? 1 : -1) * E.torqueOf(word) : null;
    $('pvNet').textContent = proj === null ? (has ? 'Pick arm' : '–') : fmtNet(proj);
    $('pvNet').parentElement.classList.toggle('good', proj !== null && E.isBalanced(proj));
    $('pvNet').style.fontSize = proj === null && has ? '.8rem' : '';
    // arm buttons show where each side would leave the beam
    for (const side of ['L', 'R']) {
      const small = $(`arm${side}Net`);
      if (word.length >= E.MIN_WORD && !game.won) {
        const n = net() + (side === 'R' ? 1 : -1) * E.torqueOf(word);
        small.innerHTML = `→ <span class="${E.isBalanced(n) ? 'good' : ''}">${fmtNet(n)}</span>`;
      } else small.textContent = '';
    }
  }

  function showIdle() {
    const line = $('wordLine');
    line.className = 'word-line';
    if (game.won) line.innerHTML = `<span class="ph">${tutorialMode ? 'Practice beam balanced.' : 'Balanced. See you tomorrow.'}</span>`;
    else if (hintText) line.innerHTML = `<span class="msg gd">${hintText}</span>`;
    else line.innerHTML = '<span class="ph">Tap tiles or type a 3–5 letter word</span>';
  }
  function showMessage(text, kind = '') {
    const line = $('wordLine');
    line.className = 'word-line';
    line.innerHTML = `<span class="msg ${kind}">${text}</span>`;
  }

  function renderHud() {
    const n = net();
    $('moves').textContent = `${game.placed.length}/${puzzle.maxMoves}`;
    $('par').textContent = puzzle.par;
    $('net').textContent = fmtNet(n);
    $('net').parentElement.classList.toggle('ok', E.isBalanced(n));
    $('moves').parentElement.classList.toggle('over', game.placed.length > puzzle.par);
    const word = selWord();
    const done = game.won;
    $('undoBtn').disabled = busy || tutorialMode || done || !game.history.length;
    $('resetBtn').disabled = busy || tutorialMode || done || (!game.placed.length && !game.history.length);
    $('hintBtn').disabled = busy || tutorialMode || done;
    $('hintBtn').querySelector('span').textContent = done ? 'Hint' : hintLabel();
    $('hintBtn').title = game.hints ? `Hints used: ${game.hints} (each adds 1 to your leaderboard score)` : 'Each hint adds 1 to your leaderboard score';
    $('armL').disabled = $('armR').disabled = busy || done;
    $('armL').classList.toggle('on', arm === 'L');
    $('armR').classList.toggle('on', arm === 'R');
    $('armL').setAttribute('aria-pressed', arm === 'L');
    $('armR').setAttribute('aria-pressed', arm === 'R');
    $('placeBtn').disabled = busy || done || word.length < E.MIN_WORD || !arm || movesLeft() <= 0;
    $('placeBtn').textContent = !word ? 'Place word' : word.length < E.MIN_WORD ? 'Words need 3 to 5 letters' : !arm ? 'Pick an arm' : `Place ${word} ${arm === 'L' ? 'left' : 'right'}`;
    renderClock();
  }

  const DIFF_LABELS = ['', 'Easy', 'Medium', 'Hard'];
  const starsHTML = (n) => `<span class="stars">${'★'.repeat(n)}${'☆'.repeat(3 - n)}</span>`;
  function renderHeader() {
    if (tutorialMode) {
      $('dateLabel').textContent = 'Walkthrough · practice beam';
      $('difficulty').textContent = 'Practice';
      return;
    }
    const today = dayNumber();
    $('dateLabel').textContent = `#${activeDay + 1} · ${fmtDate(activeDay, { weekday: 'short', month: 'short', day: 'numeric' })}${activeDay !== today ? ' · Archive' : ''}`;
    $('difficulty').innerHTML = `${starsHTML(puzzle.stars)} ${DIFF_LABELS[puzzle.stars]}`;
  }

  function renderAll(opts = {}) {
    renderRack(opts);
    renderWord();
    renderBeam(opts);
    renderHud();
  }

  /* ---------------- Toast ---------------- */
  let toastTimer;
  function toast(msg, bad) {
    const t = $('toast');
    t.textContent = msg;
    t.className = `toast show${bad ? ' bad' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = 'toast'; }, 1800);
  }

  /* ---------------- Input ---------------- */
  function toggleTile(i) {
    if (busy || game.won || spentSet().has(i)) return;
    const k = sel.indexOf(i);
    if (k >= 0) sel.splice(k, 1);
    else if (sel.length >= E.MAX_WORD) { tooLong(); return; }
    else sel.push(i);
    renderAll();
  }
  function tooLong() {
    showMessage(`Words are ${E.MIN_WORD} to ${E.MAX_WORD} letters`, 'bad');
    if (navigator.vibrate) navigator.vibrate(30);
  }
  function typeLetter(ch) {
    const spent = spentSet();
    const i = [...puzzle.rack].findIndex((c, j) => c === ch && !spent.has(j) && !sel.includes(j));
    if (i < 0) { showMessage(`No ${ch} left in the rack`, 'bad'); return; }
    if (sel.length >= E.MAX_WORD) { tooLong(); return; }
    sel.push(i);
    renderAll();
  }
  function setArm(side) {
    if (busy || game.won) return;
    arm = side;
    $('armL').classList.remove('hint-lane');
    $('armR').classList.remove('hint-lane');
    renderAll();
  }
  function clearWord() { sel = []; renderAll(); }

  $('rack').addEventListener('click', (e) => {
    const t = e.target.closest('.tile');
    if (t) toggleTile(Number(t.dataset.i));
  });
  $('armL').addEventListener('click', () => setArm('L'));
  $('armR').addEventListener('click', () => setArm('R'));
  $('placeBtn').addEventListener('click', () => placeWord());

  document.addEventListener('keydown', (e) => {
    const open = document.querySelector('.modal.show');
    if (open) {
      if (open.id === 'readyModal') { if (e.key === 'Enter') $('readyStart').click(); }
      else if (e.key === 'Escape') closeModal(open);
      return;
    }
    if (busy || !game || e.altKey) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undoMove(); return; }
    if (e.metaKey || e.ctrlKey) return;
    if (game.won) return;
    if (/^[a-z]$/i.test(e.key)) { typeLetter(e.key.toUpperCase()); return; }
    if (e.key === 'Backspace' && sel.length) { e.preventDefault(); sel.pop(); renderAll(); }
    else if (e.key === 'Escape' && sel.length) clearWord();
    else if (e.key === 'ArrowLeft') { e.preventDefault(); setArm('L'); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); setArm('R'); }
    else if (e.key === 'Enter') { e.preventDefault(); placeWord(); }
  });

  /* ---------------- Placing a word (spec §8) ---------------- */
  function reject(text) {
    showMessage(text, 'bad');
    const tiles = sel.map(tileEl);
    tiles.forEach((t) => { t.classList.remove('sel'); t.classList.add('bad'); });
    if (navigator.vibrate) navigator.vibrate(40);
    setTimeout(() => { tiles.forEach((t) => t.classList.remove('bad')); renderRack(); }, 420);
  }

  async function placeWord() {
    if (busy || game.won) return;
    const word = selWord();
    if (!word) return;
    if (word.length < E.MIN_WORD) { reject('Words need at least 3 letters'); return; }
    if (!arm) { showMessage('Pick an arm: Left or Right', 'gd'); return; }
    if (tutorialMode && !tutAccepts(word, arm)) { reject(tutRejectText()); return; }
    const why = E.checkWord(word, rackLeft(), game.placed, movesLeft());
    if (why) { reject(why); return; } // an invalid word costs nothing (spec §7)

    busy = true;
    clearHint();
    if (tutorialMode) hideCoach();
    if (!game.placed.length) markPlayed();
    game.history = game.history.concat([game.placed]);
    game.placed = game.placed.concat([{ word, side: arm, tiles: sel.slice() }]);
    justPlaced = game.placed.length - 1;
    sel = [];
    const n = net();
    renderAll();
    showMessage(`${word} · ${word.length} × ${E.notchOf(word)} = ${E.torqueOf(word)} ${arm === 'L' ? 'left' : 'right'}`, 'ok');
    if (navigator.vibrate) navigator.vibrate(15);
    await wait(pace(750)); // let the beam swing and settle

    if (E.isBalanced(n)) {
      pauseClock();
      game.won = true;
      if (!tutorialMode) {
        recordWin(game.placed.length - puzzle.par);
        lbRecordFirstWin();
      }
    }
    busy = false;
    saveState();
    renderHud();
    if (game.won) await celebrate();
    else if (tutorialMode) { showIdle(); tutGo(tutStep + 1); }
    else { showIdle(); checkStuck(); }
  }

  async function celebrate() {
    renderAll();
    showIdle();
    const n = net();
    toast(n === 0 ? 'Perfect balance' : `Balanced at ${fmtNet(n)}`);
    if (navigator.vibrate) navigator.vibrate([20, 40, 20]);
    await wait(pace(1100));
    if (tutorialMode) tutFinish();
    else showWin();
  }

  // Spec §12: a miss is out of moves, or no 3-letter word left in the rack. Undo still works.
  function checkStuck() {
    const box = $('stuck');
    if (game.won || tutorialMode) { box.hidden = true; return; }
    if (movesLeft() <= 0) box.textContent = 'Out of moves and still tipped. Undo a word or reset to try again.';
    else if (!E.hasAnyWord(rackLeft(), usedWords())) box.textContent = 'No words left in the rack. Undo a word or reset.';
    else { box.hidden = true; return; }
    box.hidden = false;
  }

  /* ---------------- Undo / reset (spec §9) ---------------- */
  function restore(placed) {
    game.placed = placed;
    sel = [];
    clearHint();
    renderAll();
    checkStuck();
    saveState();
  }
  function undoMove() {
    if (busy || tutorialMode || !game || game.won || !game.history.length) return;
    const prev = game.history[game.history.length - 1];
    game.history = game.history.slice(0, -1);
    restore(prev);
    showMessage('Move undone. Tiles are back in the rack.');
  }
  function resetBoard() {
    if (busy || tutorialMode) return;
    if (game.won) { // "Try for fewer words" after a finish: a clean replay
      closeModal($('winModal'));
      game = freshGame();
      sel = [];
      renderAll({ enter: true, instant: true });
      restore([]);
      startClock();
      return;
    }
    if (!game.placed.length && !game.history.length) return;
    game.history = game.history.concat([game.placed]);
    restore([]);
    toast('Beam reset. Undo brings it back.');
  }

  /* ---------------- Hint ----------------
     Fulcrum's hard part is knowing whether earlier words have already cost you
     par, so hints start with your position, not an answer.
     With a word built, Hint checks that move before you commit (each distinct
     move checked costs 1). With nothing built, Hint climbs a ladder, 1 per step:
       1. Check  — on track for par? If not, how many words to undo
       2. Nudge  — arm, notch and length, with the heavy letter glowing
       3. Reveal — the word, filled in with its arm, ready to place
     The ladder resets after every placed or undone word. */
  let lastCheck = '';
  function clearHint() {
    hintData = null;
    hintLevel = 0;
    hintText = '';
    lastCheck = '';
    document.querySelectorAll('.hint-lane').forEach((el) => el.classList.remove('hint-lane'));
  }
  function showHintText(text) {
    hintText = text;
    if (!sel.length) showIdle();
    else showMessage(text, 'gd');
  }
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const sideName = (s) => (s === 'L' ? 'left' : 'right');
  const builtWord = () => { const w = selWord(); return w.length >= E.MIN_WORD ? w : ''; };
  const checkKey = (w) => `${game.placed.length}:${w}:${arm || '*'}`;
  /** What the next tap gives, for the button label. */
  function hintLabel() {
    const w = builtWord();
    if (w && checkKey(w) !== lastCheck) return 'Check';
    if (w && hintLevel === 0) return 'Checked';
    if (hintData && hintData.status && hintData.status.status === 'dead') return 'Hint';
    return ['Hint', 'Nudge', 'Reveal', 'Hint'][hintLevel];
  }
  function charge() {
    game.hints++;
    saveState();
    renderHud();
  }
  function glowTiles(word) {
    const spent = spentSet();
    const taken = new Set();
    const out = [];
    for (const ch of word) {
      const i = [...puzzle.rack].findIndex((c, j) => c === ch && !spent.has(j) && !taken.has(j));
      taken.add(i);
      out.push(i);
    }
    return out;
  }

  function showMoveHint() {
    if (busy || tutorialMode || game.won) return;
    const w = builtWord();
    if (w && checkKey(w) !== lastCheck) { checkMove(w); return; }
    if (w && hintLevel === 0) return; // this move is already checked; clear the word to use the ladder
    if (hintLevel >= 3) return; // the word is already showing; another tap mustn't cost a point
    if (hintData && hintData.status.status === 'dead') return; // nothing more to show until an undo
    showHintText('Weighing it up…');
    setTimeout(stepHint, 30);
  }

  // A built word: judge it on the chosen arm, or on both if none is chosen.
  function checkMove(word) {
    const key = checkKey(word);
    const sides = arm ? [arm] : ['L', 'R'];
    const verdicts = sides.map((s) => [s, E.judgeMove(puzzle, game.placed, word, s)]);
    const illegal = verdicts[0][1].illegal;
    if (illegal) { showMessage(illegal, 'bad'); return; } // free: the word itself isn't playable
    lastCheck = key;
    charge();
    const say = ([s, v]) => {
      const where = arm ? `${word} on the ${sideName(s)}` : `${sideName(s)[0].toUpperCase()}${sideName(s).slice(1)}`;
      if (v.wins) return `${where}: <b>balances it</b>${v.status === 'par' ? ' at par' : ''}!`;
      if (v.status === 'par') return `${where}: ✓ par still in reach (${plural(v.remaining, 'word')} after)`;
      if (v.status === 'cap') return `${where}: balanceable, but par is gone`;
      return `${where}: ✗ dead end`;
    };
    showMessage(verdicts.map(say).join(' · '), 'gd');
    hintText = '';
  }

  function stepHint() {
    if (!hintData) hintData = { status: E.assess(puzzle, game.placed), move: null };
    const st = hintData.status;
    hintLevel++;
    charge();
    // 1. Check: where you stand
    if (hintLevel === 1) {
      if (st.status === 'par') {
        showHintText(`On track: par is still in reach, ${plural(st.remaining, 'word')} to go.`);
      } else if (st.status === 'cap') {
        showHintText(`Par is out of reach, but you can still balance in ${plural(st.remaining, 'word')}. ` +
          `Undo ${plural(st.undoToPar, 'word')} to get back on par.`);
        $('undoBtn').classList.add('hint-lane');
      } else {
        showHintText(`No way to balance from here. Undo ${plural(st.undoToLive, 'word')}` +
          (st.undoToPar > st.undoToLive ? `, or ${st.undoToPar} to get back on par.` : ' to get back on par.'));
        $('undoBtn').classList.add('hint-lane');
      }
      return;
    }
    // 2–3 follow the shortest finish from here (par if it's still possible).
    if (!hintData.move) hintData.move = E.hint(puzzle, game.placed);
    const h = hintData.move;
    if (!h) { showHintText('No way to balance from here. Try Undo.'); return; }
    $(`arm${h.side}`).classList.add('hint-lane');
    if (hintLevel === 2) {
      const heavy = E.heavyLetter(h.word);
      const tiles = glowTiles(h.word);
      const hi = tiles[[...h.word].indexOf(heavy)];
      if (tileEl(hi)) tileEl(hi).classList.add('hint-lane');
      showHintText(`Try a ${h.word.length}-letter word on the ${sideName(h.side)} arm, built around the glowing ${heavy} (notch ${E.notchOf(h.word)}).`);
      return;
    }
    // 3. Reveal: fill it in, ready to place.
    document.querySelectorAll('#rack .hint-lane').forEach((el) => el.classList.remove('hint-lane'));
    sel = glowTiles(h.word);
    arm = h.side;
    lastCheck = checkKey(h.word); // it's the hint's own move: no need to check it
    renderAll();
    showMessage(`${h.word} on the ${sideName(h.side)}. Press Place.`, 'gd');
    hintText = '';
  }

  /* ---------------- Win modal (spec §11, §15) ---------------- */
  function shareText() {
    const n = net();
    const [g] = gradeFor(game.placed.length - puzzle.par);
    const hints = game.hints > 0 ? ` · 💡${game.hints}` : '';
    const squares = game.placed.map((m) => (m.side === 'L' ? '🟦' : '🟧')).join('');
    const label = g.charAt(0) + g.slice(1).toLowerCase();
    return `FULCRUM #${String(activeDay + 1).padStart(3, '0')}\n⚖️ ${label}\nWords: ${game.placed.length} / Par: ${puzzle.par}${hints}\nBalance: ${n > 0 ? `+${n}` : n}\n${squares}`;
  }

  let countdownTimer;
  function nextBoardIn() {
    const now = new Date();
    const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const s = Math.max(0, Math.floor((nextMidnight - now) / 1000));
    return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  }

  function showWin() {
    const diff = game.placed.length - puzzle.par;
    const n = net();
    const [g, colr] = gradeFor(diff);
    const gr = $('grade');
    gr.textContent = g;
    gr.style.background = `color-mix(in srgb, ${colr} 12%, transparent)`;
    gr.style.color = colr;
    gr.style.border = `1px solid ${colr}`;
    $('winTitle').textContent = n === 0 ? 'Perfect balance' : 'Balanced';
    $('winMoves').textContent = `${game.placed.length} word${game.placed.length > 1 ? 's' : ''}`;
    const L = game.placed.filter((m) => m.side === 'L').length;
    const R = game.placed.length - L;
    $('breakdown').innerHTML =
      `Par ${puzzle.par} · final balance <b>${fmtNet(n)}</b> · ${L} left, ${R} right<br>` +
      (diff < 0 ? 'Under par! That beats the solver. Please tell us how.' :
        diff === 0 ? 'Right on par: the shortest line there is.' :
          'One over par. Still a balanced beam.');
    $('trail').innerHTML = game.placed.map((m) =>
      `<span class="${m.side === 'L' ? 'l' : 'r'}">${m.side === 'L' ? '◀ ' : ''}${m.word}${m.side === 'R' ? ' ▶' : ''}</span>`).join('');
    renderStats('st', loadStats(), activeDay === dayNumber() ? gradeKey(diff) : null);
    $('share').textContent = shareText();
    $('retryBtn').hidden = diff <= 0;
    lbAfterWin();
    $('countdown').textContent = nextBoardIn();
    clearInterval(countdownTimer);
    countdownTimer = setInterval(() => { $('countdown').textContent = nextBoardIn(); }, 1000);
    openModal($('winModal'));
  }

  async function shareResult() {
    const text = $('share').textContent;
    if (navigator.share && navigator.canShare && navigator.canShare({ text })) {
      try { await navigator.share({ text }); return; } catch (err) { if (err && err.name === 'AbortError') return; }
    }
    if (navigator.clipboard && window.isSecureContext) {
      try { await navigator.clipboard.writeText(text); toast('Result copied!'); return; } catch (e) { /* fall through */ }
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      toast('Result copied!');
    } catch (e) { toast('Copy failed', true); }
  }

  /* ---------------- Daily leaderboard (as in Typeset and Cascade) ----------------
     One public board per day, stored in the workshop's Firebase under
     fulcrum/daily/{day}/{playerId}. Only the first win on today's puzzle posts
     (replays and archive solves never do). Score = words + hint taps, lower is
     better; ties go to the faster solve. */
  const FIREBASE_CONFIG = {
    apiKey: 'AIzaSyD5C8uPGGb_jMuA0ceP5VlWChMV-Ggfles',
    authDomain: 'tumbler-51e42.firebaseapp.com',
    databaseURL: 'https://tumbler-51e42-default-rtdb.asia-southeast1.firebasedatabase.app/',
    projectId: 'tumbler-51e42',
    appId: '1:907072959576:web:641facf27c204c7bb8862d',
  };
  const LB_ROOT = 'fulcrum';
  const LB_PID_KEY = 'fulcrum_pid';
  const LB_NAME_KEY = 'fulcrum_name';
  const LB_POSTED_KEY = 'fulcrum_lb_posted';
  const LB_ASKED_KEY = 'fulcrum_lb_asked';
  const LB_ENTRY_KEY = 'fulcrum_lb_entry'; // { day, entry }: today's first win, which is what posts
  const LB_SHOW = 50;
  const LB_TIMEOUT = 8000;
  const lbGet = (k) => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } };
  const lbSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } };
  const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  let lbName = cleanName(lbGet(LB_NAME_KEY));
  let lbPidCache = '';
  function lbPid() {
    if (lbPidCache) return lbPidCache;
    let id = lbGet(LB_PID_KEY);
    if (!/^[a-z0-9]{12,}$/.test(id)) {
      id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => (b % 36).toString(36)).join('');
      lbSet(LB_PID_KEY, id);
    }
    return (lbPidCache = id);
  }
  function lbSetName(n) { lbName = n; lbSet(LB_NAME_KEY, n); }
  function loadScript(src) {
    return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
  }
  // Firebase reads never reject while offline — they just wait — so every call gets a deadline.
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
  let lbDbPromise = null;
  function lbDb() {
    if (!lbDbPromise) {
      const base = 'https://www.gstatic.com/firebasejs/10.7.1/';
      lbDbPromise = loadScript(`${base}firebase-app-compat.js`)
        .then(() => loadScript(`${base}firebase-database-compat.js`))
        .then(() => (firebase.apps.length ? firebase.app() : firebase.initializeApp(FIREBASE_CONFIG)).database())
        .catch((e) => { lbDbPromise = null; throw e; });
    }
    return withTimeout(lbDbPromise, LB_TIMEOUT);
  }
  async function markVisit() {
    try {
      const db = await lbDb();
      const profile = { lastUpdated: firebase.database.ServerValue.TIMESTAMP };
      if (lbName) profile.name = lbName;
      await withTimeout(db.ref(`${LB_ROOT}/userProfile/${lbPid()}`).update(profile), LB_TIMEOUT);
    } catch (e) { /* Visit tracking is best effort and must not block the game. */ }
  }
  async function lbPost(day, entry) {
    const db = await lbDb();
    const ref = db.ref(`${LB_ROOT}/daily/${day}/${lbPid()}`);
    const row = { ...entry, at: firebase.database.ServerValue.TIMESTAMP };
    await withTimeout(ref.transaction((cur) => (cur === null ? row : undefined)), LB_TIMEOUT); // first result stands
    lbSet(LB_POSTED_KEY, String(day));
    void markVisit(); // a posted score always comes with a profile
  }
  async function lbFetch(day) {
    const db = await lbDb();
    const snap = await withTimeout(db.ref(`${LB_ROOT}/daily/${day}`).once('value'), LB_TIMEOUT);
    const rows = [];
    snap.forEach((c) => {
      const v = c.val() || {};
      if (typeof v.s === 'number') rows.push({ pid: c.key, n: cleanName(v.n) || 'Anonymous', s: v.s | 0, h: v.h | 0, t: v.t | 0, at: +v.at || 0 });
    });
    rows.sort((a, b) => a.s - b.s || a.t - b.t || a.at - b.at);
    return rows;
  }
  const hintTag = (h) => (h > 0 ? `💡${h}` : '');
  function lbRow(r, rank, me) {
    const el = document.createElement('div');
    el.className = `lb-row${r.pid === me ? ' you' : ''}`;
    el.innerHTML = `<span class="lr">${rank}</span><span class="ln"></span><span class="lm">${hintTag(r.h)}</span>` +
      `<span class="ls">${r.s}</span><span class="lt">${fmtTime(r.t)}</span>`;
    el.querySelector('.ln').textContent = r.n;
    if (r.pid === me) el.querySelector('.ln').insertAdjacentHTML('beforeend', '<small>You</small>');
    return el;
  }
  function renderLbYou(day) {
    const you = $('lbYou');
    const isToday = day === dayNumber();
    if (!lbName) { you.textContent = isToday ? "Balance today's beam to put your name on the leaderboard." : ''; return; }
    you.innerHTML = 'Playing as <b></b> · <button class="lnk" type="button" id="lbRename">Change name</button>' +
      (!isToday || lbGet(LB_POSTED_KEY) === String(day) ? '' : "<br>Balance today's beam to post your score.");
    you.querySelector('b').textContent = lbName;
    $('lbRename').onclick = () => openNameCard('rename', dayNumber(), null); // a rename only touches today's entry
  }
  // ago: 0 = today's board, 1 = yesterday's (read-only — only today's live result ever posts).
  let lbReq = 0;
  let lbAgo = 0;
  async function openLeaderboard(ago = 0) {
    const today = Math.max(0, dayNumber());
    if (today < 1) ago = 0;
    lbAgo = ago;
    const day = today - ago;
    const list = $('lbList');
    const req = ++lbReq;
    document.querySelector('.lb-tabs').hidden = today < 1; // launch day: nothing to look back on
    document.querySelectorAll('.lb-tab').forEach((t) => {
      const on = Number(t.dataset.ago) === ago;
      t.classList.toggle('on', on);
      t.setAttribute('aria-selected', on);
    });
    const p = day === activeDay && !tutorialMode ? puzzle : puzzleForDay(day);
    $('lbSub').innerHTML = `Beam #${day + 1} · ${fmtDate(day, { month: 'short', day: 'numeric' })} · <span class="stars">${'★'.repeat(p.stars)}</span> · Par ${p.par}<br>Ranked by score (words + hints), then time`;
    list.innerHTML = '<div class="lb-empty">Loading…</div>';
    renderLbYou(day);
    openModal($('lbModal'));
    try {
      const rows = await lbFetch(day);
      const me = lbPid();
      if (req !== lbReq) return; // the player switched tabs while this was loading
      list.innerHTML = '';
      if (!rows.length) { list.innerHTML = `<div class="lb-empty">${ago ? "No one balanced yesterday's beam." : "No one's on the board yet. Balance today's beam to be first."}</div>`; return; }
      rows.slice(0, LB_SHOW).forEach((r, i) => list.appendChild(lbRow(r, i + 1, me)));
      const mine = rows.findIndex((r) => r.pid === me);
      if (mine >= LB_SHOW) { const el = lbRow(rows[mine], mine + 1, me); el.classList.add('gap'); list.appendChild(el); }
    } catch (e) {
      if (req !== lbReq) return;
      list.innerHTML = '<div class="lb-empty">Couldn\'t reach the leaderboard. Check your connection and try again.</div>';
    }
  }
  // The first win on today's board is the one that counts, even if the player replays for fewer words.
  function lbRecordFirstWin() {
    const day = dayNumber();
    if (activeDay !== day || lbEntryFor(day)) return;
    writeJSON(LB_ENTRY_KEY, { day, entry: { s: game.placed.length + game.hints, mv: game.placed.length, h: game.hints, t: Math.round(game.time / 1000), b: net() } });
  }
  function lbEntryFor(day) {
    const e = readJSON(LB_ENTRY_KEY, null);
    return e && e.day === day && e.entry ? e.entry : null;
  }
  // Win card: today's first win posts itself once a name is known; archive replays never post.
  // With no name yet, the name card opens over the result once per day.
  function lbAfterWin() {
    const day = dayNumber();
    const box = $('lbJoin');
    const entry = activeDay === day ? lbEntryFor(day) : null;
    box.hidden = !entry;
    if (!entry) return;
    if (lbGet(LB_POSTED_KEY) === String(day)) { lbShowRank(day); return; }
    if (lbName) { lbSubmit(day, entry); return; }
    lbShowJoinLink(day, entry);
    if (lbGet(LB_ASKED_KEY) === String(day)) return;
    lbSet(LB_ASKED_KEY, String(day));
    // let the result land first, then ask
    setTimeout(() => {
      if (activeDay === day && $('winModal').classList.contains('show')) openNameCard('join', day, entry);
    }, 700);
  }
  function lbShowJoinLink(day, entry) {
    $('lbJoinMsg').innerHTML = 'You\'re not on today\'s leaderboard yet. <button class="lnk" type="button" id="lbAdd">Add your name</button>';
    $('lbAdd').onclick = () => openNameCard('join', day, entry);
  }
  async function lbSubmit(day, entry) {
    const msg = $('lbJoinMsg');
    msg.textContent = "Posting to today's leaderboard…";
    try { await lbPost(day, { n: lbName, ...entry }); await lbShowRank(day); } catch (e) {
      msg.innerHTML = 'Couldn\'t reach the leaderboard. <button class="lnk" type="button" id="lbRetry">Try again</button>';
      $('lbRetry').onclick = () => lbSubmit(day, entry);
    }
  }
  async function lbShowRank(day) {
    const msg = $('lbJoinMsg');
    msg.textContent = "Checking today's leaderboard…";
    try {
      const rows = await lbFetch(day);
      const i = rows.findIndex((r) => r.pid === lbPid());
      msg.innerHTML = i < 0 ? "You're on today's leaderboard." : `You're <b>#${i + 1}</b> of ${rows.length} on today's leaderboard.`;
    } catch (e) { msg.textContent = "You're on today's leaderboard."; }
  }

  /* Name card: one dedicated step for joining the board (mode "join", with the
     result about to be posted shown as a preview row) and for renaming later. */
  let nameCtx = null;
  function renderNamePreview() {
    const n = cleanName($('nameInput').value);
    const ln = $('namePreview').querySelector('.ln');
    ln.textContent = n || 'Your name';
    ln.classList.toggle('ph', !n);
  }
  function openNameCard(mode, day, entry) {
    const join = mode === 'join';
    $('nameTitle').textContent = join ? 'Sign your beam' : 'Change your name';
    $('nameText').textContent = join
      ? "Pick a name to post today's result. Everyone who balances today's beam is ranked by score (words + hints), then time."
      : 'This is the name other players see next to your result.';
    $('nameSave').textContent = join ? 'Post to leaderboard' : 'Save name';
    $('nameSkip').textContent = join ? 'Not now' : 'Cancel';
    const pv = $('namePreview');
    pv.hidden = !entry;
    if (entry) {
      pv.querySelector('.lm').textContent = hintTag(entry.h);
      pv.querySelector('.ls').textContent = entry.s;
      pv.querySelector('.lt').textContent = fmtTime(entry.t);
    }
    $('nameInput').value = lbName;
    $('nameInput').classList.remove('shake');
    renderNamePreview();
    openModal($('nameModal'));
    nameCtx = { mode, day, entry };
    setTimeout(() => $('nameInput').focus(), 60);
  }
  $('nameInput').addEventListener('input', () => { $('nameInput').classList.remove('shake'); renderNamePreview(); });
  $('nameForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('nameInput');
    const n = cleanName(input.value);
    if (!n) { input.classList.remove('shake'); void input.offsetWidth; input.classList.add('shake'); input.focus(); return; }
    const ctx = nameCtx;
    if (!ctx) return;
    lbSetName(n);
    closeModal($('nameModal'));
    if (ctx.mode === 'join') {
      if (ctx.day === dayNumber()) lbSubmit(ctx.day, ctx.entry);
      return;
    }
    if (lbGet(LB_POSTED_KEY) === String(ctx.day)) {
      try { const db = await lbDb(); await withTimeout(db.ref(`${LB_ROOT}/daily/${ctx.day}/${lbPid()}/n`).set(n), LB_TIMEOUT); } catch (err) { toast("Couldn't update your name", true); }
    }
    openLeaderboard(lbAgo);
  });
  $('lbBtn').addEventListener('click', () => openLeaderboard());
  $('lbJoinOpen').addEventListener('click', () => openLeaderboard());
  document.querySelectorAll('.lb-tab').forEach((t) => t.addEventListener('click', () => openLeaderboard(Number(t.dataset.ago))));

  /* ---------------- Modals ---------------- */
  function openModal(m) { m.classList.add('show'); }
  function closeModal(m) {
    m.classList.remove('show');
    if (m.id === 'winModal') clearInterval(countdownTimer);
    if (m.id === 'rulesModal') { stopDemos(); try { localStorage.setItem(SEEN_KEY, '1'); } catch (e) { /* ignore */ } startClock(); }
    if (m.id === 'nameModal') nameCtx = null;
  }
  document.querySelectorAll('.modal').forEach((m) => {
    m.addEventListener('click', (e) => {
      if (m.id === 'readyModal') return;
      if (e.target === m || e.target.closest('.x-close') || e.target.closest('[data-close]')) closeModal(m);
    });
  });
  // A card that scrolls grows a scrollbar under the pinned x; --sbw shifts the x
  // left of it so it never covers (or swallows clicks meant for) the bar.
  const sbObs = new ResizeObserver((es) => es.forEach(({ target: w }) =>
    w.parentElement.style.setProperty('--sbw', `${w.offsetWidth - w.clientWidth}px`)));
  document.querySelectorAll('.win-wrap > .win').forEach((w) => sbObs.observe(w));

  // How to play: Typeset-style deck
  const slides = [...document.querySelectorAll('#rulesModal .slide')];
  let slideAt = 0;
  function showSlide(n) {
    slideAt = n;
    slides.forEach((s, k) => s.classList.toggle('on', k === n));
    $('deckDots').innerHTML = slides.map((_, k) => `<button type="button" class="${k === n ? 'on' : ''}" aria-label="Slide ${k + 1}"></button>`).join('');
    $('deckDots').querySelectorAll('button').forEach((b, k) => b.addEventListener('click', () => showSlide(k)));
    $('deckNext').textContent = n === slides.length - 1 ? 'Got it — let’s play' : 'Next';
    const demo = slides[n].querySelector('.demo');
    if (demo && $('rulesModal').classList.contains('show')) playDemo(demo);
    else stopDemos();
  }
  $('deckNext').addEventListener('click', () => {
    if (slideAt < slides.length - 1) showSlide(slideAt + 1);
    else closeModal($('rulesModal'));
  });
  $('helpBtn').addEventListener('click', () => { openModal($('rulesModal')); showSlide(0); });
  $('tutBtn').addEventListener('click', startTutorial);

  $('statsBtn').addEventListener('click', () => { renderStats('sm', loadStats(), null); openModal($('statsModal')); });
  $('gamesBtn').addEventListener('click', () => openModal($('gamesModal')));

  /* ---------------- How-to-play clips ----------------
     Each slide plays a short game on a loop, like a GIF: tiles get tapped, the
     preview lands on the beam, the word drops and the beam swings and settles.
     Everything is drawn with the real beam, blocks and tiles, and the numbers
     come from the engine, so the clips can't drift from the rules. Only the
     slide on screen plays; changing slide or closing the deck stops it. */
  const DEMO_STOP = {};
  let demoRun = 0;
  const stopDemos = () => { demoRun++; };

  function demoGame(host, run, { rack, anchors }) {
    host.innerHTML =
      '<div class="scene"><div class="beam ghost"><div class="bar"></div></div>' +
      '<div class="beam main"><div class="stacks"></div><div class="bar"></div><div class="ticks"></div></div>' +
      '<svg class="fulcrum" viewBox="0 0 60 52"><path d="M30 2 L56 50 H4 Z"/></svg></div>' +
      '<div class="demo-word"></div>' +
      `<div class="rack" style="--cols:${rack.length}">${[...rack].map((ch) =>
        `<div class="tile" data-tier="${E.tierOf(ch)}">${ch}<span class="tr">${E.tierOf(ch)}</span></div>`).join('')}</div>` +
      '<div class="demo-arms"><span data-side="L">◀ Left</span><span data-side="R">Right ▶</span></div>';
    const q = (s) => host.querySelector(s);
    const tiles = [...host.querySelectorAll('.tile')];
    const spring = makeSpring((a) => q('.beam.main').style.setProperty('--angle', `${a}deg`));
    const base = { start: E.anchorNet(anchors) };
    let placed = [];
    let history = [];
    let picked = [];
    const netNow = () => E.netOf(base, placed);
    const word = () => picked.map((i) => rack[i]).join('');
    const isSpent = (i) => placed.some((m) => m.tiles.includes(i));
    function draw({ ghost = null, drop = -1, instant = false } = {}) {
      const slots = slotsFor(anchors, placed, ghost);
      q('.stacks').innerHTML = slots.map((list) => `<div class="slot">${list.map((b) =>
        blockHTML(b, (b.ghost ? ' ghost' : '') + (b.k === drop ? ' drop' : ''))).join('')}</div>`).join('');
      const landing = ghost ? slotOf(ghost.side, E.notchOf(ghost.word)) : -1;
      q('.ticks').innerHTML = Array.from({ length: 11 }, (_, i) =>
        `<span class="${i === landing ? 'on' : ''}">${i === 5 ? '' : Math.abs(i - 5)}</span>`).join('');
      const n = netNow();
      spring.to(angleFor(n), instant);
      const gb = q('.beam.ghost');
      gb.classList.toggle('on', !!ghost);
      if (ghost) gb.style.setProperty('--angle', `${angleFor(ghost.net)}deg`);
      q('.fulcrum').classList.toggle('lit', E.isBalanced(n));
      q('.scene').classList.toggle('won', E.isBalanced(n));
      tiles.forEach((t, i) => {
        t.classList.toggle('sel', picked.includes(i));
        t.classList.toggle('spent', isSpent(i));
      });
    }
    const armsOff = () => host.querySelectorAll('.demo-arms span').forEach((s) => s.classList.remove('on'));
    const d = {
      async step(ms) {
        await wait(pace(ms));
        if (run !== demoRun) throw DEMO_STOP;
      },
      say(html) { q('.demo-word').innerHTML = `<span>${html}</span>`; },
      /** Tap the word's tiles one by one; the card shows the notch so far. */
      async spell(w, ms = 360) {
        for (const ch of w) {
          picked.push([...rack].findIndex((c, j) => c === ch && !picked.includes(j) && !isSpent(j)));
          draw();
          d.say(`<span class="w">${word()}</span> · notch ${E.notchOf(word())}`);
          await d.step(ms);
        }
      },
      /** Pick an arm: the ghost block and ghost beam show where it would land. */
      arm(side) {
        host.querySelectorAll('.demo-arms span').forEach((s) => s.classList.toggle('on', s.dataset.side === side));
        const n = netNow() + (side === 'R' ? 1 : -1) * E.torqueOf(word());
        draw({ ghost: { word: word(), side, net: n } });
        return n;
      },
      place(side) {
        history.push(placed);
        placed = placed.concat([{ word: word(), side, tiles: picked }]);
        picked = [];
        armsOff();
        draw({ drop: placed.length - 1 });
        return netNow();
      },
      clear() { picked = []; armsOff(); draw(); },
      undo() { placed = history.pop(); draw(); return netNow(); },
      mark(letters, on = true) {
        tiles.forEach((t, i) => { if (letters.includes(rack[i]) && !isSpent(i)) t.classList.toggle('hint-lane', on); });
      },
    };
    draw({ instant: true });
    return d;
  }

  const sum = (w) => `${w.length} × ${E.notchOf(w)} = ${E.torqueOf(w)}`;
  const DEMOS = {
    // The practice beam: the anchor pulls 27, JAR then HOW on the right level it.
    async level(d) {
      d.say('The anchor pulls <b>27</b> on the left');
      await d.step(1600);
      await d.spell('JAR');
      d.say(`<span class="w">JAR</span> · ${sum('JAR')}`);
      await d.step(900);
      const n1 = d.arm('R');
      d.say(`Right arm: the preview lands on <b>${fmtNet(n1)}</b>`);
      await d.step(1300);
      d.place('R');
      d.say(`Placed · balance <b>${fmtNet(n1)}</b>`);
      await d.step(1300);
      await d.spell('HOW');
      d.arm('R');
      d.say(`<span class="w">HOW</span> · ${sum('HOW')} → <b>0</b>`);
      await d.step(1200);
      d.place('R');
      d.say('<span class="ok">Balanced!</span>');
      await d.step(2400);
    },
    // The heaviest letter sets the notch; length × notch is the torque.
    async torque(d) {
      d.say('Each tile shows its tier, 1 to 5');
      await d.step(1500);
      await d.spell('WAVE', 420);
      d.mark('W');
      d.say(`W is the heaviest (tier 4) · ${sum('WAVE')}`);
      await d.step(1500);
      d.mark('W', false);
      const n1 = d.arm('R');
      await d.step(1000);
      d.place('R');
      d.say(`Notch 4 · balance <b>${fmtNet(n1)}</b>`);
      await d.step(1300);
      await d.spell('SEA', 420);
      d.say(`<span class="w">SEA</span> · S is tier 2 · ${sum('SEA')}`);
      await d.step(1300);
      d.arm('R');
      await d.step(900);
      d.place('R');
      d.say('Closer to the pivot, less push · <span class="ok">balanced</span>');
      await d.step(2400);
    },
    // JOKE spends both heavy letters and strands the rack; JOB + KIT balances.
    async spend(d) {
      d.mark('JK');
      d.say('Pulls <b>31</b>. J and K are both tier 5');
      await d.step(1700);
      d.mark('JK', false);
      await d.spell('JOKE');
      d.say(`<span class="w">JOKE</span> · ${sum('JOKE')}, using both`);
      await d.step(1000);
      d.arm('R');
      await d.step(900);
      const n1 = d.place('R');
      d.say(`Balance <b>${fmtNet(n1)}</b>. Only B, I, T left…`);
      await d.step(1500);
      await d.spell('BIT');
      const n2 = d.arm('R');
      d.say(`<span class="w">BIT</span> · ${sum('BIT')} → <b>${fmtNet(n2)}</b>. Stuck.`);
      await d.step(1700);
      d.clear();
      d.undo();
      d.say('<b>Undo</b> is free. Split the heavy letters:');
      await d.step(1500);
      await d.spell('JOB');
      d.arm('R');
      await d.step(700);
      d.place('R');
      await d.step(900);
      await d.spell('KIT');
      const n3 = d.arm('R');
      d.say(`<span class="w">JOB</span> + <span class="w">KIT</span> = 30 → <b>${fmtNet(n3)}</b>`);
      await d.step(900);
      d.place('R');
      d.say('<span class="ok">Balanced</span> · two heavy letters, two words');
      await d.step(2600);
    },
  };
  const DEMO_SETUP = {
    level: { rack: 'JSAEROHWT', anchors: [{ side: 'L', notch: 3, mass: 9 }] },
    torque: { rack: 'WAVESEA', anchors: [{ side: 'L', notch: 2, mass: 11 }] },
    spend: { rack: 'JOBKITE', anchors: [{ side: 'L', notch: 5, mass: 5 }, { side: 'L', notch: 3, mass: 2 }] },
  };

  async function playDemo(host) {
    const run = ++demoRun;
    const name = host.dataset.demo;
    try {
      for (;;) await DEMOS[name](demoGame(host, run, DEMO_SETUP[name]));
    } catch (e) {
      if (e !== DEMO_STOP) throw e;
    }
  }

  /* ---------------- Walkthrough (as in Typeset and Cascade) ----------------
     A hand-built practice beam outside the daily rotation, played on the live
     rules. Each step lights the tiles and arm for one word; the player's own
     taps place it, and a coach card explains what the beam just did.
     tutorialMode keeps the clock, saves, stats and leaderboard out of it.
     Checked in test-engine.mjs: JAR then HOW on the right balances exactly. */
  const TUTORIAL = { rack: 'JSAEROHWT', anchors: [{ side: 'L', notch: 3, mass: 9 }], start: -27, par: 2, maxMoves: 3, difficulty: 'easy', stars: 1, line: [] };
  const TUT_STEPS = [
    { t: 'Welcome', next: 'Show me',
      x: 'The beam is tipped: the dark <b>anchor</b> on the left has mass 9 on notch 3, so it pulls with <b>27</b>. Your words push back. Get the balance within <b>±1</b>.' },
    { t: 'Build a word', word: 'JAR', side: 'R',
      x: 'Tap <b>J</b>, <b>A</b>, <b>R</b>. J is a tier-<span class="gd">5</span> letter, so the word lands on notch 5: <b>3 letters × 5 = 15</b>. Choose <b>Right</b>, watch the preview, then press Place.' },
    { t: 'The beam lifts',
      x: 'Balance went from −27 to <b>−12</b>. Those tiles are spent now, and the rack never refills.' },
    { t: 'Finish it', word: 'HOW', side: 'R',
      x: 'Now <b>HOW</b> on the right. Its heaviest letter is W (tier 4): <b>3 × 4 = 12</b>. The preview shows exactly where the beam will land.' },
  ];
  const tutStepData = () => (tutorialMode && TUT_STEPS[tutStep]) || null;
  const tutAccepts = (word, side) => { const st = tutStepData(); return !!st && st.word === word && st.side === side; };
  const tutRejectText = () => { const st = tutStepData(); return st && st.word ? `Place ${st.word} on the ${st.side === 'L' ? 'left' : 'right'}` : 'Follow the coach card'; };

  function coach(title, text, { next = null, prog = '', skip = true } = {}) {
    $('coachTitle').textContent = title;
    $('coachText').innerHTML = text;
    $('coachProg').textContent = prog;
    $('coachNext').hidden = !next;
    $('coachNext').textContent = next || '';
    $('coachSkip').hidden = !skip;
    $('coach').classList.add('show');
  }
  function hideCoach() { $('coach').classList.remove('show'); }
  function tutScroll() {
    const padPx = $('coach').offsetHeight + 28;
    document.body.style.paddingBottom = `${padPx}px`;
  }
  function tutGo(step) {
    tutStep = step;
    clearHint();
    const st = TUT_STEPS[step];
    if (!st) return;
    if (st.word) {
      const spent = spentSet();
      const taken = new Set();
      for (const ch of st.word) {
        const i = [...puzzle.rack].findIndex((c, j) => c === ch && !spent.has(j) && !taken.has(j));
        taken.add(i);
        tileEl(i).classList.add('hint-lane');
      }
      $(`arm${st.side}`).classList.add('hint-lane');
    }
    setTimeout(() => {
      if (!tutorialMode || tutStep !== step) return;
      coach(st.t, st.x, { next: st.word ? null : st.next || 'Next', prog: `${step + 1} / ${TUT_STEPS.length}` });
      tutScroll();
    }, 150);
  }
  function tutFinish() {
    coach('Balanced 🎉',
      'That\'s Fulcrum. Each day brings a new rack and a <b>par</b>: the fewest words that can level the beam. Heavy letters give leverage but only count once per word, so think a move ahead. <b>Undo</b> is free.',
      { next: 'Play today\'s puzzle', skip: false });
    tutScroll();
  }
  function startTutorial() {
    if (busy) return;
    stopDemos();
    document.querySelectorAll('.modal.show').forEach((m) => m.classList.remove('show'));
    clearInterval(countdownTimer);
    try { localStorage.setItem(SEEN_KEY, '1'); } catch (e) { /* ignore */ }
    if (!tutorialMode && game) { pauseClock(); saveState(); } // bank the real board before swapping it out
    tutorialMode = true;
    puzzle = { day: activeDay, ...TUTORIAL };
    game = freshGame();
    arm = null;
    showBoard();
    tutGo(0);
  }
  function leaveTutorial() {
    tutorialMode = false;
    tutStep = 0;
    game = null;
    hideCoach();
    document.body.style.paddingBottom = '';
  }
  function endTutorial() {
    leaveTutorial();
    loadDay(activeDay);
    window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
  }
  $('coachNext').addEventListener('click', () => {
    if (game && game.won) endTutorial(); // the closing card
    else tutGo(tutStep + 1);
  });
  $('coachSkip').addEventListener('click', endTutorial);

  function buildArchive() {
    const today = Math.max(0, dayNumber());
    const saves = readJSON(SAVE_KEY, {});
    const list = $('archList');
    list.innerHTML = '';
    for (let day = today; day >= 0; day--) {
      const s = saves[day];
      const solved = s && s.won;
      const started = s && !s.won && ((s.placed && s.placed.length) || (s.history && s.history.length));
      const row = document.createElement('button');
      row.className = `arch-row${day === activeDay ? ' current' : ''}`;
      const badge = day === today ? '<span class="atoday">Today</span>' : '';
      const status = solved ? '<span class="as done">✓</span>' : started ? '<span class="as">▶</span>' : '<span class="as"></span>';
      row.innerHTML = `<span class="an">#${day + 1}</span><span class="ad">${fmtDate(day, { weekday: 'short', month: 'short', day: 'numeric' })}</span>${badge}${status}`;
      row.addEventListener('click', () => { closeModal($('archiveModal')); loadDay(day); });
      list.appendChild(row);
    }
  }
  $('calBtn').addEventListener('click', () => { buildArchive(); openModal($('archiveModal')); });

  $('hintBtn').addEventListener('click', showMoveHint);
  $('undoBtn').addEventListener('click', undoMove);
  $('resetBtn').addEventListener('click', resetBoard);
  $('retryBtn').addEventListener('click', resetBoard);
  $('copyBtn').addEventListener('click', shareResult);
  window.addEventListener('resize', () => { if (game) renderBeam({ instant: true }); });

  /* ---------------- Boot ---------------- */
  function loadDay(day) {
    if (tutorialMode) leaveTutorial();
    else if (game) { pauseClock(); saveState(); }
    activeDay = day;
    puzzle = puzzleForDay(day);
    if (new URLSearchParams(location.search).has('debug')) {
      console.info(`Fulcrum #${day + 1} (${puzzle.dateKey}, ${puzzle.difficulty}) par ${puzzle.par}, start ${puzzle.start}:`,
        puzzle.line.map((m) => `${m.word}${m.side}`).join(' → '));
    }
    const saved = loadState(day);
    game = saved ? { ...freshGame(), ...saved } : freshGame();
    arm = null;
    showBoard();
    if (game.won) setTimeout(showWin, 600);
    else showReady(); // the clock starts from the ready card, not on load
  }

  // Ready card (as in Typeset): the board waits, blurred, until the player says go.
  function showReady() {
    const isToday = activeDay === dayNumber();
    const s = loadStats();
    const resuming = game.time > 0 || game.placed.length > 0 || game.history.length > 0;
    $('readyTitle').textContent = isToday ? 'Today\'s beam' : `Puzzle #${activeDay + 1}`;
    $('readySub').innerHTML = (isToday ? `Puzzle #${activeDay + 1} · ` : '') +
      `${starsHTML(puzzle.stars)} ${DIFF_LABELS[puzzle.stars]} · Par ${puzzle.par}`;
    $('rdPlayed').textContent = s.played;
    $('rdStreak').textContent = streakNow(s);
    $('rdMax').textContent = s.maxStreak;
    $('readyText').textContent = resuming
      ? 'The clock is paused. It picks up where you left off.'
      : `${puzzle.rack.length} tiles, up to ${puzzle.maxMoves} words. The clock starts when you begin; fewest words wins and time breaks ties.`;
    $('readyStart').textContent = resuming ? 'Resume' : 'Start';
    openModal($('readyModal'));
  }
  $('readyStart').addEventListener('click', () => { closeModal($('readyModal')); startClock(); });

  function showBoard() {
    sel = [];
    clearHint();
    renderHeader();
    renderAll({ enter: true, instant: true });
    showIdle();
    checkStuck();
  }

  function boot() {
    E.loadDictionary(self.FULCRUM_WORDS.split(' '), self.FULCRUM_COMMON.split(' '));
    self.FULCRUM_WORDS = self.FULCRUM_COMMON = null;
    const asked = new URLSearchParams(location.search).get('date');
    const day = asked && /^\d{4}-\d{2}-\d{2}$/.test(asked) ? Math.max(0, dayForKey(asked)) : Math.max(0, dayNumber());
    let seen = false;
    try { seen = !!localStorage.getItem(SEEN_KEY); } catch (e) { /* ignore */ }
    showSlide(0);
    loadDay(day);
    if (!seen) startTutorial(); // first visit plays the walkthrough; after that ? opens the deck
    void markVisit();
    $('loading').classList.add('gone');
    setTimeout(() => $('loading').remove(), 300);
  }

  // Let the loading veil paint before the dictionary loads.
  requestAnimationFrame(() => setTimeout(boot, 30));
})();
