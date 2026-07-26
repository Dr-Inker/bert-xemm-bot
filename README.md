# bert-xemm-bot

Read-only BERT cross-exchange market-making research and a gated live execution path. It observes BERT/USD on Kraken and executable BERT/SOL routes on Solana through Jupiter.

This project complements `/opt/bert-mm-bot`; it does not replace it:

- `bert-mm-bot` manages on-chain BERT/SOL liquidity.
- `bert-xemm-bot` measures and, only after explicit promotion, can quote Kraken and hedge on-chain.

## Current status — 2026-07-26

- Deployed in `observer` mode with no exchange credentials, wallet loading, orders, or capital.
- Samples executable hedge economics at 1,000, 5,000, and 10,000 BERT every 30 seconds.
- Uses Kraken's public entry fee schedule (currently 23 bps maker) and Jupiter executable quotes.
- Runs a conservative local paper-fill ledger from Kraken public trades and estimated queue-ahead volume.
- Publishes sanitized, read-only telemetry every minute at <https://drinkerlabs.info/bert-mm/>.

The observer and paper ledger cannot place real orders. `live` mode exists in the codebase but is not approved for capital.

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
```

Jupiter's public base URL is `https://lite-api.jup.ag/swap/v1`.

## Data

SQLite state: `/var/lib/bert-xemm-bot/state.db`

Key tables:

- `observer_samples`: executable two-way prices, impact, fee, book age, trust and edge by size.
- `paper_orders`: simulated price, queue ahead, lifecycle and cancellation reason.
- `paper_fills`: fill/hedge prices plus gross P&L and each friction deduction.
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
