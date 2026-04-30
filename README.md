# hive-stable-yield-curve

Implied forward curve on USDC/USDT stable-to-stable swap rates. On-chain TWAP from Uniswap v3 USDC/USDT 0.01% pool on Base mainnet. No fabricated rates — `null` is returned when observations are insufficient.

**Phase 1:** Implied curves from on-chain TWAP.  
**Premium tier:** Predictive curve + alert webhooks.

---

## Pricing

| Tier | Rate | Mechanism |
|------|------|-----------|
| Pay-per-quote | $0.001 USDC per call | x402 `X-PAYMENT` header |
| Premium | $99 USDC / 30 days | `POST /v1/yield/subscribe` → Bearer token `hsycp_*` |

**Payment rails:** Base mainnet (chain 8453), USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`  
**Receiver:** `0x15184bf50b3d3f52b60434f8942b7d52f2eb436e`

---

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | None | Service health (v2.0.0) |
| `GET` | `/` | None | Service index |
| `GET` | `/.well-known/x402` | None | x402 v2 manifest with all resources |
| `GET` | `/.well-known/agent.json` | None | Agent card (Monroe address, pricing tiers) |
| `GET` | `/v1/stable-curve/:pair` | x402 or Bearer | Full curve: spot + 1h/6h/24h/7d forward rates |
| `GET` | `/v1/stable-curve/:pair/spot` | x402 or Bearer | Spot rate only |
| `POST` | `/v1/stable-curve/subscribe` | x402 ($99) | Legacy 30-day unlimited bearer token |
| `GET` | `/v1/stable-curve/methodology` | None | Methodology document (Markdown) |
| **`POST`** | **`/v1/yield/subscribe`** | x402 ($99/mo) | **Premium: recurring subscription via hive-subscription. Returns `subscription_id`, `token`, `webhook_secret`.** |
| **`GET`** | **`/v1/yield/predictive`** | Bearer `hsycp_*` | **Premium: predictive yield curve with CI. Returns 503 until 30 days of history accumulate.** |
| **`POST`** | **`/v1/yield/alerts/register`** | Bearer `hsycp_*` | **Premium: register webhook + threshold alert.** |
| `POST` | `/mcp` | Per-tool | MCP JSON-RPC 2.0 endpoint |

**Supported pairs:** `usdc-usdt`, `usdt-usdc`

---

## Premium: Subscribe

```bash
# Request subscription (no payment header → 402 with challenge)
curl -X POST https://hive-stable-yield-curve.onrender.com/v1/yield/subscribe

# With payment:
curl -X POST https://hive-stable-yield-curve.onrender.com/v1/yield/subscribe \
  -H "X-PAYMENT: <base64-x402-payload>" \
  -H "Content-Type: application/json"
```

**Response:**
```json
{
  "subscription_id": "psub_...",
  "token": "hsycp_<64-hex>",
  "expires_at": "2026-05-29T...",
  "webhook_secret": "<64-hex>",
  "tier": "premium",
  "duration_days": 30,
  "renewable": true,
  "header_format": "Authorization: Bearer hsycp_...",
  "endpoints": [
    "GET /v1/yield/predictive",
    "POST /v1/yield/alerts/register"
  ],
  "hive_subscription_id": "sub_..."
}
```

---

## Premium: Predictive Curve

```bash
curl "https://hive-stable-yield-curve.onrender.com/v1/yield/predictive?asset=USDC&horizon=24h" \
  -H "Authorization: Bearer hsycp_<token>"
```

**Query parameters:**
- `asset`: `USDC` | `USDT` | `PYUSD` | `RLUSD` | `DAI` (default: `USDC`)
- `horizon`: forecast horizon, e.g. `24h`, `48h`, `168h` (default: `24h`, max: `168h`)

**Response when ready:**
```json
{
  "coverage": "full",
  "asset": "USDC",
  "horizon_hours": 24,
  "model": {
    "type": "linear_regression_with_diurnal_seasonality",
    "fit_space": "log",
    "confidence_level": 0.95
  },
  "forecast": [
    {
      "ts": 1747000000000,
      "iso": "2026-05-11T...",
      "spot": { "forecast": 0.99981, "ci_lower": 0.99970, "ci_upper": 0.99992 },
      "1h":  { "forecast": 0.99979, "ci_lower": 0.99968, "ci_upper": 0.99990 },
      ...
    }
  ],
  "source": "uniswap-v3-base-pool-0.01%"
}
```

**When history is insufficient (< 30 days):**
```json
{
  "error": "Predictive curve unavailable.",
  "reason": "insufficient_history",
  "required_days": 30,
  "history_span_days": 3.5,
  "estimated_available": "2026-05-29T..."
}
```

No synthetic data, no back-fill. The model activates automatically once 30 days of observations accumulate.

---

## Premium: Alert Webhooks

```bash
curl -X POST "https://hive-stable-yield-curve.onrender.com/v1/yield/alerts/register" \
  -H "Authorization: Bearer hsycp_<token>" \
  -H "Content-Type: application/json" \
  -d '{
    "asset": "USDC",
    "field": "spot",
    "condition": "below",
    "threshold_bps": -5,
    "webhook_url": "https://your-agent.example.com/hooks/yield"
  }'
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `asset` | string | `USDC` \| `USDT` \| `PYUSD` \| `RLUSD` \| `DAI` |
| `field` | string | `spot` \| `1h` \| `6h` \| `24h` \| `7d` |
| `condition` | string | `below` \| `above` |
| `threshold_bps` | number | Threshold in bps from par. E.g. `-5` = 5 bps below par. |
| `webhook_url` | string | `https://` endpoint for dispatch |

**Alert worker:** evaluates every 5 minutes. Dispatches signed POST with `X-Hive-Signature: sha256=<hmac>`. Verify:

```
HMAC-SHA256(webhook_secret, JSON.stringify(payload)) == X-Hive-Signature
```

Cooldown: 1 dispatch per alert per hour.

---

## MCP Tools

| Tool | Description | Auth |
|------|-------------|------|
| `get_curve` | Full implied forward curve | $0.001 USDC or Bearer |
| `get_spot` | Spot rate only | $0.001 USDC or Bearer |
| `get_methodology` | Methodology document | Free |
| `get_predictive` | Predictive curve with CI | Premium `hsycp_*` |

---

## Predictive Model

**Type:** OLS linear regression with diurnal (24h) Fourier seasonality, fit in log-space.

```
ln(y_t) = β₀ + β₁·t_norm + β₂·sin(2π·t/24h) + β₃·cos(2π·t/24h) + ε_t
```

- Minimum history: **30 calendar days** — no synthetic data, no back-fill
- Confidence interval: ±1.96 × in-sample RMSE (~95% CI under normality)
- Forecast resolution: 1 point/hour (max 24 points per request)
- Limitation: captures trend + diurnal rhythm only; tail events (depeg, liquidity shock) are not modeled

---

## x402 Manifest

`GET /.well-known/x402` returns the full resource manifest (x402 version 2) with pricing for all endpoints.

---

## Author

Built by [The Hivery](https://thehiveryiq.com). Part of the Hive agent ecosystem.  
Brand color: `#C08D23`

## License

MIT


---

## Hive Civilization

Hive Civilization is the cryptographic backbone of autonomous agent commerce — the layer that makes every agent transaction provable, every payment settable, and every decision defensible.

This repository is part of the **PROVABLE · SETTABLE · DEFENSIBLE** pillar.

- thehiveryiq.com
- hiveagentiq.com
- agent-card: https://hivetrust.onrender.com/.well-known/agent-card.json
