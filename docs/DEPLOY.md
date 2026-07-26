# Deployment and operations

## Current deployment

The production service is intentionally `mode: observer`. It has no capital and cannot submit Kraken or Solana transactions.

```bash
systemctl status bert-xemm-bot.service
systemctl status bert-xemm-dashboard-export.timer
journalctl -u bert-xemm-bot -f
```

Public read-only dashboard: <https://drinkerlabs.info/bert-mm/>

## Prerequisites

- Node.js 22
- pnpm 9+
- Kraken CLI at `/usr/local/bin/kraken`
- `/etc/bert-xemm-bot/config.yaml`, mode `0640`, owner `root:bertxemm`
- writable state directory `/var/lib/bert-xemm-bot`

Observer mode uses public Kraken book/trade streams and public Solana/Jupiter data. It does not require Kraken API credentials or the hot-wallet keyfile. Those are live-only prerequisites and must not be added merely to run research.

## Build and install

```bash
cd /opt/bert-xemm-bot
pnpm install
pnpm test
pnpm lint
pnpm build
sudo ops/install.sh
sudo systemctl enable --now bert-xemm-bot.service
```

Install the sanitized dashboard exporter:

```bash
sudo install -m 0644 systemd/bert-xemm-dashboard-export.service /etc/systemd/system/
sudo install -m 0644 systemd/bert-xemm-dashboard-export.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now bert-xemm-dashboard-export.timer
sudo systemctl start bert-xemm-dashboard-export.service
```

The static dashboard page is served from `/var/www/drinkerlabs/bert-mm/`. The exporter reads SQLite in read-only mode and atomically publishes sanitized JSON there once per minute.

## Post-deploy verification

```bash
pnpm test
pnpm lint
systemctl is-active bert-xemm-bot.service
systemctl is-active bert-xemm-dashboard-export.timer
pgrep -af 'kraken ws (book|trades) BERT/USD'
curl -fsS https://drinkerlabs.info/bert-mm/data.json
```

Expected observer processes are one public Kraken book stream and one public Kraken trades stream. There must be no authenticated executions stream.

Verify the database without mutating it:

```sql
SELECT status, COUNT(*) FROM paper_orders GROUP BY status;
SELECT COUNT(*) AS fills, COALESCE(SUM(CAST(net_pnl_usd AS REAL)), 0) AS net_pnl
FROM paper_fills;
```

Zero paper P&L before a qualifying public trade is correct. Do not manufacture test fills in the production database.

## Paper accounting assumptions

- Quotes are independent scenarios for 1k, 5k and 10k BERT on each side.
- Queue ahead is estimated from displayed L2 volume at or better than the simulated price.
- Only subsequent Kraken public trades can consume the queue and trigger a paper fill.
- Hedge economics are refreshed from Jupiter at simulated fill time.
- Net P&L deducts maker fee, fixed transaction cost, latency penalty and failed-hedge reserve.
- Stale/untrusted observations cancel outstanding paper quotes.

This is deliberately conservative but still a model. It cannot perfectly reconstruct Kraken queue priority from L2 data.

## Live promotion

There is no calendar-based automatic promotion. Moving from observer to live requires explicit operator approval after reviewing:

- actual public-trade-derived fill count and fill rate;
- P&L by direction and size;
- total friction attribution;
- maximum drawdown and adverse-selection behavior;
- hedge quote reliability and failure rate;
- sensitivity to stricter latency and failure reserves.

If approved later, use a separate restricted Kraken key with Withdraw disabled and a minimally funded Solana hot wallet. Begin at the exchange minimum, with a hard session cap and manual rollback.

## Rollback

Observer rollback is non-destructive:

```bash
sudo systemctl stop bert-xemm-bot.service
sudo systemctl stop bert-xemm-dashboard-export.timer
```

The SQLite database and static JSON remain available for analysis. Do not delete state during rollback.
