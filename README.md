# hive-stable-yield-curve

Implied forward curve on USDC/USDT stable-to-stable swap rates. On-chain TWAP from Uniswap v3 USDC/USDT 0.01% pool on Base mainnet. No fabricated rates — null is returned when observations are insufficient.

**Phase 1:** Implied curves from on-chain TWAP.  
**Phase 2:** Dealer quotes + cross-venue aggregation.

---

## Pricing

| Tier | Rate | Mechanism |
|------|------|-----------|
| Pay-per-quote | $0.001 USDC per call | x402 `X-PAYMENT` header |
| Subscription | $99 USDC / 30 days unlimited | `POST /v1/stable-curve/subscribe` → Bearer token |

**Payment rails:** Base mainnet (chain 8453), USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`  
**Receiver:** `0x15184bf50b3d3f52b60434f8942b7d52f2eb436e`

---

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | None | Service health |
| `GET` | `/` | None | Service index |
| `GET` | `/.well-known/agent.json` | None | Agent card (Monroe address, pricing tiers) |
| `GET` | `/v1/stable-curve/:pair` | x402 or Bearer | Full curve: spot + 1h/6h/24h/7d forward rates |
| `GET` | `/v1/stable-curve/:pair/spot` | x402 or Bearer | Spot rate only |
| `POST` | `/v1/stable-curve/subscribe` | x402 ($99) | Issue 30-day subscription bearer token |
| `GET` | `/v1/stable-curve/methodology` | None | Methodology document (Markdown) |
| `POST` | `/mcp` | Per-tool | MCP JSON-RPC 2.0 endpoint |

**Supported pairs:** `usdc-usdt`, `usdt-usdc`

---

## MCP Tools

| Tool | Description | Payment |
|------|-------------|---------|
| `get_curve` | Full implied forward curve (spot + 1h/6h/24h/7d) | $0.001 USDC |
| `get_spot` | Spot rate only | $0.001 USDC |
| `get_methodology` | Methodology document | Free |

### Connect via MCP

```
POST https://hive-stable-yield-curve.onrender.com/mcp
Content-Type: application/json

{"jsonrpc":"2.0","id":1,"method":"tools/list"}
```

---

## Example Response

```json
{
  "pair": "usdc-usdt",
  "spot": 0.9998,
  "curve": {
    "1h":  0.9997,
    "6h":  0.9996,
    "24h": 0.9995,
    "7d":  null
  },
  "source": "uniswap-v3-base-pool-0.01%",
  "source_address": "0xd56da2b74ba826f19015e6b7dd9dae1903e85da1",
  "observation_window_seconds": {
    "1h": 3600,
    "6h": 21600,
    "24h": 86400,
    "7d": 604800
  },
  "generated_at": "2025-06-01T00:00:00.000Z",
  "methodology_url": "https://hive-stable-yield-curve.onrender.com/v1/stable-curve/methodology",
  "coverage": "partial"
}
```

Curve points are `null` when the Uniswap v3 pool has insufficient observations for that window. **No fabricated rates.**

---

## Subscription Mechanics

1. `POST /v1/stable-curve/subscribe` without `X-PAYMENT` → 402 with challenge for $99 USDC.
2. Client submits payment on Base, attaches settlement proof as `X-PAYMENT` header.
3. Server verifies, generates token `hsyc_<64-hex>`, persists to `/data/subs.jsonl` with `expires_at`.
4. Client passes `Authorization: Bearer hsyc_<token>` for 30-day unlimited access.

---

## Pay-per-Quote Mechanics

1. `GET /v1/stable-curve/usdc-usdt` without `X-PAYMENT` → 402 challenge.
2. Client submits $0.001 USDC on Base, attaches proof as `X-PAYMENT` header (base64 JSON).
3. Server validates and returns curve data.

---

## Methodology Summary

**Pool:** Uniswap v3 USDC/USDT 0.01% on Base (`0xd56da2b74ba826f19015e6b7dd9dae1903e85da1`)  
**Spot:** Derived from `slot0().sqrtPriceX96`  
**TWAP:** `observe([W, 0])` → tick cumulative delta → `1.0001^tick`  
**Forward rate:** Log-linear interpolation across consecutive windows  

Full methodology: `GET /v1/stable-curve/methodology`

---

## Data Source

- **Primary:** Uniswap v3 USDC/USDT 0.01% pool on Base mainnet
- **RPC:** Public Base RPC endpoints (no API key required)
- **Fallback:** Last-known-good cached value for spot (60s TTL)

No off-chain price feeds. No oracle intermediaries. On-chain data only.

---

## Cache TTLs

| Point | TTL |
|-------|-----|
| Spot | 60 seconds |
| 1h | 5 minutes |
| 6h | 30 minutes |
| 24h | 4 hours |
| 7d | 24 hours |

---

## Author

Built by [The Hivery](https://thehiveryiq.com). Part of the Hive agent ecosystem.  
Brand color: `#C08D23`

## License

MIT
