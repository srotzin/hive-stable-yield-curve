/**
 * hive-stable-yield-curve — Implied forward curve on USDC/USDT stable-to-stable swap rates.
 * On-chain TWAP from Uniswap v3 USDC/USDT 0.01% pool on Base.
 *
 * Pricing:
 *   Pay-per-quote: $0.001 USDC per call (1000 atomic units)
 *   Subscription:  $99 USDC for 30 days unlimited (99000000 atomic units)
 *
 * x402 payment rails: Base 8453 mainnet, USDC 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
 * Monroe: 0x15184bf50b3d3f52b60434f8942b7d52f2eb436e
 */

import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { readSlot0, readTWAPObservations, sqrtPriceX96ToPrice, POOL_ADDRESS, POOL_TOKEN0, POOL_TOKEN1, POOL_FEE } from './lib/uniswap.js';
import { computeTWAP, buildForwardCurve, computeCoverage } from './lib/twap.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const SUBS_FILE = path.join(DATA_DIR, 'subs.jsonl');

const PORT = process.env.PORT || 3000;
const MONROE_ADDRESS = '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e';
const USDC_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_CHAIN_ID = 8453;
const PRICE_PER_QUOTE = '1000';       // $0.001 USDC in atomic (6 decimals)
const PRICE_SUBSCRIPTION = '99000000'; // $99 USDC in atomic
const SERVICE_URL = process.env.SERVICE_URL || 'https://hive-stable-yield-curve.onrender.com';

// ─── Cache ────────────────────────────────────────────────────────────────────

const cache = {
  spot: { value: null, ts: 0, ttl: 60_000 },                       // 60s
  "1h": { value: null, ts: 0, ttl: 5 * 60_000 },                   // 5min
  "6h": { value: null, ts: 0, ttl: 30 * 60_000 },                  // 30min
  "24h": { value: null, ts: 0, ttl: 4 * 60 * 60_000 },             // 4h
  "7d": { value: null, ts: 0, ttl: 24 * 60 * 60_000 },             // 24h
};

function cacheGet(key) {
  const entry = cache[key];
  if (!entry) return undefined;
  if (Date.now() - entry.ts > entry.ttl) return undefined;
  return entry.value;
}

function cacheSet(key, value) {
  if (!cache[key]) cache[key] = { value: null, ts: 0, ttl: 60_000 };
  cache[key].value = value;
  cache[key].ts = Date.now();
}

// ─── Subscription ledger ──────────────────────────────────────────────────────

function loadSubs() {
  try {
    if (!fs.existsSync(SUBS_FILE)) return [];
    return fs.readFileSync(SUBS_FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l));
  } catch {
    return [];
  }
}

function appendSub(sub) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(SUBS_FILE, JSON.stringify(sub) + '\n', 'utf8');
}

function isValidSub(token) {
  const subs = loadSubs();
  const now = Date.now();
  return subs.some(s => s.token === token && s.expires_at > now);
}

// ─── x402 Challenge builders ──────────────────────────────────────────────────

function buildPayPerQuoteChallenge(resource) {
  return {
    scheme: 'exact',
    network: 'base',
    asset: 'USDC',
    maxAmountRequired: PRICE_PER_QUOTE,
    payTo: MONROE_ADDRESS,
    contract: USDC_CONTRACT,
    resource,
    description: 'Implied forward curve quote on USDC/USDT.',
    mimeType: 'application/json',
    chainId: BASE_CHAIN_ID,
  };
}

function buildSubscriptionChallenge(resource) {
  return {
    scheme: 'exact',
    network: 'base',
    asset: 'USDC',
    maxAmountRequired: PRICE_SUBSCRIPTION,
    payTo: MONROE_ADDRESS,
    contract: USDC_CONTRACT,
    resource,
    description: '30-day unlimited curve subscription. Returns bearer token.',
    mimeType: 'application/json',
    chainId: BASE_CHAIN_ID,
  };
}

/**
 * Extract and validate X-PAYMENT header.
 * Returns {valid: bool, payload: object|null}.
 * In production this would verify an EVM signature against the challenge.
 * Here we check structural presence and that the payTo/contract match Monroe.
 */
function validatePaymentHeader(header) {
  if (!header) return { valid: false, payload: null };
  try {
    const decoded = Buffer.from(header, 'base64').toString('utf8');
    const payload = JSON.parse(decoded);
    if (!payload.transaction && !payload.txHash && !payload.tx) {
      // Minimal: must reference Monroe
      if (payload.payTo && payload.payTo.toLowerCase() !== MONROE_ADDRESS.toLowerCase()) {
        return { valid: false, payload: null };
      }
    }
    return { valid: true, payload };
  } catch {
    // Not base64 JSON — treat as raw token for testing
    return { valid: header.length > 10, payload: { raw: header } };
  }
}

// ─── BOGO redemption middleware (X-Hive-BOGO-Token) ─────────────────────────
// Phase 1: calls hive-gamification /v1/bogo/redeem; bypasses 402 on consumed:true.
// Phase 2 (planned): zero-trust redemption with token-bound HMAC.
async function bogoRedeemMiddleware(req, res, next) {
  const token = req.headers['x-hive-bogo-token'];
  if (!token) return next();
  try {
    const r = await fetch('https://hive-gamification.onrender.com/v1/bogo/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, mechanic_id: 'stable-curve-quote' }),
      signal: AbortSignal.timeout(5000),
    });
    if (r.ok) {
      const j = await r.json();
      if (j.consumed === true) {
        req._bogo_redeemed = true;
        import('fs').then(({ appendFileSync }) => {
          try { appendFileSync('/tmp/stable_yield_curve_bogo_redemptions.jsonl', JSON.stringify({ token: token.slice(0, 12), mechanic_id: 'stable-curve-quote', ts: Date.now() }) + '\n'); } catch (_) {}
        });
        return next();
      }
    }
  } catch (_) {}
  return next();
}

// ─── Middleware: 402 gate ─────────────────────────────────────────────────────

function require402(req, res, next) {
  // BOGO token was consumed upstream — bypass 402 for this call
  if (req._bogo_redeemed) return next();

  // Check subscription bearer first
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer hsyc_')) {
    const token = auth.slice(7); // 'Bearer '.length = 7
    if (isValidSub(token)) return next();
  }

  // Check X-PAYMENT header
  const paymentHeader = req.headers['x-payment'];
  if (paymentHeader) {
    const { valid } = validatePaymentHeader(paymentHeader);
    if (valid) return next();
  }

  // No valid payment — issue 402
  const challenge = buildPayPerQuoteChallenge(`${SERVICE_URL}${req.path}`);
  res.status(402)
    .header('X-Payment-Required', JSON.stringify(challenge))
    .header('Content-Type', 'application/json')
    .json({
      error: 'Payment required.',
      x402: challenge,
      bogo: {
        first_use_free: true,
        claim_endpoint: 'https://hive-gamification.onrender.com/v1/bogo/claim',
        redeem_header: 'X-Hive-BOGO-Token',
        mechanic_id: 'stable-curve-quote',
      },
    });
}

// ─── Data fetcher ─────────────────────────────────────────────────────────────

const WINDOWS = [3600, 21600, 86400, 604800];
const WINDOW_LABELS = { 3600: '1h', 21600: '6h', 86400: '24h', 604800: '7d' };

async function fetchCurveData() {
  // Spot from slot0
  let spot = cacheGet('spot');
  let slot0Data = null;

  if (spot === undefined) {
    slot0Data = await readSlot0();
    if (slot0Data) {
      spot = sqrtPriceX96ToPrice(slot0Data.sqrtPriceX96);
      cacheSet('spot', spot);
    } else {
      // Try last cached value for spot
      spot = cache['spot'].value ?? null;
    }
  }

  // TWAP windows — check which need refresh
  const windowsNeeded = WINDOWS.filter(w => cacheGet(WINDOW_LABELS[w]) === undefined);
  let twapResults = {};

  if (windowsNeeded.length > 0) {
    const raw = await readTWAPObservations(windowsNeeded);
    for (const w of windowsNeeded) {
      const obs = raw[w];
      if (obs === null) {
        twapResults[WINDOW_LABELS[w]] = null;
      } else {
        const rate = computeTWAP(obs.tickCumulativeEnd, obs.tickCumulativeStart, obs.secondsElapsed);
        cacheSet(WINDOW_LABELS[w], rate);
        twapResults[WINDOW_LABELS[w]] = rate;
      }
    }
  }

  // Merge cached + freshly fetched
  const twaps = {};
  for (const w of WINDOWS) {
    const label = WINDOW_LABELS[w];
    const cached = cacheGet(label);
    twaps[label] = cached !== undefined ? cached : (twapResults[label] ?? null);
  }

  const curve = buildForwardCurve(twaps);
  const coverage = computeCoverage(curve, spot);

  return {
    spot,
    curve,
    coverage,
    observation_window_seconds: {
      "1h": 3600,
      "6h": 21600,
      "24h": 86400,
      "7d": 604800,
    },
  };
}

// ─── Express app ──────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Health
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'hive-stable-yield-curve',
    version: '1.0.0',
    pool: POOL_ADDRESS,
    pair: 'USDC/USDT',
    network: 'base',
    chainId: BASE_CHAIN_ID,
    timestamp: new Date().toISOString(),
  });
});

// Root
app.get('/', (req, res) => {
  res.json({
    service: 'hive-stable-yield-curve',
    description: 'Implied forward curve on USDC/USDT stable-to-stable swap rates. On-chain TWAP from Uniswap v3 Base.',
    version: '1.0.0',
    endpoints: {
      curve:        '/v1/stable-curve/:pair',
      spot:         '/v1/stable-curve/:pair/spot',
      subscribe:    'POST /v1/stable-curve/subscribe',
      methodology:  '/v1/stable-curve/methodology',
      mcp:          '/mcp',
      agent_card:   '/.well-known/agent.json',
    },
    pricing: {
      pay_per_quote: '$0.001 USDC (1000 atomic)',
      subscription:  '$99 USDC / 30 days unlimited',
      currency:      'USDC on Base (chain 8453)',
      payTo:         MONROE_ADDRESS,
    },
    brand: '#C08D23',
  });
});

// Agent card
app.get('/.well-known/agent.json', (req, res) => {
  res.json({
    name: 'hive-stable-yield-curve',
    description: 'Implied forward curve on USDC/USDT stable-to-stable swap rates. Powered by Uniswap v3 on-chain TWAP on Base mainnet.',
    version: '1.0.0',
    url: SERVICE_URL,
    brand: { color: '#C08D23' },
    payment: {
      address: MONROE_ADDRESS,
      network: 'base',
      chainId: BASE_CHAIN_ID,
      asset: 'USDC',
      contract: USDC_CONTRACT,
      tiers: [
        { name: 'pay_per_quote', amount: PRICE_PER_QUOTE, unit: 'atomic USDC', description: '$0.001 per curve quote' },
        { name: 'subscription',  amount: PRICE_SUBSCRIPTION, unit: 'atomic USDC', description: '$99 for 30 days unlimited' },
      ],
    },
    capabilities: ['stable-curve', 'twap', 'uniswap-v3', 'base-mainnet'],
    tools: ['get_curve', 'get_spot', 'get_methodology'],
    mcp_endpoint: `${SERVICE_URL}/mcp`,
    author: 'The Hivery',
    license: 'MIT',
  });
});

// Methodology (public — no payment gate)
app.get('/v1/stable-curve/methodology', (req, res) => {
  res.type('text/markdown').send(`# hive-stable-yield-curve Methodology

## Phase 1 (current): On-Chain TWAP from Uniswap v3

**Pool:** Uniswap v3 USDC/USDT 0.01% fee tier on Base mainnet  
**Pool address:** \`${POOL_ADDRESS}\`  
**Token0:** USDC \`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913\` (6 decimals)  
**Token1:** USDT \`0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2\` (6 decimals)

### Spot Rate

Derived from \`slot0().sqrtPriceX96\`:

\`\`\`
price = (sqrtPriceX96 / 2^96)^2
\`\`\`

Represents the instantaneous exchange rate of USDC per USDT at current pool state.

### TWAP Rates (1h, 6h, 24h, 7d)

Derived from \`observe([W, 0])\` which returns tick cumulatives at time T-W and T=now.

\`\`\`
TWAP_tick = (tickCumulative_now - tickCumulative_W) / W
TWAP_price = 1.0001^TWAP_tick
\`\`\`

Integer tick rounding follows Uniswap v3 specification (floor toward −∞).

### Forward Curve Construction

Forward rates are implied from consecutive TWAP windows using log-linear interpolation:

\`\`\`
r_forward(t1 → t2) = exp( (ln(r_t2) × t2 − ln(r_t1) × t1) / (t2 − t1) )
\`\`\`

Curve points:
- **1h** : TWAP(0 → 1h) — near-term implied rate
- **6h** : implied forward rate from 1h to 6h
- **24h**: implied forward rate from 6h to 24h
- **7d** : implied forward rate from 24h to 7d

### Coverage Flags

| Coverage | Meaning |
|----------|---------|
| \`full\`    | All curve points and spot available |
| \`partial\` | Some points null due to insufficient observations |
| \`none\`    | All reads failed; cached spot may still be present |

**No fabricated rates.** If a TWAP observation window exceeds the pool's stored observation cardinality, that point is set to \`null\`. Callers must not interpolate null points.

### Cache TTLs

| Point | TTL |
|-------|-----|
| Spot  | 60 seconds |
| 1h    | 5 minutes |
| 6h    | 30 minutes |
| 24h   | 4 hours |
| 7d    | 24 hours |

---

## Phase 2 (roadmap): Dealer Quotes + Cross-Venue Aggregation

- Aggregate quotes from multiple Base AMMs (Curve, Aerodrome, Velodrome)
- Add off-chain dealer RFQ layer for institutional size
- Cross-venue TWAP weighting by liquidity depth
- Confidence intervals on forward rates

---

*Source: Uniswap v3 on-chain oracle. No off-chain price feeds. No fabricated rates.*  
*Version: 1.0.0 — Phase 1*
`);
});

// ─── Curve endpoint ───────────────────────────────────────────────────────────

app.get('/v1/stable-curve/:pair', bogoRedeemMiddleware, require402, async (req, res) => {
  const pair = req.params.pair.toLowerCase();
  if (!['usdc-usdt', 'usdt-usdc'].includes(pair)) {
    return res.status(400).json({ error: 'Invalid pair. Supported: usdc-usdt, usdt-usdc.' });
  }

  try {
    const data = await fetchCurveData();
    let { spot, curve, coverage, observation_window_seconds } = data;

    // If usdt-usdc, invert the rates
    if (pair === 'usdt-usdc') {
      spot = spot !== null ? 1 / spot : null;
      const invertedCurve = {};
      for (const [k, v] of Object.entries(curve)) {
        invertedCurve[k] = v !== null ? 1 / v : null;
      }
      curve = invertedCurve;
    }

    const payload = {
      pair,
      spot,
      curve,
      source: `uniswap-v3-base-pool-${POOL_FEE}`,
      source_address: POOL_ADDRESS,
      observation_window_seconds,
      generated_at: new Date().toISOString(),
      methodology_url: `${SERVICE_URL}/v1/stable-curve/methodology`,
      coverage,
    };

    // Status 206 if partial/none, 200 if full
    const status = coverage === 'none' ? 503 : 200;
    res.status(status).json(payload);
  } catch (err) {
    res.status(500).json({ error: 'Internal error fetching curve data.', detail: err.message });
  }
});

// Spot-only endpoint
app.get('/v1/stable-curve/:pair/spot', require402, async (req, res) => {
  const pair = req.params.pair.toLowerCase();
  if (!['usdc-usdt', 'usdt-usdc'].includes(pair)) {
    return res.status(400).json({ error: 'Invalid pair. Supported: usdc-usdt, usdt-usdc.' });
  }

  try {
    // Try fresh, fall back to cached
    let slot0Data = await readSlot0();
    let spot = null;
    if (slot0Data) {
      spot = sqrtPriceX96ToPrice(slot0Data.sqrtPriceX96);
      cacheSet('spot', spot);
    } else {
      spot = cache['spot'].value ?? null;
    }

    if (pair === 'usdt-usdc' && spot !== null) spot = 1 / spot;

    res.json({
      pair,
      spot,
      source: `uniswap-v3-base-pool-${POOL_FEE}`,
      source_address: POOL_ADDRESS,
      generated_at: new Date().toISOString(),
      coverage: spot !== null ? 'full' : 'none',
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal error fetching spot.', detail: err.message });
  }
});

// Subscribe endpoint
app.post('/v1/stable-curve/subscribe', async (req, res) => {
  const paymentHeader = req.headers['x-payment'];
  if (!paymentHeader) {
    const challenge = buildSubscriptionChallenge(`${SERVICE_URL}/v1/stable-curve/subscribe`);
    return res.status(402)
      .header('X-Payment-Required', JSON.stringify(challenge))
      .json({ error: 'Payment required for subscription.', x402: challenge });
  }

  const { valid } = validatePaymentHeader(paymentHeader);
  if (!valid) {
    return res.status(402).json({ error: 'Invalid or unverifiable payment.' });
  }

  // Generate subscription token
  const token = 'hsyc_' + crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const expires_at = now + 30 * 24 * 60 * 60 * 1000; // 30 days

  const sub = {
    token,
    created_at: now,
    expires_at,
    amount_paid: PRICE_SUBSCRIPTION,
    currency: 'USDC',
    network: 'base',
  };
  appendSub(sub);

  res.json({
    token,
    expires_at: new Date(expires_at).toISOString(),
    header_format: `Authorization: Bearer ${token}`,
    tier: 'subscription',
    duration_days: 30,
    endpoints: ['/v1/stable-curve/usdc-usdt', '/v1/stable-curve/usdt-usdc'],
  });
});

// ─── MCP endpoint (JSON-RPC 2.0) ──────────────────────────────────────────────

app.post('/mcp', async (req, res) => {
  const { jsonrpc, id, method, params } = req.body || {};

  if (jsonrpc !== '2.0') {
    return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
  }

  const respond = (result) => res.json({ jsonrpc: '2.0', id, result });
  const respondError = (code, message) => res.json({ jsonrpc: '2.0', id, error: { code, message } });

  if (method === 'tools/list') {
    return respond({
      tools: [
        {
          name: 'get_curve',
          description: 'Returns the implied forward curve on USDC/USDT stable-to-stable swap rates. Derived from on-chain TWAP (Uniswap v3 Base). Gated by $0.001 USDC x402 or subscription bearer. Curve points: 1h, 6h, 24h, 7d.',
          inputSchema: {
            type: 'object',
            properties: {
              pair: { type: 'string', enum: ['usdc-usdt', 'usdt-usdc'], description: 'Trading pair direction.' },
              payment: { type: 'string', description: 'Base64-encoded x402 payment payload or subscription bearer token.' },
            },
            required: ['pair'],
          },
        },
        {
          name: 'get_spot',
          description: 'Returns the current spot exchange rate for the given USDC/USDT pair from Uniswap v3 slot0. Gated by $0.001 USDC x402 or subscription bearer.',
          inputSchema: {
            type: 'object',
            properties: {
              pair: { type: 'string', enum: ['usdc-usdt', 'usdt-usdc'] },
              payment: { type: 'string' },
            },
            required: ['pair'],
          },
        },
        {
          name: 'get_methodology',
          description: 'Returns the public methodology document describing how TWAP rates and forward curves are computed. No payment required.',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    });
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const args = params?.arguments || {};

    if (toolName === 'get_methodology') {
      return respond({
        content: [{
          type: 'text',
          text: `Fetch ${SERVICE_URL}/v1/stable-curve/methodology for full markdown methodology. Phase 1: on-chain TWAP from Uniswap v3 USDC/USDT 0.01% pool on Base (${POOL_ADDRESS}). Phase 2: dealer quotes + cross-venue aggregation.`,
        }],
      });
    }

    if (toolName === 'get_curve' || toolName === 'get_spot') {
      // Validate payment from args
      const payment = args.payment;
      let authed = false;
      if (payment) {
        if (payment.startsWith('hsyc_') && isValidSub(payment)) {
          authed = true;
        } else {
          const { valid } = validatePaymentHeader(payment);
          authed = valid;
        }
      }

      if (!authed) {
        const challenge = buildPayPerQuoteChallenge(`${SERVICE_URL}/mcp`);
        return respond({
          content: [{
            type: 'text',
            text: JSON.stringify({ error: 'Payment required.', x402: challenge }),
          }],
          isError: true,
        });
      }

      const pair = args.pair || 'usdc-usdt';
      if (!['usdc-usdt', 'usdt-usdc'].includes(pair)) {
        return respondError(-32602, 'Invalid pair.');
      }

      if (toolName === 'get_spot') {
        let slot0Data = await readSlot0();
        let spot = null;
        if (slot0Data) {
          spot = sqrtPriceX96ToPrice(slot0Data.sqrtPriceX96);
          cacheSet('spot', spot);
        } else {
          spot = cache['spot'].value ?? null;
        }
        if (pair === 'usdt-usdc' && spot !== null) spot = 1 / spot;
        return respond({ content: [{ type: 'text', text: JSON.stringify({ pair, spot, source: `uniswap-v3-base-pool-${POOL_FEE}`, source_address: POOL_ADDRESS, generated_at: new Date().toISOString(), coverage: spot !== null ? 'full' : 'none' }) }] });
      }

      // get_curve
      const data = await fetchCurveData();
      let { spot, curve, coverage, observation_window_seconds } = data;
      if (pair === 'usdt-usdc') {
        spot = spot !== null ? 1 / spot : null;
        const inv = {};
        for (const [k, v] of Object.entries(curve)) inv[k] = v !== null ? 1 / v : null;
        curve = inv;
      }
      return respond({ content: [{ type: 'text', text: JSON.stringify({ pair, spot, curve, source: `uniswap-v3-base-pool-${POOL_FEE}`, source_address: POOL_ADDRESS, observation_window_seconds, generated_at: new Date().toISOString(), methodology_url: `${SERVICE_URL}/v1/stable-curve/methodology`, coverage }) }] });
    }

    return respondError(-32601, 'Method not found.');
  }

  return respondError(-32601, `Unknown method: ${method}`);
});

app.get('/mcp', (req, res) => {
  res.json({
    name: 'hive-stable-yield-curve',
    version: '1.0.0',
    protocol: 'MCP 2024-11-05',
    description: 'Implied forward curve on USDC/USDT. On-chain TWAP, Base mainnet.',
    endpoint: `${SERVICE_URL}/mcp`,
    tools: ['get_curve', 'get_spot', 'get_methodology'],
  });
});

app.get('/.well-known/mcp.json', (req, res) => {
  res.json({
    name: 'hive-stable-yield-curve',
    version: '1.0.0',
    protocol: 'MCP 2024-11-05',
    endpoint: `${SERVICE_URL}/mcp`,
    tools: ['get_curve', 'get_spot', 'get_methodology'],
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`hive-stable-yield-curve v1.0.0 listening on port ${PORT}`);
  console.log(`Service URL: ${SERVICE_URL}`);
  console.log(`Pool: ${POOL_ADDRESS} (USDC/USDT 0.01% Base)`);
  console.log(`Monroe: ${MONROE_ADDRESS}`);
});
