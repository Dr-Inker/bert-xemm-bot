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
