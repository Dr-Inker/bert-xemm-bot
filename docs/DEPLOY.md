# Deploy

## Prerequisites

- Node 22 (`nvm use`)
- pnpm 9+
- `kraken` binary on PATH (`/usr/local/bin/kraken`). Install per https://github.com/krakenfx/kraken-cli
- A Solana hot wallet keyfile (JSON `number[]`) at the path configured in `config.yaml`
- Kraken API key + secret with restricted scope (see README)
- `/etc/bert-xemm-bot/config.yaml` (mode 0640, owner `root:bertxemm`)
- `/etc/bert-xemm-bot/env` containing `KRAKEN_API_KEY=...`, `KRAKEN_API_SECRET=...`, `TELEGRAM_BOT_TOKEN=...` (mode 0640)

## Install

```bash
cd /opt/bert-xemm-bot
pnpm install
pnpm build
sudo ops/install.sh
sudo systemctl enable --now bert-xemm-bot
sudo journalctl -u bert-xemm-bot -f
```

## Phase progression

1. **Observer (week 1-2):** `config.yaml` sets `mode: observer`, `enabled: true`. No orders placed; only basis sampled.
2. **Paper (week 2-4):** `mode: paper`, `enabled: true`. Run `kraken paper init --balance 10000` once on the host. Bot uses `KrakenPaper`.
3. **Warm-up (week 5):** `mode: live`, `enabled: true`, $100 capital. Manual gate per session.
4. **Live (week 6+):** `mode: live`, ramp $500 → $2K → $5K with kill switches enabled.

## 7-day fast track (compressed)

Use this instead of the default 5-week cadence when you need live-ready within one week.

| Day | Mode | Action |
|-----|------|--------|
| 1 (today) | `observer` | Deploy systemd service. Confirm heartbeat + `basis_samples` rows accumulating. No Kraken API keys required (`KrakenObserver` uses public WS book). |
| 2-3 | `observer` | Let basis data accumulate. Run hourly sanity: `pnpm cli status`, check journal for errors. |
| 4 | `paper` | `kraken paper init --balance 10000`. Flip `mode: paper`, restart. Confirm paper orders + mock DEX hedges (`PAPER-*` sigs). |
| 5 | `paper` | Validate fill→hedge loop, kill-switch dry-run (`pnpm cli pause` / `resume`). |
| 6 | go/no-go | Run basis gate (relaxed: ≥3 crossings/day above 140 bps over last 3 days, not 14). If fail → stop. |
| 7 | `live` warm-up | Wire hot wallet + Kraken API keys (Withdraw OFF). `mode: live`, $100 cap, manual operator gate. |

**Relaxed go/no-go (3-day window):**

```bash
pnpm cli basis-snapshot --since "$(date -d '3 days ago' -Iseconds)Z" > /tmp/basis.csv
awk -F, 'NR>1 { diff = ($2 - ($3+$4)/2); if (diff < 0) diff = -diff; mid=($3+$4)/2; if (mid<=0) next; bps = diff/mid*10000; if (bps > 140) c++; total++ } END { printf "crossings >140bps: %d / %d (%.1f%%)\n", c+0, total+0, (total?c/total*100:0) }' /tmp/basis.csv
```

Need ≥3/day average over the 3-day window (not the spec's 5/day over 14 days).

## Phase 1 go/no-go gate

```bash
sudo -u bertxemm /opt/bert-xemm-bot/node_modules/.bin/tsx \
  /opt/bert-xemm-bot/src/cli/index.ts basis-snapshot --since "$(date -d '14 days ago' -Iseconds)Z" \
  > /tmp/basis.csv
awk -F, 'NR>1 { diff = ($2 - ($3+$4)/2); if (diff < 0) diff = -diff; bps = diff/(($3+$4)/2)*10000; if (bps > 140) c++; total++ } END { print "crossings >140bps:", c, "/", total, "(", (c/total)*100, "% )" }' /tmp/basis.csv
```

If <5 crossings/day above 140 bps → strategy dies. Stop here.
