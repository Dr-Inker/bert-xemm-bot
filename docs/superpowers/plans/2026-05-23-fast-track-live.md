# Fast-track to live — Phase A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the three bugs that have kept the bot degraded for 30+ hours, rip out the broken paper mode, and prepare the codebase for a clean 48-hour observer run (Phase B in the design doc).

**Architecture:** Five code-changing tasks (rip-out, BookCache fix, QuoterLoop defensive guard, AdverseFillTracker guard, docs) plus two operational tasks (DB cleanup script, deploy + smoke check) plus push. Each code task is TDD: failing test → minimal fix → green test → commit.

**Tech Stack:** TypeScript 5, Vitest, pnpm, better-sqlite3, systemd, the `kraken` CLI 0.3.2 binary.

**Spec:** `docs/superpowers/specs/2026-05-23-fast-track-live-design.md`

**Pre-flight assumption:** Working tree on `/opt/bert-xemm-bot`, branch `main`, uncommitted changes present from earlier observer/wallet work — that work gets reconciled into Task 1's commit. If the working tree is clean (no uncommitted), Task 1 still does the right thing (the deletions are idempotent).

---

## Task 1: Rip out paper mode

**Files:**
- Delete: `src/venues/krakenPaper.ts`
- Delete: `src/venues/mockDexVenue.ts`
- Delete: `tests/venues/krakenPaper.test.ts`
- Delete: `tests/venues/mockDexVenue.test.ts`
- Delete: `tests/integration/krakenPaperE2E.test.ts`
- Modify: `src/config.ts` (drop `'paper'` from `mode` enum)
- Modify: `src/orchestrator/wire.ts` (remove paper branch, remove MockDexVenue import + DexVenue selection)
- Modify: `src/main.ts` (remove `isPaperTxSig` import + check)

- [ ] **Step 1: Delete paper files**

```bash
rm /opt/bert-xemm-bot/src/venues/krakenPaper.ts
rm /opt/bert-xemm-bot/src/venues/mockDexVenue.ts
rm /opt/bert-xemm-bot/tests/venues/krakenPaper.test.ts
rm /opt/bert-xemm-bot/tests/venues/mockDexVenue.test.ts
rm /opt/bert-xemm-bot/tests/integration/krakenPaperE2E.test.ts
```

- [ ] **Step 2: Drop `'paper'` from config mode enum**

Edit `src/config.ts`. Find the `mode` field (it's `z.enum([...])`) and remove `'paper'`. Result:

```ts
mode: z.enum(['observer', 'live']),
```

- [ ] **Step 3: Remove paper branch from wire.ts**

Edit `src/orchestrator/wire.ts`. Apply these changes:

Remove the paper import:
```ts
// DELETE this line
import { KrakenPaper } from '../venues/krakenPaper.js';
```

Remove the MockDexVenue import:
```ts
// DELETE this line
import { MockDexVenue } from '../venues/mockDexVenue.js';
```

Replace the `cex` selection ternary (currently three-way) with a two-way:
```ts
// REPLACE the three-way ternary with this:
const cex: HedgeVenue = cfg.mode === 'observer'
  ? new KrakenObserver({ cliBinaryPath: cfg.kraken.cliBinaryPath, pair: cfg.kraken.pair })
  : new KrakenClient({
      cliBinaryPath: cfg.kraken.cliBinaryPath, pair: cfg.kraken.pair,
      apiKeyEnv: cfg.kraken.apiKeyEnv, apiSecretEnv: cfg.kraken.apiSecretEnv, paper: false,
    });
```

Replace the `dex` selection (which currently conditionally wraps with MockDexVenue) with just the raw raydium:
```ts
// REPLACE:
//   const dex: DexVenue = cfg.mode === 'paper' ? new MockDexVenue(raydium) : raydium;
// WITH:
const dex: DexVenue = raydium;
```

- [ ] **Step 4: Remove isPaperTxSig from main.ts**

Edit `src/main.ts`. Remove the import line:
```ts
// DELETE:
import { isPaperTxSig } from './venues/mockDexVenue.js';
```

And remove the early-return in the `txStatus` lambda (around line 95):
```ts
// DELETE this line from inside the txStatus async lambda:
if (isPaperTxSig(sig)) return 'confirmed';
```

The lambda becomes:
```ts
txStatus: async (sig) => {
  try {
    const r = await connection.getSignatureStatus(sig);
    // ... existing body
```

- [ ] **Step 5: Run tests, verify they pass**

Run: `cd /opt/bert-xemm-bot && pnpm test`
Expected: all remaining tests pass (~85 tests). Paper-related tests are gone. If anything fails, fix the import chain.

- [ ] **Step 6: Build, verify clean**

Run: `cd /opt/bert-xemm-bot && pnpm build`
Expected: exit 0, no TypeScript errors.

- [ ] **Step 7: Commit**

```bash
cd /opt/bert-xemm-bot
git add -A
git commit -m "$(cat <<'EOF'
feat(scope): rip out paper mode

Paper subprocess was calling kraken with an argv shape the 0.3.2 CLI does
not accept (kraken paper exit=1 on every quote), creating phantom PAPER-*
fills that poisoned the AdverseFillTracker and degraded the bot for 30+
hours. Per the fast-track design, paper mode is removed entirely; the
strategy is validated by observer data, then by small live capital. Modes
are now {observer, live}.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Fix BookCache one-sided merge (TDD)

**Files:**
- Modify: `src/venues/bookCache.ts`
- Test: `tests/venues/bookCache.test.ts`

**Context:** The Kraken WS book stream emits delta updates where one side can be `[]`. The current `BookCache.run` loop assigns the entire snapshot to `current` on every event, so bid-only deltas zero out the asks and vice versa. Fix: track `latestBids` and `latestAsks` separately, only update the non-empty side.

- [ ] **Step 1: Read existing bookCache test for patterns**

Run: `cat /opt/bert-xemm-bot/tests/venues/bookCache.test.ts`
Note the existing test structure (Vitest, async iterable mocks).

- [ ] **Step 2: Write failing test for bid-only delta keeping prior asks**

Append to `tests/venues/bookCache.test.ts`:

```ts
it('keeps prior asks when a bid-only delta arrives', async () => {
  const events: BookSnapshot[] = [
    { pair: 'BERT/USD', bids: [{ price: new Decimal('0.017'), volume: new Decimal('1000') }],
      asks: [{ price: new Decimal('0.018'), volume: new Decimal('1000') }], t: new Date(1) },
    { pair: 'BERT/USD', bids: [{ price: new Decimal('0.0171'), volume: new Decimal('1000') }],
      asks: [], t: new Date(2) },
  ];
  const cex = makeFakeCex(events);
  const cache = new BookCache('BERT/USD', testLogger);
  const run = cache.run(cex, 'BERT/USD', 10);
  await waitForUpdates(2);  // helper that lets the async loop drain events

  const snap = cache.snapshot();
  expect(snap.bids[0]!.price.toString()).toBe('0.0171');
  expect(snap.asks[0]!.price.toString()).toBe('0.018');  // preserved from event 1

  cache.shutdown();
  await run;
});
```

(If `makeFakeCex` / `waitForUpdates` helpers don't exist in the test file yet, port the pattern from the existing tests — `makeFakeCex` returns an object with `async *watchBook()` that yields the given array.)

- [ ] **Step 3: Write failing test for ask-only delta keeping prior bids**

Append:

```ts
it('keeps prior bids when an ask-only delta arrives', async () => {
  const events: BookSnapshot[] = [
    { pair: 'BERT/USD', bids: [{ price: new Decimal('0.017'), volume: new Decimal('1000') }],
      asks: [{ price: new Decimal('0.018'), volume: new Decimal('1000') }], t: new Date(1) },
    { pair: 'BERT/USD', bids: [],
      asks: [{ price: new Decimal('0.0181'), volume: new Decimal('1000') }], t: new Date(2) },
  ];
  const cex = makeFakeCex(events);
  const cache = new BookCache('BERT/USD', testLogger);
  const run = cache.run(cex, 'BERT/USD', 10);
  await waitForUpdates(2);

  const snap = cache.snapshot();
  expect(snap.bids[0]!.price.toString()).toBe('0.017');  // preserved
  expect(snap.asks[0]!.price.toString()).toBe('0.0181');

  cache.shutdown();
  await run;
});
```

- [ ] **Step 4: Run tests, verify they fail**

Run: `cd /opt/bert-xemm-bot && pnpm test bookCache`
Expected: the two new tests FAIL — bid-only test shows `snap.asks[0]` is undefined; ask-only test shows `snap.bids[0]` is undefined.

- [ ] **Step 5: Implement the merge fix in bookCache.ts**

Replace the body of `src/venues/bookCache.ts` with:

```ts
import type { BookSnapshot, BookLevel } from '../types.js';
import type { HedgeVenue } from './hedgeVenue.js';
import type { Logger } from '../logger.js';

/**
 * BookCache subscribes to `cex.watchBook(pair, depth)` and keeps the latest
 * BookSnapshot in memory so synchronous consumers (the QuoterLoop's readInputs
 * lambda) can read real top-of-book bid/ask without awaiting a stream.
 *
 * Tracks bids and asks separately because the Kraken WS book stream emits
 * per-side delta updates (one side may be []). Merging preserves the most
 * recent non-empty side until a new one arrives.
 */
export class BookCache {
  private latestBids: BookLevel[] = [];
  private latestAsks: BookLevel[] = [];
  private latestT: Date = new Date(0);
  private stop = false;
  constructor(private pair: string, private logger: Logger) {}

  async run(cex: HedgeVenue, pair: string, depth: number): Promise<void> {
    while (!this.stop) {
      try {
        for await (const snap of cex.watchBook(pair, depth)) {
          if (this.stop) break;
          if (snap.bids.length > 0) this.latestBids = snap.bids;
          if (snap.asks.length > 0) this.latestAsks = snap.asks;
          if (snap.t > this.latestT) this.latestT = snap.t;
        }
      } catch (err) {
        this.logger.warn({ err }, 'bookCache stream errored; reconnecting in 5s');
      }
      if (this.stop) break;
      await new Promise(r => setTimeout(r, 5_000));
    }
  }

  snapshot(): BookSnapshot {
    return { pair: this.pair, bids: this.latestBids, asks: this.latestAsks, t: this.latestT };
  }
  shutdown(): void { this.stop = true; }
}
```

If `BookLevel` is not exported from `types.ts`, export it:

```ts
// In src/types.ts, export the level shape:
export interface BookLevel { price: Decimal; volume: Decimal; }
```

(If it's already exported under a different name, use that.)

- [ ] **Step 6: Run tests, verify they pass**

Run: `cd /opt/bert-xemm-bot && pnpm test bookCache`
Expected: all bookCache tests pass (existing + the 2 new ones).

- [ ] **Step 7: Run full suite to verify no regression**

Run: `cd /opt/bert-xemm-bot && pnpm test`
Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
cd /opt/bert-xemm-bot
git add src/venues/bookCache.ts src/types.ts tests/venues/bookCache.test.ts
git commit -m "$(cat <<'EOF'
fix(bookCache): merge one-sided WS deltas instead of overwriting

The Kraken WS book stream emits per-side updates with bids=[] or asks=[]
on the opposite side. The previous implementation overwrote the whole
snapshot on every event, so 99.4% of recorded basis_samples ended up with
kraken_bid=0 or kraken_ask=0. Now bids/asks are tracked separately and
only updated when the incoming side is non-empty.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Skip basis sample when book is incomplete (TDD)

**Files:**
- Modify: `src/orchestrator/quoterLoop.ts`
- Test: `tests/orchestrator/quoterLoop.test.ts`

**Context:** Defensive layer in addition to Task 2. Even with a merged BookCache, the snapshot can be one-sided at startup (before both sides have been observed). The QuoterLoop should skip recording a basis sample in that case rather than writing `0`.

- [ ] **Step 1: Read existing quoterLoop test for patterns**

Run: `cat /opt/bert-xemm-bot/tests/orchestrator/quoterLoop.test.ts`
Note how the loop is constructed in tests (`store`, `readInputs`, etc).

- [ ] **Step 2: Write failing test — empty book → no insertBasisSample**

Append to `tests/orchestrator/quoterLoop.test.ts`:

```ts
it('does not record basis sample when both book sides are empty', async () => {
  const inserted: unknown[] = [];
  const store = {
    insertBasisSample: (r: unknown) => { inserted.push(r); },
    insertOrder: () => {},
    getFlag: () => null,
  };
  const cex = makeNoOpCex();
  const loop = new QuoterLoop({
    cex, store, logger: testLogger,
    readInputs: async () => ({
      krakenBook: { pair: 'BERT/USD', bids: [], asks: [], t: new Date() },
      ref: { raydiumMidUsd: new Decimal('0.017'), solUsd: new Decimal('100') },
      // ... whatever other fields QuoterInput needs — fill with safe defaults from existing tests
    } as never),
  });
  await loop.tick();
  expect(inserted).toHaveLength(0);
});
```

- [ ] **Step 3: Write failing test — bid-only book → no insertBasisSample**

```ts
it('does not record basis sample when only one side is populated', async () => {
  const inserted: unknown[] = [];
  const store = { /* same as above */ };
  const loop = new QuoterLoop({
    cex: makeNoOpCex(), store, logger: testLogger,
    readInputs: async () => ({
      krakenBook: {
        pair: 'BERT/USD',
        bids: [{ price: new Decimal('0.017'), volume: new Decimal('1000') }],
        asks: [],
        t: new Date(),
      },
      ref: { raydiumMidUsd: new Decimal('0.017'), solUsd: new Decimal('100') },
    } as never),
  });
  await loop.tick();
  expect(inserted).toHaveLength(0);
});
```

- [ ] **Step 4: Write regression test — full book → insertBasisSample called**

```ts
it('records basis sample when both book sides are populated', async () => {
  const inserted: unknown[] = [];
  const store = { /* same */ };
  const loop = new QuoterLoop({
    cex: makeNoOpCex(), store, logger: testLogger,
    readInputs: async () => ({
      krakenBook: {
        pair: 'BERT/USD',
        bids: [{ price: new Decimal('0.017'), volume: new Decimal('1000') }],
        asks: [{ price: new Decimal('0.018'), volume: new Decimal('1000') }],
        t: new Date(),
      },
      ref: { raydiumMidUsd: new Decimal('0.017'), solUsd: new Decimal('100') },
    } as never),
  });
  await loop.tick();
  expect(inserted).toHaveLength(1);
});
```

- [ ] **Step 5: Run tests, verify the two skip-tests fail**

Run: `cd /opt/bert-xemm-bot && pnpm test quoterLoop`
Expected: the two new "does not record" tests FAIL (insertBasisSample is called); the regression test passes.

- [ ] **Step 6: Implement the skip in quoterLoop.ts**

Edit `src/orchestrator/quoterLoop.ts`. In `tick()`, before the `insertBasisSample` call, add:

```ts
// In tick(), after `const intents = decideQuotes(input);` and before `const now = ...`
// REPLACE the existing topBid/topAsk derivation + insertBasisSample block with:

const topBid = input.krakenBook.bids[0]?.price;
const topAsk = input.krakenBook.asks[0]?.price;
const now = new Date().toISOString();

if (topBid !== undefined && topAsk !== undefined) {
  this.o.store.insertBasisSample({
    t: now,
    raydiumMidUsd: input.ref.raydiumMidUsd.toString(),
    krakenBid: topBid.toString(),
    krakenAsk: topAsk.toString(),
    solUsd: input.ref.solUsd.toString(),
    wouldHaveActed: intents.some(i => i.action === 'place'),
  });
}

for (const intent of intents) await this.dispatch(intent, now);
```

- [ ] **Step 7: Run tests, verify all pass**

Run: `cd /opt/bert-xemm-bot && pnpm test quoterLoop`
Expected: all three new tests pass, existing tests still pass.

- [ ] **Step 8: Run full suite**

Run: `cd /opt/bert-xemm-bot && pnpm test`
Expected: all green.

- [ ] **Step 9: Commit**

```bash
cd /opt/bert-xemm-bot
git add src/orchestrator/quoterLoop.ts tests/orchestrator/quoterLoop.test.ts
git commit -m "$(cat <<'EOF'
fix(quoter): skip basis sample when book is incomplete

Defensive guard in addition to the bookCache merge fix. The cached
snapshot can be one-sided at startup before both bids and asks have been
observed; in that case skip the basis_samples row instead of recording
zeros. Eliminates a class of garbage data even if upstream regresses.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: AdverseFillTracker sparse-sample guard (TDD)

**Files:**
- Modify: `src/strategy/adverseFillTracker.ts`
- Test: `tests/strategy/adverseFillTracker.test.ts`

**Context:** With paper mode gone, phantom fills can't poison the tracker through observer. But sparse fills in early-live could still produce a 100% adverse reading from 1-2 samples, which would trip the watchdog inappropriately. Add a `minResolved` guard (default 5).

- [ ] **Step 1: Read existing tracker test for patterns**

Run: `cat /opt/bert-xemm-bot/tests/strategy/adverseFillTracker.test.ts`

- [ ] **Step 2: Write failing test — 3 resolved fills all adverse → returns 0**

Append to `tests/strategy/adverseFillTracker.test.ts`:

```ts
it('returns 0 when fewer than minResolved fills have resolved (default 5)', async () => {
  vi.useFakeTimers();
  const tracker = new AdverseFillTracker({
    postFillDelayMs: 100,
    getMidUsd: async () => new Decimal('0.016'),   // BUY at 0.017, post 0.016 → adverse
  });
  for (let i = 0; i < 3; i++) {
    tracker.recordFill({
      fillId: `f${i}`, orderClOrdId: 'o', side: 'buy',
      price: new Decimal('0.017'), volume: new Decimal('100'),
      fee: new Decimal('0'), t: new Date(),
    });
  }
  await vi.advanceTimersByTimeAsync(200);
  expect(tracker.adverseShareLast20()).toBe(0);
  tracker.shutdown();
  vi.useRealTimers();
});
```

- [ ] **Step 3: Write regression test — 5 resolved fills all adverse → returns 1.0**

```ts
it('returns 1.0 when minResolved adverse fills have resolved', async () => {
  vi.useFakeTimers();
  const tracker = new AdverseFillTracker({
    postFillDelayMs: 100,
    getMidUsd: async () => new Decimal('0.016'),
  });
  for (let i = 0; i < 5; i++) {
    tracker.recordFill({
      fillId: `f${i}`, orderClOrdId: 'o', side: 'buy',
      price: new Decimal('0.017'), volume: new Decimal('100'),
      fee: new Decimal('0'), t: new Date(),
    });
  }
  await vi.advanceTimersByTimeAsync(200);
  expect(tracker.adverseShareLast20()).toBe(1);
  tracker.shutdown();
  vi.useRealTimers();
});
```

- [ ] **Step 4: Run tests, verify the sparse test fails**

Run: `cd /opt/bert-xemm-bot && pnpm test adverseFillTracker`
Expected: the "fewer than minResolved" test FAILS (returns 1 not 0). The 5-fill test PASSES (existing behavior).

- [ ] **Step 5: Add minResolved guard in adverseFillTracker.ts**

Edit `src/strategy/adverseFillTracker.ts`:

In the `AdverseFillTrackerOpts` interface, add the optional field:
```ts
export interface AdverseFillTrackerOpts {
  windowSize?: number;
  postFillDelayMs?: number;
  minResolved?: number;          // NEW — default 5
  getMidUsd: () => Promise<Decimal>;
}
```

In `adverseShareLast20()`, add the guard at the top:
```ts
adverseShareLast20(): number {
  const resolved = this.fills.filter(f => f.postMidUsd !== null);
  if (resolved.length < (this.opts.minResolved ?? 5)) return 0;
  if (resolved.length === 0) return 0;   // (kept as defense; the guard above subsumes it)
  let adverse = 0;
  // ... existing math
}
```

- [ ] **Step 6: Run tests, verify all pass**

Run: `cd /opt/bert-xemm-bot && pnpm test adverseFillTracker`
Expected: both tests pass.

- [ ] **Step 7: Run full suite**

Run: `cd /opt/bert-xemm-bot && pnpm test`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
cd /opt/bert-xemm-bot
git add src/strategy/adverseFillTracker.ts tests/strategy/adverseFillTracker.test.ts
git commit -m "$(cat <<'EOF'
fix(adverseFill): require minResolved samples before tripping

A single adverse fill should not trip the watchdog at 100%. Add a guard
that returns 0 when fewer than minResolved (default 5) post-mids have
resolved. Belt-and-suspenders against the phantom-fill class of bug; also
prevents false positives in early live when fills are sparse.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: DB cleanup script

**Files:**
- Create: `scripts/clear-degraded-state.sh`

**Context:** Operational helper to reset the poisoned state in `/var/lib/bert-xemm-bot/state.db`. Idempotent; safe to re-run.

- [ ] **Step 1: Create the script**

Create `scripts/clear-degraded-state.sh` with:

```bash
#!/usr/bin/env bash
# Clear poisoned bot state. Run when intentionally resetting after a known issue.
# Truncates orders/fills/hedges/kill_events; clears degraded flag.
# Preserves basis_samples (next observer run appends clean rows).

set -euo pipefail

DB="${1:-/var/lib/bert-xemm-bot/state.db}"

if [ ! -f "$DB" ]; then
  echo "DB not found: $DB" >&2
  exit 1
fi

echo "Clearing degraded state in $DB"
sqlite3 "$DB" <<'SQL'
DELETE FROM kill_events;
DELETE FROM hedges;
DELETE FROM fills;
DELETE FROM orders;
INSERT INTO flags(k, v) VALUES('degraded', '0')
  ON CONFLICT(k) DO UPDATE SET v='0';
SQL

echo "Done. State after cleanup:"
sqlite3 "$DB" "SELECT 'kill_events', COUNT(*) FROM kill_events
               UNION ALL SELECT 'hedges', COUNT(*) FROM hedges
               UNION ALL SELECT 'fills', COUNT(*) FROM fills
               UNION ALL SELECT 'orders', COUNT(*) FROM orders
               UNION ALL SELECT 'degraded_flag', COUNT(*) FROM flags WHERE k='degraded' AND v='0';"
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x /opt/bert-xemm-bot/scripts/clear-degraded-state.sh
```

- [ ] **Step 3: Smoke check the script syntax (do NOT run against the prod DB yet)**

Run: `bash -n /opt/bert-xemm-bot/scripts/clear-degraded-state.sh && echo "syntax ok"`
Expected: `syntax ok`

- [ ] **Step 4: Commit**

```bash
cd /opt/bert-xemm-bot
git add scripts/clear-degraded-state.sh
git commit -m "$(cat <<'EOF'
ops: add clear-degraded-state.sh helper

Resets poisoned bot state when intentionally clearing (e.g., after a
bug fix that requires fresh tables). Idempotent. Preserves basis_samples
because the next observer run appends clean rows on top of any prior data.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Docs updates

**Files:**
- Modify: `docs/DEPLOY.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update DEPLOY.md**

Edit `docs/DEPLOY.md`:

1. In the "Phase progression" table/list, remove the row/line for `Paper (week 2-4)`. Renumber subsequent phases so warm-up is Phase 2, ramp is Phase 3.
2. Remove the entire `## 7-day fast track (compressed)` section (it ends in paper mode).
3. In the prerequisites list, change the hot-wallet keyfile permission guidance from `0600` to `0640 root:bertxemm` (the bot's group needs read access; 0600 denies it).

- [ ] **Step 2: Update CLAUDE.md**

Edit `CLAUDE.md`:

1. In the headline status block, replace the current "Status as of …" line with one reflecting paper rip-out + observer-fix completion. Suggested:

```
**Status as of 2026-05-23: Paper mode removed. BookCache merge fix + AdverseFillTracker guard
landed. Ready for clean 48h observer run per
docs/superpowers/specs/2026-05-23-fast-track-live-design.md.**
```

2. In the "Phase progression" section, delete the paper-mode bullet (currently item 2). Renumber subsequent items.
3. In the "Don't do" section, remove any paper-specific instructions if present.
4. In the file list, remove `krakenPaper.ts` and `mockDexVenue.ts`.

- [ ] **Step 3: Commit**

```bash
cd /opt/bert-xemm-bot
git add docs/DEPLOY.md CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: reflect paper rip-out and 0640 keyfile perms

Remove paper-mode references from DEPLOY.md and CLAUDE.md. Fix the
hot-wallet keyfile guidance from 0600 (denies bot's group) to 0640
root:bertxemm.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Deploy & smoke check (operational, no commit)

**Context:** Operator-driven. The bot is currently running in (broken) paper mode under systemd. Switch it to observer mode using the fixed build, then run the smoke check from the spec to gate the start of the 48h clock.

- [ ] **Step 1: Stop the service**

```bash
sudo systemctl stop bert-xemm-bot
```

Expected: command returns within ~5s. Verify with `systemctl status bert-xemm-bot --no-pager | head -3` — should show `inactive (dead)`.

- [ ] **Step 2: Run the cleanup script**

```bash
sudo -u bertxemm /opt/bert-xemm-bot/scripts/clear-degraded-state.sh
```

Expected output ends with all counts at 0 except `degraded_flag` showing 1 (one row with v='0').

- [ ] **Step 3: Flip the config to observer mode**

Edit `/etc/bert-xemm-bot/config.yaml`. Change the first line from:
```yaml
mode: paper
```
to:
```yaml
mode: observer
```

- [ ] **Step 4: Rebuild from the cleaned source**

```bash
cd /opt/bert-xemm-bot && pnpm build
```

Expected: exit 0, `dist/` updated.

- [ ] **Step 5: Restart the service**

```bash
sudo systemctl start bert-xemm-bot
sleep 5
sudo systemctl status bert-xemm-bot --no-pager | head -10
```

Expected: `Active: active (running)`. No errors in the immediate log.

- [ ] **Step 6: Wait 5 minutes for samples to accumulate**

```bash
sleep 300
```

(Or come back after 5 minutes — no need to babysit.)

- [ ] **Step 7: Run smoke check — heartbeat freshness**

```bash
HEARTBEAT_AGE=$(($(date +%s) - $(stat -c %Y /var/lib/bert-xemm-bot/heartbeat)))
echo "heartbeat age: ${HEARTBEAT_AGE}s"
```

Expected: < 30s.

- [ ] **Step 8: Smoke check — basis samples accumulating**

```bash
sqlite3 /var/lib/bert-xemm-bot/state.db \
  "SELECT COUNT(*) AS n, MIN(t) AS first, MAX(t) AS last
   FROM basis_samples WHERE t > datetime('now', '-5 minutes');"
```

Expected: `n` > 0; `first`/`last` within the last 5 minutes.

- [ ] **Step 9: Smoke check — >95% of new samples have both sides populated**

```bash
sqlite3 /var/lib/bert-xemm-bot/state.db \
  "SELECT printf('%.1f', SUM(CASE WHEN kraken_bid > 0 AND kraken_ask > 0 THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0)) AS pct_valid
   FROM basis_samples WHERE t > datetime('now', '-5 minutes');"
```

Expected: ≥ 95.0. **If < 95, the fix didn't take. Stop here. Do not start the 48h clock. Investigate.**

- [ ] **Step 10: Smoke check — no kill events, no degraded flag**

```bash
sqlite3 /var/lib/bert-xemm-bot/state.db "SELECT COUNT(*) AS new_kills FROM kill_events;"
sqlite3 /var/lib/bert-xemm-bot/state.db "SELECT * FROM flags WHERE k='degraded';"
```

Expected: `new_kills = 0`, `degraded|0`.

- [ ] **Step 11: Smoke check — journal clean**

```bash
sudo journalctl -u bert-xemm-bot --since "5 minutes ago" -p err --no-pager
```

Expected: empty (no error-level lines).

- [ ] **Step 12: Start the 48h clock**

If all smoke checks passed, record the start time:

```bash
date -Iseconds | tee /tmp/observer-start.txt
```

This is hour 0 of Phase B. Hands-off for 48h. Phase C review fires at hour 48.

---

## Task 8: Push to GitHub

- [ ] **Step 1: Verify local commits and push**

```bash
cd /opt/bert-xemm-bot
git log --oneline -10
git push origin main
```

Expected: push completes; remote `main` now at the new HEAD with the six new commits from Tasks 1-6.

---

## Self-review (filled in)

**1. Spec coverage:**
- Phase A1 (delete paper mode) → Task 1 ✓
- Phase A2 (BookCache one-sided fix) → Task 2 ✓
- Phase A3 (AdverseFillTracker guard) → Task 4 ✓
- Phase A4 (DB cleanup) → Task 5 (script) + Task 7 step 2 (execution) ✓
- Phase A5 (tests) → covered inline in Tasks 2/3/4 ✓
- Phase A6 (commit + push) → Tasks 1/2/3/4/5/6 each commit; Task 8 pushes ✓
- Phase B1/B2/B3/B4 (config switch + smoke check) → Task 7 ✓
- Phase B3 hands-off period → Task 7 step 12 ✓
- Phases C/D/E are operational/decision-making (covered by the spec, no code work in this plan) ✓
- Defensive writer-level skip from spec A2 last paragraph ("skip the write entirely if either side is empty") → Task 3 ✓

**2. Placeholder scan:**
- No "TODO", "TBD", "XXX", "implement later" present in the plan body.
- The phrase "fill with safe defaults from existing tests" in Task 3 Step 2 is the closest to a placeholder — it's acceptable because the existing test file shows the QuoterInput shape and the implementing subagent will read it before writing the test (Step 1 of Task 3 says to do exactly that).

**3. Type consistency:**
- `BookLevel` referenced in Task 2 Step 5 — Task 2 Step 5 explicitly addresses exporting it if not already exported.
- `AdverseFillTrackerOpts.minResolved` added in Task 4 Step 5, used in the guard on the same step. Consistent.
- `QuoterLoop` constructor shape (`{ cex, store, readInputs, logger }`) used in Task 3 tests matches `QuoterLoopOpts` in the current source.
- Commit messages all reference real file paths and existing behavior.
