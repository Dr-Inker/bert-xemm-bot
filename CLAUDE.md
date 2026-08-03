# bert-xemm-bot — Project Instructions

CEX-DEX hedged market-maker research and gated execution system. Observer mode reads Kraken public book/trades and executable Solana routes; live mode can quote Kraken and hedge through Jupiter.

**Status as of 2026-08-03: deployed observer-only with $0 capital; real dispatch remains disabled. Two lanes now run side by side: (1) the original paper ledger (1k/5k/10k BERT executable economics on keyless lite-api, unchanged for series continuity) and (2) the "shadow v2" candidate lane — the two-key-approved candidate strategy (ladder 1000@175/500@400/500@800 bps off executable Jupiter reference, 75 bps min all-in edge, 3 s snapshot TTL, drift/route/book gates, allocation-once fill model, dual normal+stress friction) collecting go/no-go evidence on a keyed `api.jup.ag` endpoint (`JUPITER_API_KEY` via `/etc/bert-xemm-bot/secrets.env`, 10 QPS tier verified). The candidate lane self-latches off on provider 429s or baseline starvation. Sanitized telemetry publishes at `https://drinkerlabs.info/bert-mm/` (now including a `candidate` section filtered by economic fingerprint). Live-path hardening landed the same day: tx-signature (not bundle-id) tracking with no-resubmit-on-ambiguity, fail-closed watchdog with in-memory degraded latch (a tripped running bot needs a restart after `cli resume`), signed in-flight hedge delta, bounded external IO, stale-hedge sweeper, strict conservative fee parsing. Go/no-go bar and pre-live constraints live in session graph `bert-xemm-bot-a583981d` (nodes gonogo-001, prelive-notes-001); known evidence caveat: same-price refreshes never replenish queue-ahead, an optimistic fill-rate bias — treat marginal GO skeptically.**

**Companion to** `/opt/bert-mm-bot`, which remains the separate on-chain BERT/SOL liquidity manager. Do not describe XEMM as replacing the DEX bot.

## Layout

```
src/
├── main.ts                       # Orchestrator entry. Wires venues + three loops.
├── config.ts                     # zod-validated YAML schema (BotConfigSchema)
├── logger.ts                     # pino, service=bert-xemm-bot
├── stateStore.ts                 # SQLite WAL; live state + observer_samples + paper_orders + paper_fills
├── observerEconomics.ts          # size-specific executable two-way hedge economics
├── paperFillEngine.ts            # public-trade queue model + friction-attributed theoretical PnL
├── exportDashboard.ts            # read-only SQLite → sanitized atomic dashboard JSON
├── notifier.ts                   # Telegram + Discord webhook severity ladder
├── priceOracle.ts                # trustedMid(): median + max-min divergence trust gate
├── types.ts                      # Order/Fill/OrderUpdate/BookSnapshot/FeeTier + newClOrdId
├── jitoClient.ts                 # Jito Block Engine bundle submit
├── txSubmitter.ts                # submitProtected(): Jito-first with public-RPC fallback
├── utils/execFileNoThrow.ts      # SAFE subprocess wrapper. ALL Kraken calls route here.
├── utils/hotWallet.ts            # loadHotWallet(path) → Solana Keypair from JSON keyfile
├── venues/
│   ├── hedgeVenue.ts             # HedgeVenue interface + VenueError class
│   ├── krakenClient.ts           # Kraken CLI subprocess wrapper (mutations, amend, streams, queries)
│   ├── krakenObserver.ts         # Observer-mode CEX: public WS book only, no API keys, mutations are no-ops
│   ├── krakenPublicTrades.ts     # public trades stream used only by the local paper ledger
│   ├── krakenPair.ts             # toWsPair(): config pair → Kraken WS-style pair (BERTUSD → BERT/USD)
│   ├── krakenStream.ts           # spawn + readline NDJSON for ws streams
│   ├── krakenErrors.ts           # Map Kraken CLI error envelope → VenueError
│   ├── bookCache.ts              # In-memory top-of-book; subscribes to cex.watchBook(pair, depth)
│   ├── dexVenue.ts               # DexVenue interface + Asset/PoolMid/SwapQuote types
│   ├── raydiumAmmClient.ts       # On-chain reserve reads + Jupiter swap submission
│   └── jupiterApi.ts             # Jupiter Swap API /quote + /swap client (mints + decimals)
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
├── emergency-exit.ts             # Operator emergency unwind entrypoint
└── rehearsal.ts                  # 60s dry-run, no submission, uses hardcoded synthetic inputs

systemd/bert-xemm-bot.service     # Hardened observer/live service
systemd/bert-xemm-dashboard-export.{service,timer} # 1-minute sanitized static export
ops/heartbeat-check.sh            # Watchdog: heartbeat file age check
ops/logrotate.conf                # Daily rotate, 7-day retention, copytruncate
ops/install.sh                    # Idempotent installer (creates user, dirs, perms, copies units)

docs/
├── DEPLOY.md                     # Phase progression + Phase 1 go/no-go awk gate
└── superpowers/
    ├── specs/2026-05-23-fast-track-live-design.md   # current operating plan (see headline status)
    └── plans/2026-05-23-fast-track-live.md          # 8-task TDD implementation plan
```

## Quick start

```bash
pnpm install
pnpm test         # 104 passing as of 2026-07-26
pnpm lint
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
- **Observer dispatch boundary**: `QuoterLoop.executeIntents=false`; never call venue mutations and never persist synthetic live orders. Live reconciliation/fill/watchdog loops do not start in observer mode.
- **Paper fill truth**: a book touch is not a fill. Only subsequent Kraken public traded volume that reaches the paper price and consumes estimated queue-ahead volume may create `paper_fills`.
- **Paper friction**: theoretical net PnL deducts the actual public maker tier, executable DEX route, fixed transaction cost, configured latency penalty and failed-hedge reserve.
- **Dashboard boundary**: exporter opens SQLite read-only and publishes sanitized static JSON. Never expose SQLite, secrets, wallet paths, RPC credentials or trading controls to the website.

## Phase progression

The broken Kraken CLI paper mode remains removed. It has been replaced by a local, public-data-derived conservative paper ledger; it never invokes broker paper endpoints or venue mutations.

1. **Observer + local paper ledger** — no keys, wallet, orders or capital. Collect executable edges and actual-trade-derived simulated fills across quiet and volatile regimes.
2. **Go/no-go review** — require enough fills to evaluate net PnL, drawdown, direction/size stability and friction sensitivity. Snapshot edge alone is insufficient.
3. **Minimum-size live canary** — only after separate explicit approval, restricted credentials and a documented capital/session cap.
4. **Staged ramp** — gated on realised net PnL and operational reliability; never calendar-driven.

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
12. ~~Observer mode does NOT gate order placement~~ — **Closed and strengthened.** `QuoterLoop.executeIntents=false` prevents dispatch and synthetic order persistence; observer mode also skips live reconciliation, fill execution and watchdog mutations.
13. ~~Coverage gate fails~~ — **Closed.** Pure-logic modules at >95%, total 91.33% lines / 73% branches / 91% functions / 91% statements. Gate (85/70/85/85) passes.

**Minor (mostly cosmetic, may revisit pre-live):**
14. ~~`tests/integration/krakenPaperE2E.test.ts` is skipped~~ — **Closed (2026-05-23, commit `f8ef771`).** File deleted along with paper mode.
15. `condDailyPnl` signs are slippery — `pnlPct < dailyPnlPct` where `dailyPnlPct=-2` means "trip when pnl < -2". OK as is.
16. `NetDeltaTracker.snapshot` subtracts `inFlightHedgesBert` unconditionally — needs signed direction (currently uses absolute `bert_notional`). Conservative for inventory cap; tighten when sell-side hedging gets first real flow.
17. `feeTier` parser uses `cfg.kraken.pair` as key into `j.fees`; real Kraken `TradeVolume` may use a different code. Falls back to 0.16/0.26 silently.
18. ~~Hot-wallet keyfile loading not wired into `wireVenues`~~ — **Closed (2026-05-22).** `wire.ts::buildSigner` loads keyfile when `mode === 'live'`; pubkey passed to `SolanaRpcAdapter` + `RaydiumAmmClient`.

## Readiness assessment

- **Validation**: 104 tests pass; TypeScript lint/build are clean as of 2026-07-26.
- **Observer + paper ledger**: deployed and active. No API keys or hot wallet are loaded. Public book/trade streams, executable route sampling, trust gating and dashboard export are operational.
- **Live warm-up**: implementation exists but is not approved. Do not fund or install credentials until the paper ledger has a representative fill history and an explicit operator go-live decision.

## Reference

- **Current operator docs**: `README.md` and `docs/DEPLOY.md`.
- **Historical operating spec**: `docs/superpowers/specs/2026-05-23-fast-track-live-design.md` — retained for provenance; its fast-track/paper-removed progression is superseded by the 2026-07-26 local paper ledger.
- **Historical implementation plan**: `docs/superpowers/plans/2026-05-23-fast-track-live.md`.
- **Original v1 design spec**: `/opt/bert-mm-bot/docs/superpowers/specs/2026-05-20-bert-xemm-bot-design.md` (still in predecessor repo).
- **Original v1 implementation plan**: `/opt/bert-mm-bot/docs/superpowers/plans/2026-05-20-bert-xemm-bot.md`.
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
- Don't go live until the local paper ledger has representative public-trade-derived fills, positive stressed net PnL, acceptable drawdown and explicit operator approval.
- Don't re-add Kraken CLI/broker paper mode. The allowed paper system is the local public-trade queue model in `paperFillEngine.ts`; preserve its no-touch-fill rule and explicit friction deductions.
