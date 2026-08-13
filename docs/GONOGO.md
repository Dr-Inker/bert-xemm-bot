# S-tier campaign: go/no-go bar and pre-live constraints

Extracted 2026-08-13 from session graph `bert-xemm-bot-a583981d` (nodes `gonogo-001`, `prelive-notes-001` + full campaign state) when the session-graph practice was retired — see `/opt/docs/graph-engineering-vs-obsidian-2026-08-13.md`. This file is now the authority; the graph JSON at `/root/.codex/session-graphs/` is a frozen archive.

**Objective (2026-08-03):** turn observer-only CEX-DEX BERT MM into S-tier: break-even floor after friction, small profit ideal, market stimulus primary; $500–2000 capital; two-key gate before live.

## Go/no-go bar for live canary (was `gonogo-001`) — review due ~2026-08-17

ALL of the following before any live canary:

- ≥30 independent fills, ≥10 per side, over ≥14 days including at least one fast move
- Net > 0 under **stress** friction (25/40/20/.04), not just normal (23/20/10/.02)
- Modeled drawdown < $1.50
- Authenticated fee tier / min order / tick size verified against Kraken
- Serial multi-fill hedging batch fix landed
- Restricted-key no-withdraw rehearsal completed
- Two-key (cross-model) review + explicit user approval

**Carry caveat:** prefunded BERT beta (−12.8% over the sample = −$7.4 on 6k BERT) can dwarf spread PnL — evaluate net-of-beta.

**Evidence caveat (from CLAUDE.md, kept with the bar):** same-price refreshes never replenish queue-ahead — an optimistic fill-rate bias; treat a marginal GO skeptically.

## Pre-live constraints (was `prelive-notes-001`, status: pending — resolve or explicitly accept before live mode)

1. Public-RPC path returns the RPC-provided signature, not the derived canonical signature — prefer derived, or reject on mismatch.
2. `sendRawTransaction`/`getSignatureStatus` lack local timeouts — a hung status call can stall the executor past the 30 s deadline and later overwrite swept status.
3. The in-memory degraded latch is process-local — durable-write-failure + restart loses it (probe: sameProcess=1, afterRestart=0).
4. `cli resume` prints "resumed" but a latched running process stays stopped until restart — fix operator messaging.

Standing items: `hedges` table must be 0 rows pre-live (unsigned legacy notionals); authenticated fee tier/min order/tick verification; serial multi-fill hedging batch fix.

## Campaign record (2026-08-03, for context)

- **8d shadow audit:** paper net −6.92 (gross +1.82, friction 8.74); 41 fills from 18 trade ids, 9 negative; two fast-move clusters −8.88 = the whole sign. Trusted median edge 8d buy 114 / sell 48 bps (last 24 h 41/7). Kraken BERT/USD ~$1150/day, 25 trades. Oracle trusted 50%.
- **Verdict then:** NO-GO live; GO strategy-specific shadow v2. Candidate: ladder 1000@175/500@400/500@800 bps, minEdge 75 all-in, 1 s cadence, 3 s TTL, 150 bps oracle + 75 bps route gates, drift pulls 35 bps/5 s + 75 bps/30 s, cancel-all-on-fill, max 2000 BERT/side, $20 unhedged.
- **429 incident:** keyless lite-api per-IP throttling starved both lanes after a 25 s burst; candidate disabled 17:24, baseline recovered. Adopted **Option A**: keyed `api.jup.ag` (measured 10 QPS sustained; ~10.9M credits/mo < 25M allowance). Options B (15 s TTL) and C (cached route offset) rejected — they invalidate the adverse-selection evidence (Jul-29: 600 bps route move vs 21.5 bps cross-venue). Option D (local Raydium AMM math) viable but a redesign + fresh evidence clock.
- **Enablement:** keyed-jupiter merged `327f7d0` (review APPROVE after 1 blocker round), docs `c7cf5b3`, key in `/etc/bert-xemm-bot/secrets.env` (0640). Candidate lane ENABLED 2026-08-03T18:06:56Z; 2 h soak PASSED (0×429, p99 357 ms, max baseline gap 34 s) — **the 14-day evidence clock runs from 2026-08-03T18:06:56Z**. Fingerprints: econ `c20cbc4e`, ops `812b8453`.
