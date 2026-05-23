# Fast-track to live — Design

**Date:** 2026-05-23
**Author:** Claude (paired with operator)
**Status:** Approved, awaiting implementation plan
**Supersedes:** the "Phase 1 ready" framing in `CLAUDE.md` and the 7-day fast-track in `docs/DEPLOY.md` (uncommitted)

## Problem

The bot has been running on the host as `bert-xemm-bot.service` for ~30 hours in `mode: paper`. Investigation on 2026-05-23 found it is **degraded since startup** and producing no useful data:

| Symptom | Detail |
|---|---|
| `flags.degraded=1` since service start | Quoter spinning "skipping" every 2.5s for 30h+ |
| AdverseFillTracker reads 100% | Tripping watchdog every 5s (19,400+ kill events) |
| `kraken paper` subprocess errors with `exit=1` | `KrakenPaper.placeLimit` argv shape does not match CLI 0.3.2 surface |
| Phantom fills | `PAPER-NNNNN` IDs in `orders`/`hedges` from the broken paper path poisoned the adverse-fill tracker |
| 7 hedges stuck in `intent_queued` | MockDexVenue path never advanced them past intent stage |
| **BookCache writes 0 for missing side** | Of 7,313 basis samples, only 43 (0.6%) had both `kraken_bid` AND `kraken_ask` populated |
| Of the 43 valid samples | avg basis 42 bps, max 98 bps, **0 crossings above 140 bps** round-trip cost floor |

The apparent "Phase 1.5 ready, just flip to live" status in `CLAUDE.md` is wrong. Three real bugs sit between current state and any useful mode (observer, paper, live). Paper mode in particular is the source of the phantom fills.

## Goal

Get to a defensible **go/no-go decision on live deployment**, fast, by:

1. Stripping out the broken paper path (operator already considers paper "noise")
2. Fixing the bugs that prevent observer mode from collecting clean data
3. Running 48 hours of clean observer data
4. Letting the basis distribution decide whether live makes sense — and at what shape

This is **not** a plan to ship live. It is a plan to know, with real data, whether live is worth shipping. The framing came from the operator's position that paper trading is mostly noise; the real test is real fills, but only after the strategy itself shows edge in observer.

## Non-goals

- Restoring paper mode. It gets deleted in Phase A.
- Adding new strategy features. The quoter / hedger / watchdog logic stays as-is.
- Adding a KuCoin or Drift hedge venue (parked as v2 — see project memory).
- Re-running the original 14-day observer schedule. 48h is enough to see the distribution; if it's genuinely borderline, Phase C has an "extend 48h" path.

## Plan

Five phases. Phase A is implementation. Phase B is hands-off (48h wall clock). Phase C is the review. Phase D is operator-side pre-prep running parallel to B. Phase E is a framework for the live launch — only invoked if Phase C says GO.

### Phase A — Bug fixes + paper rip-out (single session, ~3-4h)

**A1. Delete paper mode.**

Files removed:

- `src/venues/krakenPaper.ts`
- `src/venues/mockDexVenue.ts`
- `tests/venues/krakenPaper.test.ts`
- `tests/venues/mockDexVenue.test.ts`
- `tests/integration/krakenPaperE2E.test.ts` (already skipped)

Code edits:

- `src/config.ts` — drop `'paper'` from the `mode` zod enum (keep `observer | live`)
- `src/orchestrator/wire.ts` — delete the `mode === 'paper'` branch in `wireVenues`
- `src/main.ts` — drop the two uncommitted lines that reference paper
- `docs/DEPLOY.md` — remove the paper phase row from the table; remove the 7-day fast-track section (it ends in paper); fix the keyfile permissions guidance from `0600` to `0640 root:bertxemm` (current value denies the bot's group)
- `CLAUDE.md` — remove paper references from phase progression + headline status

**A2. BookCache one-sided fix.**

Root cause: the WS event filter `if (!d.bids || !d.asks) continue` lets through events where `bids` or `asks` is `[]` (empty array is truthy in JS). The Kraken `kraken ws book` stream emits delta updates per side; each delta overwrites the cached snapshot with one side empty, so 99.4% of recorded samples have one side at 0.

Fix: maintain `latestBids` and `latestAsks` separately in `BookCache`. On each event, update only the non-empty side. `snapshot()` returns the merged view. Either side empty until both have been seen at least once.

```ts
// bookCache.ts — pseudo-diff
private latestBids: BookLevel[] = [];
private latestAsks: BookLevel[] = [];
private latestT: Date = new Date(0);

async run(cex: HedgeVenue, pair: string, depth: number) {
  while (!this.stop) {
    try {
      for await (const snap of cex.watchBook(pair, depth)) {
        if (this.stop) break;
        if (snap.bids.length > 0) this.latestBids = snap.bids;
        if (snap.asks.length > 0) this.latestAsks = snap.asks;
        if (snap.t > this.latestT) this.latestT = snap.t;
      }
    } catch (err) { this.logger.warn({ err }, 'bookCache stream errored; reconnecting in 5s'); }
    if (this.stop) break;
    await new Promise(r => setTimeout(r, 5_000));
  }
}

snapshot(): BookSnapshot {
  return { pair: this.pair, bids: this.latestBids, asks: this.latestAsks, t: this.latestT };
}
```

Additionally, in the basis-sample writer: skip the write entirely if either side is empty rather than recording 0. No reason to persist garbage.

**A3. AdverseFillTracker phantom-fill safety.**

Today: trips at 100% with phantom fills, no minimum-sample requirement.

Fix: add a guard — return `0` (not-tripping) when `resolved.length < minResolved` (default 5). Existing logic stays, just gated on enough samples to be statistically meaningful.

```ts
adverseShareLast20(): number {
  const resolved = this.fills.filter(f => f.postMidUsd !== null);
  if (resolved.length < (this.opts.minResolved ?? 5)) return 0;  // NEW guard
  // ... existing math
}
```

With paper mode gone, the phantom `PAPER-*` fill path can't fire in observer (which makes `placeLimit` a no-op per audit gap #12 fix in commit `12232ed`). The guard is belt-and-suspenders for early-live with sparse fills.

**A4. DB cleanup.**

Truncate the poisoned tables before service restart:

```sql
DELETE FROM kill_events;
DELETE FROM hedges;
DELETE FROM fills;
DELETE FROM orders;
UPDATE flags SET v='0' WHERE k='degraded';
-- basis_samples kept (next observer run will append clean rows)
```

Run via `sudo -u bertxemm sqlite3 /var/lib/bert-xemm-bot/state.db`.

**A5. Tests.**

- `BookCache` with bid-only delta → snapshot keeps prior asks
- `BookCache` with ask-only delta → snapshot keeps prior bids
- `AdverseFillTracker` with 3 resolved fills (all adverse) → returns 0 not 1
- `AdverseFillTracker` with 5 resolved fills (all adverse) → returns 1.0
- Existing 89 tests minus deleted paper tests should still pass

**A6. Commit + push.**

One commit per fix-group (rip-out, BookCache, AdverseFillTracker, tests, ops). Push to `origin/main`. No PR — solo-operator repo.

### Phase B — Clean observer run (48h wall clock)

**B1. Config switch.**

`/etc/bert-xemm-bot/config.yaml`: `mode: observer` (currently `paper`). Everything else stays. Observer needs no API keys for orders; `KrakenObserver` uses the public WS book.

`sudo systemctl restart bert-xemm-bot` after the Phase A build is in place.

**B2. Smoke check at +5 minutes.**

Before walking away, verify the run is healthy:

```bash
# heartbeat fresh (< 30s old)
stat -c %Y /var/lib/bert-xemm-bot/heartbeat

# new basis_samples accumulating
sqlite3 /var/lib/bert-xemm-bot/state.db \
  "SELECT COUNT(*), MIN(t), MAX(t) FROM basis_samples WHERE t > datetime('now', '-5 minutes');"

# >95% of new samples have both sides populated (the bug-fix gate)
sqlite3 /var/lib/bert-xemm-bot/state.db \
  "SELECT SUM(CASE WHEN kraken_bid > 0 AND kraken_ask > 0 THEN 1 ELSE 0 END) * 100.0 / COUNT(*)
   FROM basis_samples WHERE t > datetime('now', '-5 minutes');"

# no kill events, no degraded flag
sqlite3 /var/lib/bert-xemm-bot/state.db "SELECT COUNT(*) FROM kill_events;"
sqlite3 /var/lib/bert-xemm-bot/state.db "SELECT * FROM flags WHERE k='degraded';"

# journal clean
journalctl -u bert-xemm-bot --since "5 minutes ago" -p err --no-pager
```

If `pct_valid < 95` → fix didn't take, stop. Don't start the 48h clock until this gate passes.

**B3. Hands-off period.**

48 hours from the moment the smoke check passes. No expected interventions. Operator-side pre-prep (Phase D) happens in parallel.

If any of these trip during the 48h, observer is broken again — stop the clock, diagnose, restart:

- Any new row in `kill_events`
- `flags.degraded = '1'`
- Heartbeat file age > 60s
- `basis_samples` count does not grow when checked at any daily check-in
- Service restarted by systemd (check `systemctl status` `Active: ... since` timestamp)

**B4. Daily check-in.**

Once per day during the 48h, re-run the B2 smoke check. Takes 30 seconds.

### Phase C — Data-driven go/no-go review (hour ~48)

**C1. Export.**

```bash
sqlite3 /var/lib/bert-xemm-bot/state.db -csv \
  "SELECT t, raydium_mid_usd, kraken_bid, kraken_ask, sol_usd
   FROM basis_samples
   WHERE t > datetime('now', '-48 hours') AND kraken_bid > 0 AND kraken_ask > 0;" \
  > /tmp/basis-48h.csv
```

Expected size: at 2.5s cadence × 48h = ~69K rows clean.

**C2. Distribution analysis.**

A short Node script (`scripts/basis-report.ts`, ~50 lines):

1. Histogram of basis in bps, bucketed `[0,10,20,...,300+]`
2. Crossings/day at 60bps, 100bps, 140bps thresholds
3. Asymmetry: how often Raydium > Kraken vs Raydium < Kraken
4. Time-of-day clustering by UTC hour
5. Current strategy bar: `bufferBps - (makerBps + dexCostBps + minEdgeBps)` — what each crossing must clear

Sample output shape:

```
=== BERT/USD basis report (48h, N=68,432 samples) ===

Histogram (bps):
  [0,10):    8,234 (12.0%) ▓▓▓▓▓▓▓▓▓
  [10,20):  12,891 (18.8%) ▓▓▓▓▓▓▓▓▓▓▓▓▓▓
  [20,40):  18,720 (27.4%) ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
  [40,60):  14,302 (20.9%) ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
  [60,100):  9,841 (14.4%) ▓▓▓▓▓▓▓▓▓▓▓
  [100,140): 3,892 (5.7%)  ▓▓▓▓▓
  [140+):      552 (0.8%)  ▓

Crossings/day:
  >60bps:  14,166 events  (7,083/day)
  >100bps:  4,444 events  (2,222/day)
  >140bps:    552 events  (276/day)

Asymmetry (raydium - kraken_mid):
  raydium HIGHER 53.1%   |   raydium LOWER 46.9%

Time-of-day (UTC, crossings >100bps):
  00-04: 187   04-08: 142   08-12: 312
  12-16: 1,891  16-20: 1,541  20-24: 371

Current strategy bar: bufferBps(80) - makerBps(25) - dexCostBps(50) - minEdgeBps(40) = -35bps
  → quotes would never clear the gate at current config
  → suggested retune: bufferBps≥140 OR fee-tier upgrade to drop makerBps
```

**C3. Decision matrix.**

| Outcome | Threshold | Action |
|---|---|---|
| **GO as-is** | ≥5/day crossings above 140bps | Phase E: deploy live with size from histogram |
| **GO with retune** | ≥5/day crossings above lower threshold AND `bufferBps - costs` can be tuned to clear that threshold | Edit `/etc/bert-xemm-bot/config.yaml` (`quoter.bufferBps`, `quoter.minEdgeBps`); restart; re-run B2 smoke check; then Phase E |
| **MAYBE** | 1–4/day above 140bps | Extend observer 48h → re-review. If still 1–4 after 96h total, kill |
| **KILL** | 0/day above 140bps AND max basis <100bps over 48h | Document findings, retire project, redirect capital |

The "GO with retune" branch is the operator-chosen data-driven framing: the histogram might show "180 crossings/day above 60bps but 0 above 140bps" — that's actionable signal to lower `minEdgeBps` and `bufferBps`, not a project-killer.

**C4. Review checkpoint.**

Operator and Claude sit together at hour 48, run the report, pick from the matrix. No code change without that explicit decision.

### Phase D — Operator pre-prep (parallel to Phase B)

Runs alongside the observer. Result: when Phase C says GO, live deployment is one config flip away.

**D1. Hot wallet keyfile.**

Create a fresh Solana keypair at `/etc/bert-xemm-bot/hot-wallet.json` (Solana `number[]` array format), permissions `0640 root:bertxemm` so the bot's group can read it.

```bash
solana-keygen new --no-bip39-passphrase --outfile /tmp/hot-wallet.json
sudo mv /tmp/hot-wallet.json /etc/bert-xemm-bot/hot-wallet.json
sudo chown root:bertxemm /etc/bert-xemm-bot/hot-wallet.json
sudo chmod 0640 /etc/bert-xemm-bot/hot-wallet.json
solana-keygen pubkey /etc/bert-xemm-bot/hot-wallet.json  # save the pubkey
```

Note: `DEPLOY.md` says `0600`, which denies the bertxemm group. That's wrong — fix in Phase A's doc edits.

**D2. Wallet funding (deferred until GO).**

Don't fund until the GO decision. A funded keyfile sitting unused is risk for no reward.

When GO:

- SOL for gas: ~0.1 SOL (~$15 at current SOL price)
- USDC: matched to launch size from C3

**D3. Kraken account verification.**

- Kraken funded with USD + BERT (split per launch size from C3)
- API key scopes: `Query Funds`, `Query Open Orders`, `Create & Modify Orders`, `Cancel & Close Orders`
- **Withdraw permission OFF** — verified in Kraken UI before adding key to `/etc/bert-xemm-bot/env`
- Write the key to `/etc/bert-xemm-bot/env` as `KRAKEN_API_KEY=...` / `KRAKEN_API_SECRET=...`, mode `0640 root:bertxemm`

**D4. Notifier webhooks.**

Current config has `notifier: {}` — bot pages no one. Before live, populate one:

- `notifier.telegram.botToken` (env: `TELEGRAM_BOT_TOKEN`) + `notifier.telegram.chatId`
- OR `notifier.discord.webhookUrl`

Verify with a manual test: bot startup notification should land in the channel.

**D5. Pre-live checklist.**

Before flipping `mode: live`, verify all of:

- [ ] Phase C decision: GO (with concrete size)
- [ ] Hot wallet keyfile in place, perms `0640 root:bertxemm`
- [ ] Hot wallet funded with appropriate SOL + USDC
- [ ] Kraken USD/BERT balances match launch size
- [ ] Kraken API key Withdraw scope = OFF (re-verified in UI)
- [ ] Notifier delivers a test message
- [ ] `pnpm test` green on HEAD
- [ ] Reconciler passes startup gate (no degraded flag after restart)
- [ ] Operator present at console for first 30 minutes

Any unchecked → don't flip.

**D6. Operator role split.**

Claude can: write the keyfile creation script, write a notifier test helper, draft the runbook.

Claude cannot: log in to Kraken, fund accounts, decide on hardware-wallet ergonomics. Those steps are flagged explicitly as operator handoffs in the runbook.

### Phase E — Live deployment (framework only, deferred)

This phase is intentionally **a framework, not a plan**. The numbers come from C3's histogram and D's funded balances.

**E1. Launch size — function of observer data.**

| Observed | Launch size |
|---|---|
| ≥10/day crossings above current gate | $500 |
| 5–9/day crossings above current gate | $250 |
| GO-with-retune (lower gate) | $100 (more uncertainty → smaller test) |
| Asymmetric (only one side ever crosses) | Half of above |

Hard ceiling: **$500 for the first live session**, regardless of how good observer looks. First live session is fundamentally about validating the state machine end-to-end with real fills, not about earning. Earning starts after we've seen ≥3 real fill → hedge → confirm cycles without intervention.

**E2. First live session protocol.**

Operator at console. Single session, time-boxed to ~2 hours. Watch:

- First quote placed → confirm in Kraken UI it exists with right side/price/volume
- Wait for first fill — could be minutes or hours
- On first fill: pause the bot, manually inspect hedge state in DB, confirm Jupiter quote was sane, confirm Raydium swap landed, confirm net delta returned to zero
- If clean: resume, watch ~3-5 more cycles
- After 30 min of clean cycles: stop watching every tick, set `journalctl -f` and an alert

If first fill → hedge cycle breaks: emergency-exit immediately, post-mortem before next attempt. Don't try to fix live.

**E3. Ramp gates.**

After first session ends cleanly:

| Sessions of clean operation | Capital |
|---|---|
| 1 (first live) | $250–$500 per E1 |
| 2–3 | hold the same; gather PnL data |
| 4+ if PnL > 0 net of fees | $1K |
| 7+ if PnL > 0 | $2K |
| 14+ if Sharpe > 1 | up to $5K (spec ceiling) |

Days, not hours, between ramp steps. Each step needs evidence the previous worked.

**E4. Kill gates during live.**

Existing watchdog (8 conditions) is the automatic kill switch. Operator-defined additional triggers requiring manual pause + post-mortem:

- Cumulative drawdown > 5% of current allocation
- Any single fill loses > 1% of allocation
- 3+ consecutive `failed_dead_letter` hedges
- Unexpected `degraded=1` outside a clean restart

Operator runs `pnpm cli pause` on any of these. Never auto-resume — only operator clears.

**E5. Successor decisions.**

- **Project succeeds**: stays at $5K ceiling indefinitely; framework is reusable for future XEMM strategies on other pairs (BERT/Kraken is the v1 trial, not the destination)
- **Project fails** (consistently negative PnL after 14 days at $1K+): document findings → retire bot → preserve the framework code → operator considers KuCoin/Drift hedge venues as v2 (KuCoin has 280× BERT depth per project memory)

## Risks

| Risk | Mitigation |
|---|---|
| BookCache fix is wrong / there's another empty-side path | B2 smoke check gates on >95% valid samples; if it fails, fix doesn't take and we stop |
| 48h is a misleading window (e.g., weekend quiet) | C3 includes time-of-day clustering; if window looks atypical, extend per the MAYBE row |
| Live launch fails on first fill due to a different unknown bug | E2 operator-present + emergency-exit ready; small launch size caps damage |
| Removing paper mode loses a debugging tool | Operator-confirmed acceptable; paper was never a P&L-realistic mode anyway |
| Strategy genuinely has no edge | C3 KILL outcome is explicit; retire the project rather than pretend |

## Open questions

None — all decisions resolved during brainstorming.

## Reference

- Project memory: `/root/.claude/projects/-opt/memory/project_bert_xemm_bot.md`
- Bot code: `/opt/bert-xemm-bot/src/`
- State DB: `/var/lib/bert-xemm-bot/state.db`
- Config: `/etc/bert-xemm-bot/config.yaml`
- Original design (predecessor location): `/opt/bert-mm-bot/docs/superpowers/specs/2026-05-20-bert-xemm-bot-design.md`
- Original implementation plan: `/opt/bert-mm-bot/docs/superpowers/plans/2026-05-20-bert-xemm-bot.md`
