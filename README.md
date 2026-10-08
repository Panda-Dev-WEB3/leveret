# Leveret ($LVRT) — on-chain skeleton

Every way to trade a price, on one Solana margin account. This repo is the
first build pass of the two specs (`Leveret Overview.pdf`,
`Leveret Backend.pdf`): **all 10 Anchor programs**, with shared math and the
core trading path implemented and tested, and the remaining surface stubbed
behind explicit `TODO(<program>)` markers that return `NotImplemented`.

Toolchain: Anchor **1.1.2** (CLI and `anchor-lang` pinned `=1.1.2`), Agave
3.1.10, Rust 1.89 for programs (`rust-toolchain.toml`), platform-tools v1.52,
LiteSVM 0.10 for tests.

## Layout

```
crates/
  lvrt_math/      pure fixed-point math (no Solana deps): oracle aggregation,
                  fill price + skew premium, velocity funding, borrow, margin,
                  liquidation sizing, anti-staleness, circuit breaker, splits,
                  dividends, power/normFactor, tickets, factor index, vault NAV,
                  fee split, risk classes, sharding
  lvrt_common/    shared on-chain types: USDC mint, seeds, Family/Bucket/
                  Session/PriceStatus/Side, Ed25519 introspection + PriceMsg,
                  upgrade-authority guard, tighten-only guard
programs/
  lvrt_gov        Squads → queue → 72h → execute (executor PDA signs), guardian cancel
  lvrt_oracle     signed-report verification, Core median / Stocks primary+confirm /
                  enclave aggregation, PriceState, calendar, gap protocol, receipts
  lvrt_engine     margin accounts, delegates, sharded OI, one-tx fills, funding/borrow
                  merge crank, liquidation, TP/SL triggers, corporate actions
  lvrt_vault      per-family LLP buckets (Token-2022 LP mint), NAV mint/redeem,
                  48h queue, engine-only settlement
  lvrt_insurance  per-bucket fund, staked $LVRT tranche, engine-only shortfall cover
  lvrt_fee_router 80/10/5/5 split with the 20%→5% insurance carve-out
  lvrt_power      Squared: S² index, normFactor funding, QuoteAMM (oracle band),
                  ShortVault mint/burn, splits
  lvrt_factor     factor registry, enclave-signed publishes, 30-day methodology timelock
  lvrt_tickets    knock-out tickets: pricing, stress budget, lazy financing roll,
                  knock-out by live price or late signed report, gifts
  lvrt_twins      TwinVault state, mint/redeem stubs, on-chain solvency view
tests/            LiteSVM harness + integration tests
scripts/wsl-build.sh
keys/             program keypairs (git-ignored; back these up)
```

## Build and test

Programs build in WSL (Ubuntu 24.04). The script mirrors the repo to
`~/leveret-build` (native ext4 is much faster than `/mnt/d`), builds there and
copies `.so` + IDL back to `target/`.

```bash
wsl -d Ubuntu-24.04 -- bash /mnt/d/Sermium/Leveret/scripts/wsl-build.sh test
```

`check` (fast type-check), `build` (SBF + IDL) and `test` (build, then
`lvrt_math` unit tests and the LiteSVM suite) are the three modes. The math
crate also runs natively on Windows: `cargo test -p lvrt_math`.

## What the tests cover

`lvrt_math` (54 unit tests) — including the §14 fixture *a power-market
split keeps every long's value unchanged to 1e-9* (4:1, 1:10, 3:2).

LiteSVM integration (`tests/tests/*.rs`, 30 tests):

| Test | Spec rule |
|---|---|
| `initialize_requires_upgrade_authority` | no front-running of one-shot inits |
| `oracle_needs_two_agreeing_sources_for_live` | §2.3 median, outlier drop, WIDE |
| `halt_then_resume_applies_gap_protocol` | §6.2 band ≥ 2× normal for 10 min, `at_open` |
| `unregistered_signer_is_rejected` | §2.1 registered keys only |
| `one_transaction_open_and_close_with_profit` | §3.3 fill path, exact fill/fee/PnL; §1 CU budget (open ≈ 47k, close ≈ 38k CU incl. a 2-source oracle post, budget 300k) |
| `anti_staleness_edge_haircuts_quick_round_trips` | §3.3 3× spread hurdle < 10 s |
| `pause_blocks_opens_but_never_exits` | design rule 3, guardian tighten-only |
| `wide_and_stale_prices_block_opens_but_not_closes` | design rule 1 |
| `leverage_and_slippage_limits` | §3.3 step 4–5 |
| `partial_then_full_liquidation` | §3.5 25% / 100% close, bounty |
| `withdraw_checks_health_and_is_never_paused` | cross health, exits open |
| `merge_aggregates_shards_and_accrues_funding` | §3.2 merge, §3.4 velocity funding + borrow, 24h signer-key expiry/rotation |
| `timelock_executes_only_after_72h` | §12 timelock, guardian cancel |
| `losing_trader_pays_bucket_carry_and_fees` | settlement: fees → inbox, loss + carry → bucket, custody == Σ ledgers |
| `winning_trader_is_paid_by_bucket_and_can_withdraw_everything` | settlement: bucket pays winners; profit is withdrawable |
| `bad_debt_is_covered_by_the_insurance_fund` | §3.5 loss waterfall: insurance makes the bucket whole |
| `uncovered_bad_debt_falls_on_the_bucket` | waterfall with an empty fund |
| `settlement_rejects_a_custody_that_cannot_cover_it` | custody shard selection |
| `adl_is_refused_while_the_bucket_is_healthy` | §3.5 ADL only past the trigger |
| `adl_closes_top_rank_first_and_stops_at_target` | ADL at the mark, partial close to target, bucket still pays winners |
| `ranks_within_a_round_must_not_increase` | ADL ordering |
| `adl_guards` | operator only, all bucket markets, winners only, fresh merges |
| `bad_debt_slashes_the_tranche_pro_rata_before_nav` | §5 tranche: pro-rata slash at TWAP, NAV kept whole via receivable |
| `escrowed_lvrt_sells_into_the_bucket` | slashed $LVRT sold at the recovery price, receivable settled |
| `slashing_needs_a_fresh_twap` | TWAP freshness, refresh + settle in one tx |
| `a_tranche_smaller_than_the_loss_is_wiped_and_the_rest_hits_nav` | full wipe, share epoch reset, remainder to NAV |
| `unstake_after_cooldown_pays_the_post_slash_amount_and_rewards_are_claimable` | 14-day cooldown still slashable, rewards per share |
| `late_crossing_report_knocks_the_ticket_out` | §14 fixture |
| `buy_prices_the_ticket_and_enforces_distance` | §9 price, 3% minimum distance |
| `evidence_from_before_issue_is_rejected` | §9 knock-out evidence window |

## Status per program

| Program | Implemented | TODO (returns `NotImplemented` or noted) |
|---|---|---|
| gov | init (upgrade-authority gated), queue, cancel, execute via `invoke_signed`, self-admin, replay guard | — |
| oracle | signer registry (attestation hash, expiry), feeds with depth gate + ≥2 sources, Ed25519 introspection, aggregation per family, calendar override, gap protocol, `at_open`, guardian tighten-only status, receipt roots + Merkle verify | Chainlink verifier CPI, Switchboard Surge verification (both enter via registered pusher keys meanwhile) |
| engine | everything in the fill path, cross/isolated margin, delegates with budgets, deposit/withdraw (USDC only), circuit-breaker queue, liquidation, TP/SL, shard merge + funding + borrow, split/dividend crank, tighten-only risk setters, `settle_shard` (fees → fee router, net PnL + carry ↔ bucket, bad debt → insurance → staked tranche), ADL | USDT→USDC Jupiter deposit, trigger re-pricing on splits, limit-open triggers |
| vault | buckets, LP mint, NAV deposit/redeem ±5 bps, dead shares, 48h queue, engine-only exposure report + settlement, slash receivable in NAV, insurance-only recovery collection | composite LLP router, hedge-router authority |
| insurance | funds, targets, contributions, engine-only shortfall cover, share-based staked tranche, TWAP crank, pro-rata slashing into escrow, recovery sales, 14-day unstake, reward claims | — |
| fee_router | per-bucket fee inbox PDAs, 80/10/5/5 split | ledger CPIs into vault/insurance, keeper/oracle-operator shares, buy-and-burn |
| power | index, normFactor accrual, daily carry, ShortVault mint/burn at 200%/150%, AMM buy inside band, split | AMM sell, batch liquidations, Crab, `redeem_at_index`, Token-2022 metadata |
| factor | registry, signed publishes (methodology hash checked), liveness pause, 30-day methodology change, guardian pause | factor perps trade on the engine via an oracle feed signed by the same enclave key |
| tickets | buy with distance/caps/stress budget, sell-back (session only), knock-out by live or late signed evidence, transfer, gifts | split handling, routing liquidity through `lvrt_vault` |
| twins | vault state, Token-2022 mint, solvency view | Scaled UI Amount mint, engine CPIs for mint/redeem, multiplier steps |

Off-chain services (§13: keepers, enclaves, API/MCP/x402, receipts) are not
part of this pass.

## Decisions and deviations worth reviewing

- **Clock resolution.** `Clock::unix_timestamp` is whole seconds, so "now" is
  taken as the end of the current second (`ts·1000 + 999`) for the 800 ms /
  2 s freshness windows. Message timestamps from the future by < 1 s pass.
- **Inline prices = separate instruction in the same tx.** `post_prices`
  precedes the engine instruction; a stale-but-newer post is a no-op, so a
  trade never fails because a pusher got there first.
- **OI caps are in base units**, notional caps in USDC.
- **Borrow utilization** is measured against the market's OI caps until the
  vault reports bucket utilization on-chain.
- **Insurance carve-out comes out of the 80% workers' share** (the spec gives
  both "80% to workers" and "20% of bucket fees to insurance").
- **Settlement.** Trades only move internal balances; `settle_shard`
  (permissionless) moves real USDC: fees → the bucket's fee inbox, and
  `−trader PnL + carry − bad debt` between custody and the LLP bucket, then
  `min(bad debt, insurance fund)` from insurance into the bucket, then the
  staked tranche for the rest. Carry
  (funding + borrow) is recorded per shard because funding nets to zero only
  when OI is balanced — the pool is counterparty to the skew. Afterwards
  custody == Σ collateral + queued profit (asserted in every settlement test).
- **Staked tranche.** Stakes are shares of a per-bucket $LVRT pool, so a
  slash is pro rata across every staker, including those cooling down to
  unstake. Slashed $LVRT is valued at the published TWAP (a 30-minute
  time-weighted EMA of the $LVRT oracle feed, refreshed by a permissionless
  crank and required to be < 1 h old) less a 5% recovery discount, moved to
  escrow and booked as a receivable in the bucket's NAV — so LPs don't take
  the hit while it's being sold. Anyone can buy escrow at the current
  recovery price; proceeds go straight into the bucket and net against the
  receivable, so a later price move lands in NAV honestly. Bad debt beyond
  the tranche's value reduces NAV. A slash that empties the pool bumps a
  share epoch: old shares (and their unclaimed rewards) are worthless and
  new stakers start 1:1. If slashing is needed and the TWAP is stale,
  settlement fails with `StaleTwap`; the cranker refreshes it in the same
  transaction.
- **ADL** (GMX-v2-style, adapted to the spec's ranking). It may run only
  while the bucket's trader uPnL is ≥ 95% of its capital (bucket USDC +
  unsettled flows + insurance fund), computed on-chain over every market of
  the bucket (`BucketRisk.market_count`; merges ≤ 25 slots old). Each call
  closes just enough of one winner, at the exact mark with no fee, to return
  to 90% — so the bucket stays able to pay. Rank = `pnl% × leverage`, which
  reduces to PnL / position margin. A permissioned ADL operator picks the
  targets; the chain enforces non-increasing rank within a round and logs
  rank, ratios and reason. Full on-chain ranking would need enumerating all
  positions and isn't attempted. A bucket can list ~17 markets before ADL
  needs v0 transactions with lookup tables.
- **Tickets keep their own USDC vault** for the TICKETS bucket for now.
- **Corporate actions** are declared by a `ca_operator` key while the oracle
  holds the market in `CA_PENDING`; positions are rescaled lazily per account.
- Spec items marked (U) — Switchboard instruction layout, SIMD-0296 v1
  transactions, vendor licensing — are not relied on anywhere.

## Before any mainnet use

This is a skeleton: unaudited, with known TODOs in the money paths
(fee-router ledger CPIs, Crab, Twins mint/redeem). Two audits, verified builds, the published
signer policy and an end-to-end mainnet timelock rehearsal are launch gates
in the spec (§14).
