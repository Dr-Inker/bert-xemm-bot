# bert-xemm-bot

Read-only BERT cross-exchange market-making research and a gated live execution path. It observes BERT/USD on Kraken and executable BERT/SOL routes on Solana through Jupiter.

This project complements `/opt/bert-mm-bot`; it does not replace it:

- `bert-mm-bot` manages on-chain BERT/SOL liquidity.
- `bert-xemm-bot` measures and, only after explicit promotion, can quote Kraken and hedge on-chain.

## Current status — 2026-08-04

- Deployed in `observer` mode with no exchange credentials, wallet loading, orders, or capital.
- Two research lanes run side by side:
  - **Baseline** (since 2026-07-26): executable hedge economics at 1,000/5,000/10,000 BERT every 30 seconds on the keyless Jupiter endpoint, plus the conservative paper-fill ledger. Unchanged, for series continuity.
  - **Candidate "shadow v2"** (since 2026-08-03 18:06 UTC): the two-key-approved candidate strategy — ladder 1000 BERT @175 bps / 500 @400 / 500 @800 per side off fresh executable Jupiter references, 75 bps minimum all-in edge, 1 s decisions, 3 s snapshot TTL, drift/route/book gates, allocation-once fill model against real public trades, dual normal+stress friction accounting — collecting go/no-go evidence on a keyed `api.jup.ag` endpoint.
- The candidate lane passed its 2-hour soak (zero provider 429s, p99 snapshot construction 357 ms, max baseline sampling gap 34 s). The 14-day evidence window runs from 2026-08-03T18:06:56Z; go/no-go review due ~2026-08-17.
- The candidate lane self-latches off on provider throttling or baseline-sampler starvation and never queues catch-up bursts.
- Publishes sanitized, read-only telemetry every minute at <https://drinkerlabs.info/bert-mm/>, including a `candidate` section filtered by economic strategy fingerprint.

The observer, paper ledger, and candidate lane cannot place real orders. `live` mode exists in the codebase but is not approved for capital; promotion requires the documented go/no-go bar, restricted Kraken keys, and explicit two-key approval.

## What theoretical P&L means

A paper fill is counted only when subsequent public Kraken traded volume reaches the simulated price and consumes the displayed L2 volume estimated ahead of the quote. A book touch by itself is not a fill.

At a qualifying fill, the engine requests a fresh executable Jupiter hedge and calculates:

```text
gross cross-venue P&L
− Kraken maker fee
− configured Solana transaction cost
− latency/adverse-move penalty
− failed-hedge reserve
= conservative theoretical net P&L
```

Defaults are a 20 bps latency penalty, 10 bps failed-hedge reserve, and $0.02 transaction cost. These scenarios are independent research tracks by size and direction; their notional must not be interpreted as simultaneously deployed capital.

## Safety invariants

- Observer mode never dispatches quote intents or inserts synthetic live orders.
- Observer mode does not load the hot wallet or Kraken API credentials.
- Live reconciliation, fill execution, and kill-switch mutations run only in live mode.
- Stale, incomplete, or cross-venue-divergent data cancels paper quotes.
- Public dashboard output is sanitized static JSON; the website has no database, wallet, or control access.
- No automatic withdrawals. Any future Kraken trading key must have Withdraw permission disabled.

## Quick start

```bash
pnpm install
pnpm test
pnpm lint
pnpm build
```

## Configuration

The installed config is `/etc/bert-xemm-bot/config.yaml`. Important observer defaults:

```yaml
mode: observer
enabled: true

observer:
  sizesBert: [1000, 5000, 10000]
  maxBookAgeSec: 15
  sampleCadenceMs: 30000

paper:
  enabled: true
  minNetEdgeBps: 40
  latencyPenaltyBps: 20
  failedHedgeReserveBps: 10
  transactionCostUsd: 0.02

candidate:
  enabled: false   # production /etc config sets true; requires JUPITER_API_KEY (see docs/DEPLOY.md)
  jupiterBaseUrl: https://api.jup.ag/swap/v1
  apiKeyEnv: JUPITER_API_KEY
  maxQuoteCallsPerSec: 6
  baselineWatchdogMs: 45000
```

The baseline retains its configured public Jupiter URL. The candidate lane is
disabled by default and refuses to start unless its configured API-key
environment variable is non-empty; candidate credentials are never exported.

## Data

SQLite state: `/var/lib/bert-xemm-bot/state.db`

Key tables:

- `observer_samples`: executable two-way prices, impact, fee, book age, trust and edge by size.
- `paper_orders`: simulated price, queue ahead, lifecycle and cancellation reason.
- `paper_fills`: fill/hedge prices plus gross P&L and each friction deduction.
- `candidate_quote_attempts`: keyed-provider status, construction time, 429s,
  capacity skips, baseline sample age, and strategy fingerprint.
- `basis_samples`: legacy/reference top-of-book basis observations.

Dashboard export:

- JSON: `/var/www/drinkerlabs/bert-mm/data.json`
- Exporter: `bert-xemm-dashboard-export.service`
- Timer: `bert-xemm-dashboard-export.timer`

## Operator commands

| Command | Description |
|---|---|
| `pnpm cli status` | Print current state |
| `pnpm cli pause` | Set `degraded=1` for live dispatch |
| `pnpm cli resume` | Clear degraded state |
| `pnpm cli basis-snapshot --since <ISO>` | Export legacy basis CSV |
| `pnpm cli report --since <ISO>` | Print summary stats |
| `pnpm cli emergency-exit` | Live-only cancel and DEX drain; never withdraws from Kraken |

Logs:

```bash
journalctl -u bert-xemm-bot -f
systemctl status bert-xemm-dashboard-export.timer
```

## Promotion gates

1. Collect a representative observer window, including quiet and volatile periods.
2. Require enough actual public-trade-derived paper fills to estimate fill rate and direction-specific P&L.
3. Require positive net paper P&L after all configured friction, acceptable drawdown, and stable hedge routes.
4. Review queue-model bias and stress penalties.
5. Only then consider a separately approved minimum-size live canary.

Snapshot edge alone is never a go-live signal.
