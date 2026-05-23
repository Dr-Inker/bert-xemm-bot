# bert-xemm-bot — Project Instructions

CEX-DEX hedged market maker. Quotes BERT/USD post-only on Kraken (via the `kraken` binary subprocess); hedges fills on Raydium AMM v4 via Jupiter v6 with Jito bundles.

**Status as of 2026-05-22: Phase 1 ready — observer deployable; Phase 2 paper unblocked.** Builds, lints, 94 unit tests pass, coverage gate passes. All 13 critical+important audit gaps closed. v1.5 MockDexVenue wired for paper mode (`submitSwap` → `PAPER-*`, instant confirm). Hot-wallet keyfile loading wired for live mode (`wire.ts` reads `paths.keyfile` when `mode: live`). Remaining: condRpcBurn throttle tier (v1.2, deferred), Phase 1 observer deployment on host (no `/etc/bert-xemm-bot/config.yaml` yet).

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
│   ├── mockDexVenue.ts           # Paper mode: real quotes, mock submitSwap (PAPER-* sigs)
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
pnpm test         # 89 passing (1 integration smoke skipped if `kraken` not on PATH)
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
2. **Paper (2 weeks)** — `mode: paper`. CEX side uses `KrakenPaper` (`kraken --paper` subprocess). DEX side uses `MockDexVenue` (real Jupiter quotes, mock `submitSwap`).
3. **Warm-up ($100, 1 week)** — `mode: live`. Manual operator gate per session.
4. **Staged ramp** — $500 → $2K → $5K (hard ceiling for Kraken venue).

## Known gaps (audit 2026-05-20, integration passes 2026-05-21)

Original audit found 6 critical + 7 important gaps. After three integration passes (commits `12232ed`, `0ac3097`, `c02051b`, `1880e8c`, `427dfd8`, `8dd62fc`, `19131a7`, `3af8d50`, `c2d1c9d`), **all 13 critical+important gaps are closed**. Status:

**Critical (originally blocked live deployment):**
1. ~~`main.ts` passes `evaluate: async () => []` to `KillSwitchWatchdog`~~ — **Fully closed (2026-05-21).** All **8 of 8 conditions** now wired in the `evaluateConditions` lambda: `condNetDelta`, `condKraken24hMin` (Kraken `/Ticker` cached 5min), `condSolUsd1hMove` (in-memory ring buffer), `condStaleData`, `condRpcBurn` (`RpcCounter` rolling 60s window in `src/utils/rpcCounter.ts`, incremented by `SolanaRpcAdapter` on every Connection call), `condRaydium24hMin` (`Raydium24hVol` DexScreener cached), `condDailyPnl` (`PnlTracker` — realized cashflow over 24h + unrealized MTM vs UTC-midnight day-start), `condAdverseFill` (`AdverseFillTracker` — 5min post-fill mid snapshot, directional adverse-move detection over last 20 fills). Kill events persisted via `StateStore.insertKillEvent`.
2. ~~`HedgeExecutor.onFill` sell-side units bug~~ — **Closed in `0ac3097`** (sell-side `amountIn = fill.volume.mul(fill.price).div(solUsd)`).
3. ~~Slippage gate uses tolerance instead of impact~~ — **Closed in `0ac3097`** (uses `priceImpactPct` via `priceImpactBps` on `SwapQuote`).
4. ~~`scripts/emergency-exit.ts` and `cli emergency-exit` stubbed~~ — **Closed in `427dfd8`.** Both now call `runEmergencyUnwind` against real venues via `src/orchestrator/wire.ts::wireVenues`.
5. ~~`main.ts` RpcAdapter dummy zeros~~ — **Closed in `c02051b` + `427dfd8`.** `SolanaRpcAdapter` (DexScreener pool reads + web3 Connection wallet balances) and `JupiterSolRef` (Jupiter `/price` v4) wired through `wireVenues`. `hotWalletPubkey` undefined for observer/paper — wallet balances return `('0','0')`; Phase 3 reads the keyfile.
6. ~~Heartbeat file never written~~ — **Closed in `12232ed`** (5s `setInterval(writeFile, ...)` in `main.ts`).

**Important (originally Phase 2 ready):**
7. ~~`HedgeExecutor` stops at `tx_submitted`, no confirmation polling~~ — **Closed in `8dd62fc`.** Full state machine: `intent_queued → swap_quoted → tx_submitted → confirmed | failed_will_retry → (retry ≤3) → failed_dead_letter`. `txStatus` poll function injected at constructor; `main.ts` wires `connection.getSignatureStatus` with 2s poll / 30s timeout / 3 retries.
8. ~~Reconciler reads `listOpenOrders: async () => []`~~ — **Closed in `1880e8c` + `427dfd8`.** `main.ts` passes `() => store.listOpenOrders()`; method tested.
9. ~~NetDeltaTracker fed `inFlightHedgesBert: new Decimal('0')`~~ — **Closed in `8dd62fc` + `3af8d50`.** `StateStore.sumInFlightHedgesBert()` reads `bert_notional` across non-terminal hedge statuses; wired into both `QuoterLoop.readInputs` and `evaluateConditions`.
10. ~~Kraken book passed as `{ bids: [], asks: [] }`~~ — **Closed in `19131a7`.** `BookCache` subscribes to `cex.watchBook(pair, 10)` and exposes `snapshot()`. `basis_samples` now records real top-of-book bid/ask. Phase 1 go/no-go gate finally compares real numbers.
11. ~~`condRpcBurn` halt threshold only~~ — Throttle tier deferred (not implemented — code only halts at `rpcCallsPerMinHalt`). Operational concern for v1.2; conservative side.
12. ~~Observer mode does NOT gate order placement~~ — **Closed in `12232ed`** (`placeLimit` overridden to no-op when `mode === 'observer'`).
13. ~~Coverage gate fails~~ — **Closed.** Pure-logic modules at >95%, total 91.33% lines / 73% branches / 91% functions / 91% statements. Gate (85/70/85/85) passes.

**Minor (mostly cosmetic, may revisit pre-live):**
14. `tests/integration/krakenPaperE2E.test.ts` is skipped (no `kraken` binary on this host).
15. `condDailyPnl` signs are slippery — `pnlPct < dailyPnlPct` where `dailyPnlPct=-2` means "trip when pnl < -2". OK as is.
16. `NetDeltaTracker.snapshot` subtracts `inFlightHedgesBert` unconditionally — needs signed direction (currently uses absolute `bert_notional`). Conservative for inventory cap; tighten when sell-side hedging gets first real flow.
17. `feeTier` parser uses `cfg.kraken.pair` as key into `j.fees`; real Kraken `TradeVolume` may use a different code. Falls back to 0.16/0.26 silently.
18. ~~Hot-wallet keyfile loading not wired into `wireVenues`~~ — **Closed (2026-05-22).** `wire.ts::buildSigner` loads keyfile when `mode === 'live'`; pubkey passed to `SolanaRpcAdapter` + `RaydiumAmmClient`.

## Readiness assessment

- **Phase 0 plumbing demo**: works today (87+ tests pass, build clean, coverage 91%).
- **Phase 1 observer**: should work end-to-end. `basis_samples` will record real Kraken book + real Raydium mid via DexScreener. The 14-day go/no-go awk gate is honest. Acceptable to run on a paid Solana RPC tier (DexScreener calls are free; Jupiter `/price` calls are free; `SolanaRpcAdapter` only hits Connection for wallet reads which require a configured `hotWalletPubkey` — for observer mode no wallet is needed).
- **Phase 2 paper**: ready. `MockDexVenue` short-circuits DEX submission; `main.ts` treats `PAPER-*` sigs as instantly confirmed. Requires `kraken` binary + `kraken paper init`.
- **Phase 3 warm-up ($100 live)**: hot-wallet keyfile loading is wired. Operator must place keyfile at `paths.keyfile` (mode 0600) and verify Kraken API key permissions (Withdraw OFF).

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
- Don't revert the profitability gate fix in `8c6c5c3` — the gate must subtract round-trip costs from buffer, not compare buffer raw against minEdgeBps.
- Don't deploy beyond Phase 0 until the remaining v1.1 work above is closed (4 deferred watchdog conditions, confirmation polling, in-flight tracking, Kraken book wiring).
