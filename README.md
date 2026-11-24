# Fulcrum

*Build words. Shift the weight. Find the balance.*

A daily word strategy puzzle from the same workshop as Tumbler, Currents, Typeset, Pathword and Cascade. Build 3–5 letter words from a fixed rack of tiles and place them on either arm of a balance beam until the net torque is within ±1.

## Run it

No build step and no dependencies. Open `index.html` in a browser (it works from `file://`), or serve the folder:

```sh
npx serve .            # or: python3 -m http.server
```

URL parameters for testing:

- `?date=2026-12-03` opens another day's beam.
- `?debug` logs the solver's par line to the console.

## Rules

| Tier | Letters | Notch |
| --- | --- | --- |
| 1 | A E I O U | 1 |
| 2 | L N R S T | 2 |
| 3 | B C D G M P | 3 |
| 4 | F H V W Y | 4 |
| 5 | J K Q X Z | 5 |

- A word lands on the notch of its **heaviest letter**. Mass = letters. **Torque = mass × notch.**
- Net torque = right − left. Anchors are fixed. Win at −1, 0 or +1, checked after every word.
- **Words are 3–5 letters**, must be in the dictionary, and can't repeat. Each tile is used once and the rack never refills. A word that isn't accepted costs nothing.
- Undo is unlimited and free. Reset restores the start, and Undo brings it back.
- Grades: at par **Gold**, par + 1 **Solved**, under par **Exceptional** (shouldn't happen: par is proven). A day you play but don't balance counts as a **Miss**.
- A miss state appears when you're out of moves or no word can be formed. Undo still works.
- New puzzle at **midnight UTC** for everyone. Puzzle #1 is **24 Nov 2026** (`EPOCH` in `js/app.js`).

| | Par | Rack | Move cap | Quality gate |
| --- | --- | --- | --- | --- |
| Easy (Mon, Tue) | 3 | 12 | 4 | 40+ openings keep par in reach |
| Medium (Wed, Thu, Sat) | 3 | 15 | 4 | 10–150 openings keep par; ≥25% of tempting openings miss it |
| Hard (Fri, Sun) | 4 | 18 | 5 | 5–250 openings keep par; ≥35% of tempting openings miss it |

A "tempting" opening is one that brings the beam closer to level. Difficulty comes from how tight the board is, not par alone (spec §16G). The thresholds live in `DIFFICULTY` in `js/engine.js`.

## Changes from the V1 spec, and why

**Words are capped at 5 letters (spec: no limit).** Torque per tile equals the word's notch, so with a full dictionary one long word could cover almost any imbalance. In testing, random boards were nearly always solvable in one or two words. The only way to prove par 3–5 was to engineer racks with one vowel per word, and every puzzle came out the same shape. With the cap, a word tops out at 25 torque. Ordinary racks built from everyday words now give provable pars (19–20 of 20 test racks per difficulty), start torques vary from day to day, and the dictionary shrinks from 1.7 MB to 86 KB.

**Par is 3 / 3 / 4 (spec: 3 / 4 / 5).** On ordinary racks, par 5 wasn't provable on any test rack, even with the cap. Medium and Hard are separated by rack size and the quality gate instead.

**Overshooting isn't promised.** Spec §10B describes deliberately overshooting and correcting on the other arm. In every proven board tested (a dozen rule variants), an all-one-arm line was as short as any two-arm line, so overshooting is never required. It's still legal, and it's a handy recovery when a word lands too heavy, but the tutorial and How to play don't teach it as strategy. The real tension is letter budgeting: a heavy letter counts once per word, so spending two in one word wastes one.

**Leaderboard (spec: out of scope).** Added on request, matching the other games.

## How par is guaranteed

For each date, `buildDaily()` in `js/engine.js` tries seeded salts until one passes:

1. Build the rack from `par` everyday 3–5 letter words plus spare tiles, shuffled.
2. Scan start torques in a seeded order. Keep the first one that meets all three conditions:
   - **Proven par.** The solver checks the full dictionary and proves the minimum is exactly par. It searches every subset of the rack, memoised on (remaining tiles, net torque).
   - **Friendly answer.** An answer of that length exists using only everyday words.
   - **Quality.** The difficulty's quality gate passes.
3. Build anchors that produce that start torque.

Each board in the bank is then re-checked independently (`validate()` in `scripts/generate.mjs`). A fresh solver re-proves par, and the answer is replayed through the in-game word rules.

## Dictionary

One versioned list (`DICT_VERSION`) serves both generation and play: ENABLE words of 3–5 letters (13.5k words, no proper nouns, abbreviations, hyphens or apostrophes). Generated racks, answers and hints draw on ~2.5k everyday words and skip a blocklist of names and slurs (`POOL_BLOCK`). Players may place any valid word.

## Shared workshop conventions

- **Design tokens, masthead, modals, ready card, archive, stats, More games**: copied from Cascade (which follows Currents and Typeset).
- **How to play**: a Typeset-style slide deck. Each slide loops a short simulated game on the real beam, rack and arm pieces: tiles get tapped, the preview lands, the word drops and the beam swings. The numbers come from the engine, and `test-engine.mjs` checks each clip's story.
  - *Level the beam*: JAR, then HOW, levels a 27 pull.
  - *Torque*: WAVE on notch 4 vs SEA on notch 2.
  - *Spend heavy letters wisely*: JOKE strands the rack; Undo; JOB + KIT balances.
- **Walkthrough**: on first visit, a practice beam with a coach card (JAR, then HOW, on the right). It never touches the clock, saves, stats or the leaderboard.
- **Hint**: in Fulcrum the hard part is knowing whether earlier words already cost you par, so hints start with your position, not an answer. Each step adds 1 to the leaderboard score, and the button label says what the next tap gives.
  - *Nothing built*, a ladder that resets after every placed or undone word:
    1. **Check**: par still in reach (and how many words to go)? If not, how many words to undo. The Undo button glows.
    2. **Nudge**: arm, notch and word length, with the heavy letter glowing.
    3. **Reveal**: the word, filled in with its arm chosen, ready to place.
  - *Word built*: Hint judges that move before you commit, on your chosen arm or on both: keeps par, par lost, dead end, or balances it. A word that isn't playable is reported free; re-checking the same move is free.
  - Engine: `assess()`, `judgeMove()` and `hint()` in `js/engine.js`, covered by `test-engine.mjs`.
- **Daily leaderboard**: same flow as Typeset and Cascade (trophy button, Today/Yesterday tabs, a name card on first win). Stored in the shared Firebase under `fulcrum/daily/{day}/{playerId}`. Score = words + hint taps; ties go to the faster solve. Only the first win on today's beam posts. If the database has per-game security rules, `fulcrum/` needs the same rules as `cascade/`.
- **Share** (spec §15): `FULCRUM #004 / ⚖️ Gold / Words: 3 / Par: 3 / Balance: 0 / 🟦🟦🟦`, where 🟦 is left and 🟧 is right.

## Files

| Path | What it is |
| --- | --- |
| `index.html`, `css/styles.css` | Page shell, modals and styles (shared tokens + beam, rack, arms) |
| `js/engine.js` | Pure logic: tiers, torque, solver, generator, quality gate, hints. Runs in Node too. |
| `js/app.js` | UI: rack input (tap or type), damped-spring beam, preview, undo/reset, hint, archive, stats, share, leaderboard, clips, walkthrough |
| `js/words.js` | Generated dictionary (3–5 letters) |
| `js/puzzles.js` | Generated bank: 400 proven boards from 24 Nov 2026. Dates past the bank are built in the browser with the same code. |
| `scripts/build-words.mjs` | Rebuilds `js/words.js` from `data/` |
| `scripts/generate.mjs` | Builds, validates and appends to the bank |
| `scripts/test-engine.mjs` | Spec examples, word rules, clip and walkthrough lines, bank replay and re-proof, determinism, hint speed |
| `scripts/analyze.mjs` | Dev-only quality analyzer (spec §17): uniqueness, decisions, forced moves, dead ends, word dependency, elegance → `data/quality.json` |

```sh
node scripts/build-words.mjs
node scripts/generate.mjs 400        # ~20 min; keeps existing boards
node scripts/test-engine.mjs 30
node scripts/analyze.mjs 30
```

Changing the generator, tiers, word cap, difficulty table or dictionary changes `fingerprint()`. Rebuild the bank afterwards: the app ignores a bank whose fingerprint doesn't match.
