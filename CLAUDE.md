# bert-xemm-bot — Project Instructions

CEX-DEX hedged market maker. Quotes BERT/USD post-only on Kraken (via the `kraken` binary subprocess); hedges fills on Raydium AMM v4 via Jupiter v6 with Jito bundles.

**Status as of 2026-05-20: Phase 0 — scaffold complete, integration unfinished.** Builds, lints, 59 unit tests pass. Security baseline solid. But the bot is NOT yet runnable end-to-end — `main.ts` stubs out several load-bearing dependencies (RPC adapter, watchdog evaluator, in-flight hedge tracking, heartbeat writer). See "Known gaps" below before attempting to deploy.

**Successor to** the retired bert-mm-bot at `/opt/bert-mm-bot` (Meteora DLMM MM, retired 2026-05-20 after the pool died).

## Layout

```
src/
├── main.ts                       # Orchestrator entry. Wires venues + three loops.
├── config.ts                     # zod-validated YAML schema (BotConfigSchema)
├── logger.ts                     # pino, service=bert-xemm-bot
├── stateStore.ts                 # better-sqlite3 WAL; orders/fills/hedges/basis_samples/kill_events/flags
├── notifier.ts                   # Telegram + Discord webhook severity ladder
├── priceOracle.ts                # trustedMid(): median + max-min divergence trust gate
├── types.ts                      # Order/Fill/OrderUpdate/BookSnapshot/FeeTier + newClOrdId
├── jitoClient.ts                 # Jito Block Engine bundle submit
├── txSubmitter.ts                # submitProtected(): Jito-first with public-RPC fallback
├── utils/execFileNoThrow.ts      # SAFE subprocess wrapper. ALL Kraken calls route here.
├── venues/
│   ├── hedgeVenue.ts             # HedgeVenue interface + VenueError class
│   ├── krakenClient.ts           # Kraken CLI subprocess wrapper (mutations, amend, streams, queries)
│   ├── krakenPaper.ts            # Same surface, --paper flag, flat 0/26bps fee tier
│   ├── krakenStream.ts           # spawn + readline NDJSON for ws streams
│   ├── krakenErrors.ts           # Map Kraken CLI error envelope → VenueError
│   ├── dexVenue.ts               # DexVenue interface + Asset/PoolMid/SwapQuote types
│   ├── raydiumAmmClient.ts       # On-chain reserve reads + Jupiter swap submission
│   └── jupiterApi.ts             # Jupiter v6 /quote + /swap HTTP client (mints + decimals)
├── strategy/
│   ├── xemmQuoter.ts             # decideQuotes(input) → QuoteIntent[]. Pure decision function.
│   ├── netDeltaTracker.ts        # Cross-venue BERT inventory aggregator (signed delta)
│   └── hedgeExecutor.ts          # onFill state machine: intent_queued → swap_quoted → tx_submitted
├── risk/
│   ├── conditions.ts             # 8 pure kill-condition functions + KillResult/KillAction types
│   ├── killSwitchWatchdog.ts     # tick(): evaluate conditions → cancelAll + degraded + page
│   ├── reconciler.ts             # Fail-closed startup gate: venue↔DB open-orders diff
│   └── emergencyUnwind.ts        # runEmergencyUnwind(): cancel + DEX drain + page (NO auto-withdraw)
├── orchestrator/
│   ├── quoterLoop.ts             # Tick: read inputs → decideQuotes → dispatch via HedgeVenue
│   ├── fillLoop.ts               # Iterate cex.watchExecutions() → HedgeExecutor.onFill
│   └── watchdogLoop.ts           # setInterval(watchdog.tick) at cadenceMs
└── cli/
    ├── index.ts                  # commander shell
    ├── status.ts pause.ts resume.ts basisSnapshot.ts report.ts emergencyExit.ts

scripts/
├── kraken-cancel-all.ts          # Operator helper: KrakenClient.cancelAll()
├── emergency-exit.ts             # Currently a stub — venue wiring not duplicated from main.ts (gap)
└── rehearsal.ts                  # 60s dry-run, no submission, uses hardcoded synthetic inputs

systemd/bert-xemm-bot.service     # Hardened systemd unit (bertxemm user, NoNewPrivileges, ProtectSystem=strict)
ops/heartbeat-check.sh            # Watchdog: heartbeat file age check
ops/logrotate.conf                # Daily rotate, 7-day retention, copytruncate
ops/install.sh                    # Idempotent installer (creates user, dirs, perms, copies units)

docs/
├── DEPLOY.md                     # Phase progression + Phase 1 go/no-go awk gate
└── (spec + plan still live in /opt/bert-mm-bot/docs/superpowers/ until repo migrates)
```

## Quick start

```bash
pnpm install
pnpm test         # 59 passing (1 integration smoke skipped if `kraken` not on PATH)
pnpm build
pnpm cli status   # default config: /etc/bert-xemm-bot/config.yaml
```

## Key invariants

- **Subprocess pattern**: every Kraken binary call MUST go through `src/utils/execFileNoThrow.ts` with `strictArgs: true`. The wrapper uses `execFile` (no shell interpolation). Argv must be a string array, never a single string. WS streams use `spawn`. The repo's pre-commit hook will reject violations.
- **Kraken API key permissions**: `Query Funds`, `Query Open Orders`, `Create & Modify Orders`, `Cancel & Close Orders`. **Withdraw permission MUST be OFF.** Emergency-exit pages the operator for manual USD withdrawal; never withdraws automatically.
- **Inventory truth = NetDeltaTracker.snapshot()** = `kraken.base + dex.bert − inFlightHedgesBert`. In-flight hedges count as already-settled (conservative; prevents double-hedging).
- **Profitability gate** in `decideQuotes`: must clear `bufferBps − (makerBps + dexCostBps) ≥ minEdgeBps`. Original spec had a bug here that ignored fees; was corrected in commit `8c6c5c3`. Don't revert.
- **Fail-closed reconciliation**: `Reconciler.run()` must return true before the orchestrator starts. Any venue/DB drift sets `degraded=1` and pages.
- **Degraded flag**: stored in `flags` table (`flags.degraded='1'`). Quoter checks every tick and falls silent. Watchdog never auto-clears — operator runs `pnpm cli resume`.

## Phase progression

1. **Observer (2 weeks)** — `mode: observer`. No orders. Logs basis distribution. **Phase 1 go/no-go gate**: `pnpm cli basis-snapshot --since <14 days ago>` + awk command in `docs/DEPLOY.md`. Need ≥5 crossings/day above ~140 bps for the strategy to be worth deploying.
2. **Paper (2 weeks)** — `mode: paper`. CEX side uses `KrakenPaper` (`kraken --paper` subprocess). DEX side currently uses the same real Jupiter client — needs a MockDexVenue for true paper mode (Phase 1.5 work).
3. **Warm-up ($100, 1 week)** — `mode: live`. Manual operator gate per session.
4. **Staged ramp** — $500 → $2K → $5K (hard ceiling for Kraken venue).

## Known gaps (audit 2026-05-20)

The 29-task plan completed all listed deliverables, but `main.ts` wires several load-bearing dependencies with stubs. Honest readiness:

**Critical (block live deployment):**
1. `main.ts` passes `evaluate: async () => []` to `KillSwitchWatchdog` — **none of the 8 kill conditions are actually evaluated.** Conditions are pure functions in `src/risk/conditions.ts` and fully unit-tested, but the `evaluate` wiring that feeds them real inputs (24h volumes, RPC call rate, adverse-fill rate, etc.) is empty.
2. `HedgeExecutor.onFill` for sell-side fills computes `amountIn = fill.volume.mul(fill.price)` — that's USD, not SOL. Needs `.div(solUsd)` to convert. Buy-side path is correct; sell-side never tested.
3. Slippage gate in `HedgeExecutor` compares `quote.slippageBps` which is the **tolerance we sent to Jupiter**, not the realized impact. Use `priceImpactPct` from the Jupiter `QuoteResp` instead.
4. `scripts/emergency-exit.ts` and `cli emergency-exit` both `process.exit(2)` with "venue wiring not implemented." Spec section 7.2 needs this functional before live trading.
5. `main.ts` RpcAdapter returns dummy zeros (`uiAmount: '0'`, `getPoolState` returns fake vault addresses, `fetchSolUsd` is hardcoded `'86.12'`). Real `@solana/web3.js` Connection-backed adapter is unwritten.
6. Heartbeat file at `/var/lib/bert-xemm-bot/heartbeat` is never written. systemd unit and ops/heartbeat-check.sh reference it; nothing in code touches it. Add a `setInterval(fs.writeFile, ...)` in `main.ts`.

**Important (Phase 2 ready):**
7. `HedgeExecutor` stops at `tx_submitted` — no confirmation polling, no retry, no dead-letter. Spec section 5.5 requires ≤30s poll then ≤3 retries.
8. Reconciler reads `listOpenOrders: async () => []` from `main.ts` — DB side always empty, so drift detection is no-op.
9. NetDeltaTracker fed `inFlightHedgesBert: new Decimal('0')` always — no actual in-flight tracking.
10. Kraken book passed to quoter as `{ bids: [], asks: [] }`. `basis_samples` will record `kraken_bid=0, kraken_ask=0` — the Phase 1 go/no-go gate is comparing against zero.
11. `condRpcBurn` has only halt threshold; spec section 5.6 says throttle at >60/min, halt at >120/min.
12. Observer mode does NOT gate order placement — `placeLimit` runs in all modes. Add `if (cfg.mode !== 'live') return;` guard.
13. Coverage gate fails: 67.97% lines vs 85% target. Concentrated in `jitoClient.ts`, `notifier.ts`, `killSwitchWatchdog.ts`, `cli/{status,report,emergencyExit}.ts`. Either add integration smokes or lower thresholds to ~68/70 for v0.1.

**Minor:**
14. `tests/integration/krakenPaperE2E.test.ts` is skipped (no `kraken` binary on this host).
15. `condDailyPnl` correct but signs are slippery — `pnlPct < dailyPnlPct` where `dailyPnlPct=-2` means "trip when pnl < -2". OK as is.
16. `NetDeltaTracker.snapshot` subtracts `inFlightHedgesBert` unconditionally — needs signed direction once in-flight tracking is added.
17. `feeTier` parser uses `cfg.kraken.pair` as key into `j.fees`; real Kraken `TradeVolume` may use a different code. Falls back to 0.16/0.26 silently.

## Estimated time to honest Phase 1

3-5 focused days: real RpcAdapter (Solana web3 Connection + Jupiter `/price`), real watchdog evaluator (24h volume aggregation + RPC rate counter), observer-mode `placeLimit` gate, heartbeat ticker, emergency-exit wiring extraction, hedge sell-side unit fix + slippage field swap. Then the basis-snapshot CSV is real and the go/no-go gate is honest.

## Reference

- **Design spec**: `/opt/bert-mm-bot/docs/superpowers/specs/2026-05-20-bert-xemm-bot-design.md` (still in predecessor repo; migrate to `docs/` here when the spec moves)
- **Implementation plan**: `/opt/bert-mm-bot/docs/superpowers/plans/2026-05-20-bert-xemm-bot.md`
- **Predecessor scaffolding (read-only reference)**: `/opt/bert-mm-bot/src/` — for porting questions about notifier/stateStore/jitoClient patterns.
- **Live BERT venues** (verified 2026-05-20):
  - Raydium AMM v4 (BERT/SOL): `BmsZE6TkZYskyS1PatPKRyyazGdxWFxdia4BuvLg9AgY` — $1.04M TVL, $168K/24h
  - Kraken (BERT/USD): pair code `BERTUSD`, $68K/24h vol, 56.7 bps spread, ordermin 380 BERT
  - BERT mint (same everywhere including Kraken): `HgBRWfYxEfvPhtqkaeymCQtHCrKE46qQ43pKe8HCpump`
- **The retired Meteora DLMM pool** the predecessor MM'd: `4rkbxnvmXagghqoV59jGZRcRUu94HHHq7axvFz8ERGMh` — sub-$50 TVL, dead.

## Don't do

- Don't add shell-interpolating subprocess calls. Route everything through `execFileNoThrow`.
- Don't enable Kraken Withdraw permission on the bot's API key. Operator runs withdrawals manually or via a separate whitelist-bound key.
- Don't run `pnpm test:coverage` and trust the "verified" claim in the v0.1 commit — it currently fails (see gap #13).
- Don't revert the profitability gate fix in `8c6c5c3` — the gate must subtract round-trip costs from buffer, not compare buffer raw against minEdgeBps.
- Don't deploy beyond Phase 0 until the 6 critical gaps above are closed.
