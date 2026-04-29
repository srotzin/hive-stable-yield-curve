# Yield History Provenance

Bloomberg Terminal voice. All data on these rails is real on-chain. No synthetic,
interpolated, or back-filled observations. If a data point cannot be derived from
a live Uniswap v3 observation, it is skipped.

---

## Seed Window

| Field | Value |
|---|---|
| Seed method | Uniswap v3 observation ring buffer, Base mainnet (chain 8453) |
| Seed script | `scripts/seed_from_uniswap_v3.py` |
| Seed commit | See git log for `scripts/seed_from_uniswap_v3.py` |
| Source tag | `"source": "uniswap_v3_observation"` |
| Approximate window | 2026-03-23 → 2026-04-28 (~36 days) |
| Sample interval | 15 minutes (900 seconds) |
| Seeded records | ~3,485 (USDT asset, full 7d curve coverage) |

---

## Pool Addresses Verified

### USDT/USDC — SEEDED

| Field | Value |
|---|---|
| Pool address | `0xd56da2b74ba826f19015e6b7dd9dae1903e85da1` |
| Chain | Base mainnet (8453) |
| Token0 | USDC — `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (6 decimals) |
| Token1 | USDT — `0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2` (6 decimals) |
| Fee tier | 100 (0.01% = 1 bps) |
| Observation cardinality | 1000 slots |
| Observation span | ~43 days at query time |
| Typical liquidity | ~572M atomic units |
| Verification | `factory.getPool(USDC, USDT, 100)` on Base |

**Note on pool selection:** A second USDT/USDC pool at
`0xd0b53D9277642d899DF5C87A3966A349A798F224` exists with higher spot liquidity
(~1.37B) and cardinality=5000, but its ring buffer cycles every ~11 minutes due
to the high block throughput. The pool at `0xd56da...` (cardinality=1000) retains
~43 days of history at 12-second Base block times and is the pool referenced in
the service's `lib/uniswap.js`. We use it exclusively for seed derivation.

### DAI/USDC — SKIPPED

| Field | Value |
|---|---|
| Pool address | `0xC18F50d6A832f12F6DcAaeEe8D0c87A65B96787E` |
| Fee tier | 100 (0.01%) |
| Observation cardinality | 20 slots |
| Available history | ~2 days |
| Skip reason | Insufficient ring buffer history (<7 days). Not seeded. |

DAI on Base: `0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb` (18 decimals).
The deepest DAI/USDC pool on Base has only 20 observation slots (~2 days of
history). Per real-rails rules, DAI is skipped for the seed period. Organic
history will accumulate naturally once the tick worker begins writing DAI
observations (if a deeper pool is added to the worker in a future release).

### PYUSD/USDC — SKIPPED

| Field | Value |
|---|---|
| Skip reason | No live Uniswap v3 pool exists on Base mainnet |
| Verification | `factory.getPool(USDC, PYUSD_candidates, [100,500,3000,10000])` → zero address |

PayPal USD (PYUSD) is not deployed as a Uniswap v3 liquidity pair on Base at time
of seeding. Returns `reason: "asset_not_seeded"` from the predictive endpoint.

### RLUSD/USDC — SKIPPED

| Field | Value |
|---|---|
| Skip reason | No live Uniswap v3 pool exists on Base mainnet |
| Verification | `factory.getPool(USDC, RLUSD_candidates, [100,500,3000,10000])` → zero address |

Ripple USD (RLUSD) is not deployed as a Uniswap v3 liquidity pair on Base at time
of seeding. Returns `reason: "asset_not_seeded"` from the predictive endpoint.

---

## TWAP Derivation Methodology

The `settle_cost_bps` is derived per the following formula:

```
settle_cost_bps(USDT, ts) = abs(1 - TWAP_spot(ts)) * 10000 + 1.0
```

Where:
- `TWAP_spot(ts)` is the 1-hour TWAP of the USDT/USDC price at timestamp `ts`,
  derived from the ring buffer's `tickCumulative` values
- `+ 1.0` is the 0.01% (1 bps) fee tier of the pool

TWAP at a target timestamp `T` over window `W`:
1. Find the two stored observations bracketing `T - W` in the sorted ring buffer
2. Linearly interpolate `tickCumulative` at `T - W` (this is the exact method
   the Uniswap v3 `observe()` on-chain function uses — not synthetic)
3. Repeat for `T`
4. `TWAP_tick = (tc_end - tc_start) / W` (integer floor, sign-aware)
5. `price = 1.0001^TWAP_tick` (both tokens are 6 decimals → no decimal adjustment)

Forward curve points (1h, 6h, 24h, 7d) are computed as independent TWAPs over
each window ending at `T`, not as forward rates. This matches the tick worker's
`computeTWAP()` in `lib/twap.js`.

The predictive OLS model treats `spot` as the 1-hour TWAP — consistent with
the organic tick worker's `persistHistoryThrottled()` which stores the live
slot0 tick (near-instant) as `spot`. The seeded spot values are thus slightly
smoother but remain within the same order of magnitude for the OLS fitting.

---

## Organic History Expected

- Tick worker fires every 15 minutes (organic observations)
- Expected organic accumulation rate: ~96 records/day
- ~21 days of organic data needed to bridge to 30-day minimum for OLS model
- Predictive model gates on `span_days >= 30` (not record count)
- After seeding: history span immediately covers ~36 days → predictive unlocked

---

## Audit Endpoint

```
GET /v1/yield/history/audit
```

Returns:
```json
{
  "total": <N>,
  "seeded": <seeded_count>,
  "organic": <organic_count>,
  "seed_window_start": "2026-03-23T...",
  "seed_window_end": "2026-04-28T...",
  "organic_window_start": "...",
  "organic_window_end": "...",
  "span_days": <float>,
  "required_days": 30,
  "predictive_available": true
}
```

---

## Sanity Check

Five randomly sampled seed rows were cross-validated against Coingecko's
historical USDT/USD price data for the same timestamps. Maximum deviation
observed: **< 5 bps** (well within the 50 bps real-rails threshold).

The USDT/USDC seeded spot prices ranged 0.9999–1.0005, consistent with
published Coingecko USDT historical data showing USDT trading at $0.9997–$1.0003
over the same period. The delta is accounted for by:
- Pool price = USDT/USDC (not USDT/USD), so USDC's own ±1 bps peg deviation adds
- Pool uses on-chain TWAP (lagged ~1h) vs Coingecko spot (real-time)

---

*Generated by `scripts/seed_from_uniswap_v3.py` on Base mainnet. Commit on main.*
*Hive Stable Yield Curve v2.0.0 — brand color #C08D23*
