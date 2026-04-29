# v1.0.0 — hive-stable-yield-curve MCP Server

Implied forward curve on USDC/USDT stable-to-stable swap rates. On-chain TWAP from Uniswap v3 on Base mainnet.

## Tools

| Tool | Description | Payment |
|------|-------------|---------|
| `get_curve` | Full implied forward curve: spot + 1h / 6h / 24h / 7d forward rates | $0.001 USDC |
| `get_spot` | Spot USDC/USDT rate from Uniswap v3 slot0 | $0.001 USDC |
| `get_methodology` | Methodology document describing TWAP and forward curve construction | Free |

## Backend Endpoint

**Service:** `https://hive-stable-yield-curve.onrender.com`  
**MCP:** `POST https://hive-stable-yield-curve.onrender.com/mcp`  
**Pool:** Uniswap v3 USDC/USDT 0.01% on Base — `0xd56da2b74ba826f19015e6b7dd9dae1903e85da1`

## Pricing

| Tier | Amount | Mechanism |
|------|--------|-----------|
| Pay-per-quote | 1000 atomic USDC ($0.001) | x402 `X-PAYMENT` header |
| Subscription | 99000000 atomic USDC ($99) | `POST /v1/stable-curve/subscribe` → Bearer token |

**Payment rails:** Base mainnet (chain 8453)  
**USDC contract:** `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`  
**Receiver (Monroe):** `0x15184bf50b3d3f52b60434f8942b7d52f2eb436e`

## Council Provenance

Ad-hoc. Three gates passed: NEED (stable curve data is a live market gap) + YIELD ($0.001/quote, $99/mo subscription) + CLEAN-MONEY (on-chain settlement, Base USDC mainnet only).

## Data Integrity

No fabricated rates. Null is returned for any curve point where Uniswap v3 observation cardinality is insufficient. `coverage` field indicates `full` / `partial` / `none`.

## Phase Roadmap

- **Phase 1 (this release):** Implied curves from on-chain TWAP
- **Phase 2:** Dealer quotes + cross-venue aggregation (Curve, Aerodrome, Velodrome on Base)

---

*Brand color: `#C08D23` — The Hivery*
