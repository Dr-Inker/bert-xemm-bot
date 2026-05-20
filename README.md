# bert-xemm-bot

CEX-DEX hedged market maker. Quotes BERT/USD on Kraken (via the Kraken CLI binary), hedges on Raydium AMM v4 via Jupiter.

Successor to bert-mm-bot. See docs/superpowers/specs/2026-05-20-bert-xemm-bot-design.md.

## Quick start

    pnpm install
    pnpm test
    pnpm build

## Phases

- Phase 1: Observer (no orders, 2 weeks, basis distribution data collection)
- Phase 2: Paper trade (`kraken --paper`, mock DEX, 2 weeks)
- Phase 3: Warm-up ($100 real, 1 week)
- Phase 4: Live ramp ($500 → $2K → $5K hard ceiling)

## Operator commands

| Command | Description |
|---|---|
| `pnpm cli status` | Print current state |
| `pnpm cli pause` | Set degraded=1 |
| `pnpm cli resume` | Clear degraded |
| `pnpm cli basis-snapshot --since 2026-05-20T00:00:00Z` | Export basis CSV |
| `pnpm cli report --since 2026-05-20T00:00:00Z` | Summary stats |
| `pnpm cli emergency-exit` | Cancel all + drain DEX BERT (does NOT withdraw from Kraken) |
| `pnpm tsx scripts/rehearsal.ts` | 60s dry-run, no orders |
| `pnpm tsx scripts/kraken-cancel-all.ts` | Operator cancel-all helper |

## Logs

JSON to stdout; under systemd, view with `journalctl -u bert-xemm-bot -f`.
Heartbeat file at `/var/lib/bert-xemm-bot/heartbeat`; `ops/heartbeat-check.sh` returns non-zero if stale.

## Kraken API key policy

- Permissions: `Query Funds`, `Query Open Orders`, `Create & Modify Orders`, `Cancel & Close Orders`
- **Withdraw permission MUST be OFF.**
- For automated withdrawals, mint a separate withdraw-only key with whitelist binding (operator decision; not wired in v1).

