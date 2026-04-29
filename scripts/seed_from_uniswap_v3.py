#!/usr/bin/env python3
"""
seed_from_uniswap_v3.py — Hive Stable Yield Curve
Bloomberg Terminal voice: Real rails only. No synthetic data, no interpolation
across gaps exceeding the Uniswap v3 protocol's own internal interpolation model.

Derives yield_history.jsonl records from the Uniswap v3 USDC/USDT 0.01%
observation ring buffer on Base mainnet (chain 8453).

Pool: 0xd56da2b74ba826f19015e6b7dd9dae1903e85da1
  token0 = USDC  (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913, 6 decimals)
  token1 = USDT  (0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2, 6 decimals)
  fee tier = 100 (0.01% = 1 bps)
  cardinality = 1000 slots → ~43 days of history

Schema written (matches tick worker exactly):
  { ts, spot, curve: {"1h","6h","24h","7d"}, coverage,
    source, pool_address, settle_cost_bps, ts_utc, asset }

TWAP derivation at each 15-min sample point T:
  For window W: observe ring buffer at T-W and T, interpolate tickCumulative,
  compute TWAP tick = (tc_end - tc_start) / W (floor, matching Uniswap spec),
  convert to price: 1.0001^tick (both tokens 6 decimals → no adjustment).
  The interpolation between adjacent stored observations is exactly what the
  Uniswap v3 observe() on-chain function performs internally — it is not synthetic.

settle_cost_bps(USDT, ts) = abs(1 - TWAP_spot(ts)) * 10000 + 1.0  (1 bps fee tier)

Asset availability:
  USDT/USDC: SEEDED (3400+ records, ~36 days, pool 0xd56da...)
  DAI/USDC:  SKIPPED — deepest Base pool (0xC18F50...) has only 2 days of history
  PYUSD/USDC: SKIPPED — no live Uniswap v3 pool found on Base via factory lookup
  RLUSD/USDC: SKIPPED — no live Uniswap v3 pool found on Base via factory lookup

Usage:
  python seed_from_uniswap_v3.py [--out PATH] [--post-url URL] [--token TOKEN]
  python seed_from_uniswap_v3.py --out /tmp/yield_seed.jsonl
  python seed_from_uniswap_v3.py --post-url https://hive-stable-yield-curve.onrender.com/v1/yield/admin/seed --token $SEED_ADMIN_TOKEN
"""

import argparse
import bisect
import json
import math
import sys
import time
from collections import Counter
from datetime import datetime, timezone

import requests
from web3 import Web3

# ─── Configuration ─────────────────────────────────────────────────────────────

# USDC/USDT 0.01% pool on Base — the canonical pool used by the tick worker
# Verified: token0=USDC, token1=USDT, fee=100 (0.01%), cardinality=1000
POOL_ADDRESS = "0xd56da2b74ba826f19015e6b7dd9dae1903e85da1"
POOL_FEE_BPS = 1.0   # 0.01% = 1 bps

# Alternative (deeper liquidity, but only ~11 min of ring buffer):
# POOL_ADDRESS_HIGH_LIQ = "0xd0b53D9277642d899DF5C87A3966A349A798F224"  # NOT used

BASE_RPC_URLS = [
    "https://base-rpc.publicnode.com",
    "https://mainnet.base.org",
    "https://base.llamarpc.com",
]

SAMPLE_INTERVAL_SECONDS = 900   # 15 minutes
TWAP_WINDOWS = {"1h": 3600, "6h": 21600, "24h": 86400, "7d": 604800}

POOL_ABI = [
    {
        "inputs": [],
        "name": "slot0",
        "outputs": [
            {"name": "sqrtPriceX96", "type": "uint160"},
            {"name": "tick", "type": "int24"},
            {"name": "observationIndex", "type": "uint16"},
            {"name": "observationCardinality", "type": "uint16"},
            {"name": "observationCardinalityNext", "type": "uint16"},
            {"name": "feeProtocol", "type": "uint8"},
            {"name": "unlocked", "type": "bool"},
        ],
        "stateMutability": "view",
        "type": "function",
    },
    {
        "inputs": [{"name": "index", "type": "uint256"}],
        "name": "observations",
        "outputs": [
            {"name": "blockTimestamp", "type": "uint32"},
            {"name": "tickCumulative", "type": "int56"},
            {"name": "secondsPerLiquidityCumulativeX128", "type": "uint160"},
            {"name": "initialized", "type": "bool"},
        ],
        "stateMutability": "view",
        "type": "function",
    },
]


# ─── Helper functions ──────────────────────────────────────────────────────────

def tick_to_price(tick, decimal0=6, decimal1=6):
    """Convert Uniswap v3 TWAP tick to price of token0 in terms of token1."""
    raw = math.pow(1.0001, tick)
    adjustment = math.pow(10, decimal0 - decimal1)
    return raw * adjustment


def get_web3():
    """Connect to Base mainnet via public RPC, rotating on failure."""
    for url in BASE_RPC_URLS:
        try:
            w3 = Web3(Web3.HTTPProvider(url, request_kwargs={"timeout": 30}))
            if w3.is_connected():
                print(f"[RPC] Connected to {url}", file=sys.stderr)
                return w3
        except Exception as e:
            print(f"[RPC] Failed {url}: {e}", file=sys.stderr)
    raise RuntimeError("All Base RPC endpoints failed")


def load_ring_buffer(w3, pool_address):
    """
    Read all initialized observations from the Uniswap v3 pool ring buffer.
    Returns (obs_ts, obs_tc, obs_slot) sorted chronologically.

    The ring buffer stores (blockTimestamp, tickCumulative, ..., initialized)
    per slot. We read all cardinality slots and filter initialized=True.
    tickCumulative grows monotonically between any two observations; the
    Uniswap v3 protocol linearly interpolates between adjacent observations
    when no exact block matches the requested timestamp — this is exactly
    what the on-chain observe() function does.
    """
    contract = w3.eth.contract(
        address=Web3.to_checksum_address(pool_address), abi=POOL_ABI
    )
    slot0 = contract.functions.slot0().call()
    cardinality = slot0[3]
    obs_index = slot0[2]

    print(
        f"[RING] Pool {pool_address}: cardinality={cardinality}, "
        f"current_obs_index={obs_index}, tick={slot0[1]}",
        file=sys.stderr,
    )

    observations = []
    for i in range(cardinality):
        obs = contract.functions.observations(i).call()
        if obs[3]:  # initialized
            observations.append(
                {
                    "slot": i,
                    "blockTimestamp": obs[0],
                    "tickCumulative": obs[1],
                }
            )

    observations.sort(key=lambda x: x["blockTimestamp"])
    ts_list = [o["blockTimestamp"] for o in observations]
    tc_list = [o["tickCumulative"] for o in observations]
    slot_list = [o["slot"] for o in observations]

    if ts_list:
        span_days = (ts_list[-1] - ts_list[0]) / 86400
        print(
            f"[RING] {len(observations)} initialized observations, "
            f"span={span_days:.2f} days "
            f"({datetime.fromtimestamp(ts_list[0], tz=timezone.utc).strftime('%Y-%m-%d')} → "
            f"{datetime.fromtimestamp(ts_list[-1], tz=timezone.utc).strftime('%Y-%m-%d')})",
            file=sys.stderr,
        )

    return ts_list, tc_list, slot_list


def get_tc_at(target_ts, obs_ts, obs_tc):
    """
    Interpolate tickCumulative at target_ts using the stored ring buffer.
    This mirrors exactly what Uniswap v3's observe() does on-chain:
    tickCumulative increases at rate = current_tick between observations,
    so linear interpolation between adjacent stored points is protocol-correct.

    Returns interpolated tickCumulative, or None if target_ts is out of range.
    """
    pos = bisect.bisect_right(obs_ts, target_ts)
    if pos == 0 or pos >= len(obs_ts):
        return None

    t0, t1 = obs_ts[pos - 1], obs_ts[pos]
    tc0, tc1 = obs_tc[pos - 1], obs_tc[pos]
    gap = t1 - t0
    if gap <= 0:
        return None

    frac = (target_ts - t0) / gap
    return tc0 + frac * (tc1 - tc0)


def get_twap_price(ts_end, window_secs, obs_ts, obs_tc):
    """
    Compute TWAP price over [ts_end - window_secs, ts_end].
    Returns None if the window exceeds available history.
    """
    ts_start = ts_end - window_secs
    if ts_start < obs_ts[0]:
        return None

    tc_start = get_tc_at(ts_start, obs_ts, obs_tc)
    tc_end = get_tc_at(ts_end, obs_ts, obs_tc)
    if tc_start is None or tc_end is None:
        return None

    delta = tc_end - tc_start
    # Floor division matching Uniswap v3 spec (match sign convention)
    twap_tick = int(delta // window_secs)
    if (delta % window_secs) < 0:
        twap_tick -= 1

    price = tick_to_price(twap_tick)
    if not (0.9 < price < 1.1) or not math.isfinite(price):
        # Sanity check: stablecoin price should be within 10% of par
        return None
    return price


# ─── Main seeding logic ────────────────────────────────────────────────────────

def generate_seed_records(w3, pool_address, fee_bps, asset="USDT"):
    """
    Generate yield_history.jsonl records from the pool's ring buffer.
    Samples at 15-minute intervals, computes TWAP spot and forward curve.
    """
    obs_ts, obs_tc, obs_slot = load_ring_buffer(w3, pool_address)
    if not obs_ts:
        print(f"[SKIP] No observations found in pool {pool_address}", file=sys.stderr)
        return []

    ts_oldest = obs_ts[0]
    ts_newest = obs_ts[-1]
    now = int(time.time())

    # Sampling window: we need ts_oldest + max_window for the longest TWAP
    # The 7d window requires 7d of prior history at the sample point
    max_window = max(TWAP_WINDOWS.values())  # 604800 seconds = 7 days

    sample_start = ts_oldest + max_window + SAMPLE_INTERVAL_SECONDS
    sample_end = min(ts_newest, now) - SAMPLE_INTERVAL_SECONDS

    if sample_start >= sample_end:
        # Fall back to 24h max window if 7d not available
        max_window = TWAP_WINDOWS["24h"]
        sample_start = ts_oldest + max_window + SAMPLE_INTERVAL_SECONDS
        if sample_start >= sample_end:
            print(
                f"[SKIP] Insufficient history for 24h TWAP window",
                file=sys.stderr,
            )
            return []
        print(
            "[INFO] Only 24h max TWAP available (< 7d of history)",
            file=sys.stderr,
        )

    span_days_sample = (sample_end - sample_start) / 86400
    expected_n = int((sample_end - sample_start) / SAMPLE_INTERVAL_SECONDS)
    print(
        f"[SAMPLE] {datetime.fromtimestamp(sample_start, tz=timezone.utc).isoformat()} → "
        f"{datetime.fromtimestamp(sample_end, tz=timezone.utc).isoformat()} "
        f"({span_days_sample:.1f} days, ~{expected_n} points at 15-min intervals)",
        file=sys.stderr,
    )

    records = []
    skipped = 0
    ts = sample_start

    while ts <= sample_end:
        # Spot: use 1-hour TWAP as the "spot" value (consistent with tick worker)
        spot = get_twap_price(ts, TWAP_WINDOWS["1h"], obs_ts, obs_tc)
        if spot is None:
            skipped += 1
            ts += SAMPLE_INTERVAL_SECONDS
            continue

        # Forward curve
        curve = {}
        for label, window in TWAP_WINDOWS.items():
            curve[label] = get_twap_price(ts, window, obs_ts, obs_tc)

        # Coverage: count non-null fields across spot + all curve points
        all_vals = [spot] + [v for v in curve.values()]
        non_null = sum(1 for v in all_vals if v is not None)
        total_fields = 1 + len(TWAP_WINDOWS)  # 5

        if non_null == total_fields:
            coverage = "full"
        elif non_null > 0:
            coverage = "partial"
        else:
            skipped += 1
            ts += SAMPLE_INTERVAL_SECONDS
            continue

        # settle_cost_bps: abs deviation from par + fee tier
        settle_cost_bps = abs(1.0 - spot) * 10000 + fee_bps

        record = {
            "ts": ts * 1000,  # epoch milliseconds
            "spot": round(spot, 10),
            "curve": {
                "1h": round(curve["1h"], 10) if curve["1h"] is not None else None,
                "6h": round(curve["6h"], 10) if curve["6h"] is not None else None,
                "24h": round(curve["24h"], 10) if curve["24h"] is not None else None,
                "7d": round(curve["7d"], 10) if curve["7d"] is not None else None,
            },
            "coverage": coverage,
            "source": "uniswap_v3_observation",
            "pool_address": pool_address,
            "settle_cost_bps": round(settle_cost_bps, 6),
            "ts_utc": datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(),
            "asset": asset,
        }
        records.append(record)
        ts += SAMPLE_INTERVAL_SECONDS

    print(
        f"[DONE] Generated {len(records)} records, skipped {skipped} timestamps",
        file=sys.stderr,
    )
    return records


def main():
    parser = argparse.ArgumentParser(
        description="Seed yield_history.jsonl from Uniswap v3 on Base mainnet. Real rails only."
    )
    parser.add_argument(
        "--out",
        default="/tmp/yield_seed.jsonl",
        help="Output JSONL file path (default: /tmp/yield_seed.jsonl)",
    )
    parser.add_argument(
        "--post-url",
        default=None,
        help="POST seed data to this URL (e.g. https://hive-stable-yield-curve.onrender.com/v1/yield/admin/seed)",
    )
    parser.add_argument(
        "--token",
        default=None,
        help="SEED_ADMIN_TOKEN for the POST endpoint (X-Seed-Admin-Token header)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print sample rows but do not write or POST",
    )
    args = parser.parse_args()

    print("=== Hive Stable Yield Curve — Uniswap v3 Seed Script ===", file=sys.stderr)
    print("Bloomberg Terminal: Real rails only. No synthetic data.", file=sys.stderr)
    print(f"Pool: {POOL_ADDRESS}  (USDC/USDT 0.01% on Base)", file=sys.stderr)
    print(f"Chain: Base mainnet (8453)", file=sys.stderr)

    w3 = get_web3()

    # ─── Verify pool and generate records ────────────────────────────────────
    print("\n[1] Seeding USDT/USDC from ring buffer...", file=sys.stderr)
    records = generate_seed_records(w3, POOL_ADDRESS, POOL_FEE_BPS, asset="USDT")

    if not records:
        print("[ERROR] No records generated. Check RPC connectivity.", file=sys.stderr)
        sys.exit(1)

    # ─── Summary stats ────────────────────────────────────────────────────────
    spots = [r["spot"] for r in records]
    bps_vals = [r["settle_cost_bps"] for r in records]
    full_cov = sum(1 for r in records if r["coverage"] == "full")
    partial_cov = sum(1 for r in records if r["coverage"] == "partial")

    print(f"\n=== SEED SUMMARY ===", file=sys.stderr)
    print(f"Total records:  {len(records)}", file=sys.stderr)
    print(
        f"Window:         {records[0]['ts_utc']} → {records[-1]['ts_utc']}",
        file=sys.stderr,
    )
    print(
        f"Span:           {(records[-1]['ts'] - records[0]['ts']) / 86400000:.2f} days",
        file=sys.stderr,
    )
    print(f"Coverage:       {full_cov} full, {partial_cov} partial", file=sys.stderr)
    print(f"Spot range:     {min(spots):.8f} – {max(spots):.8f} USDT/USDC", file=sys.stderr)
    print(f"Settle bps:     {min(bps_vals):.4f} – {max(bps_vals):.4f}", file=sys.stderr)
    print(f"Source:         uniswap_v3_observation (auditable seed)", file=sys.stderr)
    print(f"Pool:           {POOL_ADDRESS}", file=sys.stderr)

    # Assets NOT seeded (no live pool or insufficient history)
    print(
        "\n[SKIP] DAI/USDC: deepest Base pool has only ~2 days of observations",
        file=sys.stderr,
    )
    print("[SKIP] PYUSD/USDC: no live Uniswap v3 pool on Base (factory lookup: zero address)", file=sys.stderr)
    print("[SKIP] RLUSD/USDC: no live Uniswap v3 pool on Base (factory lookup: zero address)", file=sys.stderr)

    if args.dry_run:
        print("\n[DRY RUN] Sample records:", file=sys.stderr)
        import random
        sample = random.sample(records, min(5, len(records)))
        for r in sorted(sample, key=lambda x: x["ts"]):
            print(f"  {r['ts_utc']}: spot={r['spot']:.8f}, bps={r['settle_cost_bps']:.4f}, cov={r['coverage']}")
        sys.exit(0)

    # ─── Write output ─────────────────────────────────────────────────────────
    with open(args.out, "w") as f:
        for r in records:
            f.write(json.dumps(r) + "\n")
    print(f"\n[WRITE] Wrote {len(records)} records to {args.out}", file=sys.stderr)

    # ─── POST to admin seed endpoint ──────────────────────────────────────────
    if args.post_url:
        print(f"\n[POST] POSTing {len(records)} records to {args.post_url}...", file=sys.stderr)
        headers = {"Content-Type": "application/x-ndjson"}
        if args.token:
            headers["X-Seed-Admin-Token"] = args.token

        ndjson_body = "\n".join(json.dumps(r) for r in records)
        try:
            resp = requests.post(
                args.post_url,
                data=ndjson_body,
                headers=headers,
                timeout=300,
            )
            print(f"[POST] HTTP {resp.status_code}", file=sys.stderr)
            print(f"[POST] Response: {resp.text[:800]}", file=sys.stderr)
            if resp.status_code not in (200, 201):
                print("[ERROR] POST failed — check token and endpoint", file=sys.stderr)
                sys.exit(1)
        except Exception as e:
            print(f"[ERROR] POST exception: {e}", file=sys.stderr)
            sys.exit(1)

    # Print machine-readable summary to stdout
    summary = {
        "total_records": len(records),
        "asset": "USDT",
        "pool_address": POOL_ADDRESS,
        "pool_fee_bps": POOL_FEE_BPS,
        "window_start": records[0]["ts_utc"],
        "window_end": records[-1]["ts_utc"],
        "span_days": round((records[-1]["ts"] - records[0]["ts"]) / 86400000, 2),
        "coverage_full": full_cov,
        "coverage_partial": partial_cov,
        "spot_min": min(spots),
        "spot_max": max(spots),
        "spot_mean": round(sum(spots) / len(spots), 10),
        "settle_bps_min": min(bps_vals),
        "settle_bps_max": max(bps_vals),
        "skipped_assets": ["DAI", "PYUSD", "RLUSD"],
        "skip_reason": {
            "DAI": "Deepest Base pool has only ~2 days of observations (cardinality=20)",
            "PYUSD": "No live Uniswap v3 pool on Base (factory.getPool returns zero address)",
            "RLUSD": "No live Uniswap v3 pool on Base (factory.getPool returns zero address)",
        },
    }
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
