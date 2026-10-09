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

## Website (`web/`)

Next.js 16 static export (React 19, Tailwind 4, three.js hero): marketing
pages for the seven families plus a `/dashboard` workspace.

With `NEXT_PUBLIC_CLUSTER` set (see `web/.env.example`) the dashboard is wired
to the programs through `@solana/kit` and typed clients generated from the
IDLs (`npm run codegen` → `web/src/generated/`):

- **Wallets** via the Wallet Standard (Phantom, Solflare, Backpack); unsigned
  transaction bytes go to the wallet, signed bytes come back. A burner test
  wallet exists on localnet only.
- **Live prices**: the latest oracle-signed quote (what a trade embeds) and
  the on-chain PriceState status / session.
- **Margin account**: balance, wallet USDC / SOL, positions with live mark and
  P&L, exposure by family, utilization.
- **Signed actions**: deposit (creates the margin account), withdraw (with
  fresh prices + health accounts), open (`[Ed25519 verify][post_prices]
  [open_position]` in one transaction, slippage-bounded), close, TP/SL
  triggers (placed after the open, listed and cancellable in Orders), agent
  policies as on-chain engine delegates (authorize / revoke / revoke-all kill
  switch; withdraw permission never set), test-USDC faucet on test clusters.
- **Squared** (`lvrt_power`): live index value per PowerToken (S² × nf) and
  on-chain daily carry. Long = buy PowerTokens from the QuoteAMM inside the
  oracle band, sell back from the positions table. Short = mint in a
  ShortVault against margin plus the sale proceeds (~205% of debt) and sell
  the tokens; close buys the debt back, burns it and returns the collateral.
- **Tickets** (`lvrt_tickets`): budget-capped buy (the price paid, never more
  than the budget, is the maximum loss) at a chosen knock-out level; holdings
  show the rolled barrier, live value and leverage; sell back in session.
- Twins, Small Caps, ratio markets (NVDA/AMD) and limit orders keep the
  original prepare-a-draft flow, labelled as such.

Without `NEXT_PUBLIC_CLUSTER` it stays the offline reference dashboard.

```bash
cd web && npm ci && npm run build && npm run preview   # http://127.0.0.1:3000
```

Requires Node ≥ 22.12. npm 11 blocks the `sharp` / `unrs-resolver` install
scripts by default; neither is needed (images are unoptimized in the static
export and ESLint isn't part of the build). When hosting `web/out` anywhere
other than Vercel, rewrite `**/__next.<seg>.<rest>.txt` →
`**/__next.<seg>/<rest>.txt` (Next 16 prefetch payloads; `scripts/preview.mjs`
does this locally) — without it client-side navigation falls back to full page
loads.

## Test clusters

Programs for localnet / devnet are built with `--features devnet`, which swaps
the hard-coded USDC mint for a Leveret test mint
(`H3tRv17bsBR3ccV5cT9nzt66uqm1wn66tT9rmAiAvrfi`, key in `keys/`) so the dev
faucet can mint. Mainnet builds never include it.

```bash
# in WSL
scripts/wsl-build.sh devnet                  # -> target/deploy-devnet
scripts/localnet.sh                          # validator with all 10 programs, upgradeable
# on Windows / anywhere with Node >= 24
LVRT_CLUSTER=localnet node web/dev/bootstrap.ts   # idempotent: mints, feeds, markets, shards, LLP…
LVRT_CLUSTER=localnet node web/dev/oracle.ts      # quotes, faucet, push/merge, TP/SL + knock-out keepers, AMM arb
LVRT_CLUSTER=localnet node web/dev/e2e.ts         # headless deposit → open → close → withdraw
LVRT_CLUSTER=localnet node web/dev/e2e-products.ts  # SOL² long + short round trips, SOL-T buy → sell back
```

`web/dev/oracle.ts` stands in for the oracle-pusher, merge-cranker and
trigger-exec services on test clusters: it random-walks prices from the
dashboard's reference values, signs them with the registered pusher / enclave
keys, serves `GET /quotes`, `GET /quote/<id>`, `POST /faucet`, posts every feed
on-chain and merges shards periodically, executes TP/SL triggers, knocks out
tickets with signed evidence, and arbitrages the Squared QuoteAMMs back to
their index (the index moves ~2× the underlying, so an unattended pool leaves
its ±1% band within the hour; the arb mints through its own ShortVault at
220% or buys and burns, like a real arbitrageur would). Test
clusters use a 60 s quote freshness window (mainnet: 800 ms / 2 s) because
wallets take seconds to approve and devnet can't afford a sub-second pusher.

**Devnet status:** `lvrt_oracle`, `lvrt_engine`, `lvrt_vault`,
`lvrt_insurance`, `lvrt_fee_router`, `lvrt_power` and `lvrt_tickets` are
deployed (upgrade authority `2FmzTtbkyfsrqgZ6jhLaTYmKVSyLQvzH52tR76MQzukG`)
and bootstrapped: all 13 markets; the Core / Stocks / Factors LLP buckets
(seeded with test USDC), insurance funds and fee inboxes; NVDA², SPY² and
SOL² QuoteAMMs seeded with 250k test USDC each against ShortVault-backed
tokens; NVDA-T and SOL-T ticket markets on a 500k vault. Trading, deposits,
withdrawals, Squared longs and shorts and tickets work end to end (stock
underlyings are Closed at weekends, so use SOL² / SOL-T then). Squared
transactions are split in two or three when two signed prices plus two
Token-2022 instructions would exceed 1,232 bytes. Deploying costs the program's rent only: the write buffer is folded into
the program account. The public devnet RPC rate-limits bursts; the client
retries HTTP 429 with backoff (`web/src/lib/chain/rpc.ts`), and the dashboard
and dev keepers poll devnet less often than localnet.

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

`lvrt_math` (56 unit tests) — including the §14 fixture *a power-market
split keeps every long's value unchanged to 1e-9* (4:1, 1:10, 3:2).

LiteSVM integration (`tests/tests/*.rs`, 38 tests):

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
| `distribute_credits_the_vault_and_insurance_ledgers` | fee split moves ledgers with tokens; LP share accrues to NAV; stakers can claim |
| `staker_share_joins_the_fund_when_nobody_stakes` | no stranded staker share |
| `operator_share_comes_out_of_the_lp_remainder` | oracle-operator share, 20% cap, timelock only |
| `only_the_fee_router_can_credit_ledgers` | ledger credits are router-PDA only |
| `late_crossing_report_knocks_the_ticket_out` | §14 fixture |
| `buy_prices_the_ticket_and_enforces_distance` | §9 price, 3% minimum distance |
| `evidence_from_before_issue_is_rejected` | §9 knock-out evidence window |
| `shorts_seed_the_amm_and_longs_round_trip_inside_the_band` | §7 ShortVault-backed seed (mispriced seed refused), AMM buy, slippage, sell at the floor after an index move |
| `buys_above_the_band_route_to_the_short_vault` | §7 buys over `I(1 + b)` refused |
| `short_vault_mints_at_200_and_burns_back_to_zero` | §7 200% mint, 150% maintenance on withdraw, full burn |

## Status per program

| Program | Implemented | TODO (returns `NotImplemented` or noted) |
|---|---|---|
| gov | init (upgrade-authority gated), queue, cancel, execute via `invoke_signed`, self-admin, replay guard | — |
| oracle | signer registry (attestation hash, expiry), feeds with depth gate + ≥2 sources, Ed25519 introspection, aggregation per family, calendar override, gap protocol, `at_open`, guardian tighten-only status, receipt roots + Merkle verify | Chainlink verifier CPI, Switchboard Surge verification (both enter via registered pusher keys meanwhile) |
| engine | everything in the fill path, cross/isolated margin, delegates with budgets, deposit/withdraw (USDC only), circuit-breaker queue, liquidation, TP/SL, shard merge + funding + borrow, split/dividend crank, tighten-only risk setters, `settle_shard` (fees → fee router, net PnL + carry ↔ bucket, bad debt → insurance → staked tranche), ADL | USDT→USDC Jupiter deposit, trigger re-pricing on splits, limit-open triggers |
| vault | buckets, LP mint, NAV deposit/redeem ±5 bps, dead shares, 48h queue, engine-only exposure report + settlement, slash receivable in NAV, insurance-only recovery collection | composite LLP router, hedge-router authority |
| insurance | funds, targets, contributions, engine-only shortfall cover, share-based staked tranche, TWAP crank, pro-rata slashing into escrow, recovery sales, 14-day unstake, reward claims | — |
| fee_router | per-bucket fee inbox PDAs, 80/10/5/5 split, optional oracle-operator share, ledger CPIs into vault + insurance | buy-and-burn |
| power | index, normFactor accrual, daily carry, ShortVault mint/burn at 200%/150%, QuoteAMM buy / sell inside the band, authority `seed_amm` with ShortVault-backed tokens, split | batch liquidations, Crab (and routing sells to Crab redeem when the AMM's USDC side is empty), `redeem_at_index`, Token-2022 metadata, AMM inventory withdrawal |
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
- **Fee ledgers.** `distribute` pays the LP share into the bucket and the
  insurance + staker shares into the fund's vault, then CPIs
  `lvrt_vault::credit_fees` (raises `usdc_balance`, so NAV accrues) and
  `lvrt_insurance::credit_fees` (fund balance + rewards per share). Both
  accept only the fee router's signer PDA and check the USDC has arrived.
  With no stakers, the staker share joins the insurance fund. Keepers and
  liquidators are already paid by trigger and liquidation bounties; oracle
  operators get an optional share of fees (timelock-set, ≤ 20%, default 0)
  out of the workers' 80% before the LP remainder.
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
- **QuoteAMM pricing.** Trades run on the constant-product curve but never
  fill under `I(1 − b)`: a sell gets at least the floor (paid from the AMM's
  USDC, per the spec), and a buy against a pool quoting under the band fills
  at the floor too, so inventory can't be bought cheap and sold back at the
  floor. Buys that would pay over `I(1 + b)` are refused (route to ShortVault
  mint). AMM inventory comes from `seed_amm` (timelock authority): USDC plus
  PowerTokens the authority minted through its own ShortVault, so every token
  stays backed; the pool's mark must sit inside the band after a seed.
- **Corporate actions** are declared by a `ca_operator` key while the oracle
  holds the market in `CA_PENDING`; positions are rescaled lazily per account.
- Spec items marked (U) — Switchboard instruction layout, SIMD-0296 v1
  transactions, vendor licensing — are not relied on anywhere.

## Before any mainnet use

This is a skeleton: unaudited, with known TODOs in the money paths
(Crab, Twins mint/redeem, buy-and-burn). Two audits, verified builds, the published
signer policy and an end-to-end mainnet timelock rehearsal are launch gates
in the spec (§14).
