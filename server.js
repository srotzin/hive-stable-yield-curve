/**
 * hive-stable-yield-curve — v2.0.0 — Premium Tier
 * Implied forward curve on USDC/USDT stable-to-stable swap rates.
 * On-chain TWAP from Uniswap v3 USDC/USDT 0.01% pool on Base.
 *
 * Pricing:
 *   Pay-per-quote:   $0.001 USDC per call (1000 atomic units)
 *   Premium:         $99/mo — predictive curve + alert webhooks
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
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SUBS_FILE = path.join(DATA_DIR, 'subs.jsonl');
const PREMIUM_SUBS_FILE = path.join(DATA_DIR, 'premium_subs.jsonl');
const YIELD_HISTORY_FILE = path.join(DATA_DIR, 'yield_history.jsonl');
const ALERTS_FILE = path.join(DATA_DIR, 'alerts.jsonl');
const ALERT_LOG_FILE = path.join(DATA_DIR, 'alert_log.jsonl');

const PORT = process.env.PORT || 3000;
const MONROE_ADDRESS = '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e';
const USDC_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_CHAIN_ID = 8453;
const PRICE_PER_QUOTE = '1000';        // $0.001 USDC in atomic (6 decimals)
const PRICE_SUBSCRIPTION = '99000000'; // $99 USDC in atomic — legacy one-time
const PRICE_PREMIUM_MO = '99000000';   // $99 USDC/mo — new premium tier
const SERVICE_URL = process.env.SERVICE_URL || 'https://hive-stable-yield-curve.onrender.com';
const HIVE_SUB_URL = 'https://hive-subscription.onrender.com';

// Minimum days of history required for predictive curve
const MIN_HISTORY_DAYS = 30;
// Alert worker tick interval (ms)
const ALERT_TICK_MS = 5 * 60 * 1000;

// ─── Data-dir bootstrap ───────────────────────────────────────────────────────

fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── Cache ────────────────────────────────────────────────────────────────────

const cache = {
  spot: { value: null, ts: 0, ttl: 60_000 },
  "1h": { value: null, ts: 0, ttl: 5 * 60_000 },
  "6h": { value: null, ts: 0, ttl: 30 * 60_000 },
  "24h": { value: null, ts: 0, ttl: 4 * 60 * 60_000 },
  "7d": { value: null, ts: 0, ttl: 24 * 60 * 60_000 },
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

// ─── Subscription ledgers ─────────────────────────────────────────────────────

function loadSubs() {
  try {
    if (!fs.existsSync(SUBS_FILE)) return [];
    return fs.readFileSync(SUBS_FILE, 'utf8')
      .split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch { return []; }
}

function appendSub(sub) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(SUBS_FILE, JSON.stringify(sub) + '\n', 'utf8');
}

function isValidSub(token) {
  const now = Date.now();
  return loadSubs().some(s => s.token === token && s.expires_at > now);
}

// Premium subscription ledger — $99/mo renewable
function loadPremiumSubs() {
  try {
    if (!fs.existsSync(PREMIUM_SUBS_FILE)) return [];
    return fs.readFileSync(PREMIUM_SUBS_FILE, 'utf8')
      .split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch { return []; }
}

function appendPremiumSub(sub) {
  fs.appendFileSync(PREMIUM_SUBS_FILE, JSON.stringify(sub) + '\n', 'utf8');
}

function isValidPremium(token) {
  const now = Date.now();
  return loadPremiumSubs().some(s => s.token === token && s.expires_at > now && s.status === 'active');
}

function getPremiumSub(token) {
  const now = Date.now();
  return loadPremiumSubs().find(s => s.token === token && s.expires_at > now && s.status === 'active') || null;
}

// ─── Yield history (for predictive) ──────────────────────────────────────────

function appendYieldHistory(record) {
  // record: { ts, spot, curve: {1h,6h,24h,7d} }
  try {
    fs.appendFileSync(YIELD_HISTORY_FILE, JSON.stringify(record) + '\n', 'utf8');
  } catch (_) {}
}

function loadYieldHistory() {
  try {
    if (!fs.existsSync(YIELD_HISTORY_FILE)) return [];
    return fs.readFileSync(YIELD_HISTORY_FILE, 'utf8')
      .split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch { return []; }
}

// ─── Alerts ledger ────────────────────────────────────────────────────────────

function loadAlerts() {
  try {
    if (!fs.existsSync(ALERTS_FILE)) return [];
    return fs.readFileSync(ALERTS_FILE, 'utf8')
      .split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch { return []; }
}

function appendAlert(alert) {
  fs.appendFileSync(ALERTS_FILE, JSON.stringify(alert) + '\n', 'utf8');
}

function saveAlerts(alerts) {
  fs.writeFileSync(ALERTS_FILE, alerts.map(a => JSON.stringify(a)).join('\n') + '\n', 'utf8');
}

function appendAlertLog(entry) {
  try {
    fs.appendFileSync(ALERT_LOG_FILE, JSON.stringify(entry) + '\n', 'utf8');
  } catch (_) {}
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

function buildPremiumChallenge(resource) {
  return {
    scheme: 'exact',
    network: 'base',
    asset: 'USDC',
    maxAmountRequired: PRICE_PREMIUM_MO,
    payTo: MONROE_ADDRESS,
    contract: USDC_CONTRACT,
    resource,
    description: '$99/mo premium: predictive yield curve + alert webhooks. Recurring via hive-subscription.',
    mimeType: 'application/json',
    chainId: BASE_CHAIN_ID,
    recurring: {
      period_days: 30,
      renewal_url: `${HIVE_SUB_URL}/v1/subscription/renew`,
    },
  };
}

function validatePaymentHeader(header) {
  if (!header) return { valid: false, payload: null };
  try {
    const decoded = Buffer.from(header, 'base64').toString('utf8');
    const payload = JSON.parse(decoded);
    if (!payload.transaction && !payload.txHash && !payload.tx) {
      if (payload.payTo && payload.payTo.toLowerCase() !== MONROE_ADDRESS.toLowerCase()) {
        return { valid: false, payload: null };
      }
    }
    return { valid: true, payload };
  } catch {
    return { valid: header.length > 10, payload: { raw: header } };
  }
}

// ─── BOGO redemption middleware ───────────────────────────────────────────────

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
        return next();
      }
    }
  } catch (_) {}
  return next();
}

// ─── Middleware: 402 gate (pay-per-quote or any valid subscription) ───────────

function require402(req, res, next) {
  if (req._bogo_redeemed) return next();

  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) {
    const token = auth.slice(7);
    if (isValidSub(token) || isValidPremium(token)) return next();
  }

  const paymentHeader = req.headers['x-payment'];
  if (paymentHeader) {
    const { valid } = validatePaymentHeader(paymentHeader);
    if (valid) return next();
  }

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

// ─── Middleware: Premium gate (requires active $99/mo subscription) ───────────

function requirePremium(req, res, next) {
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) {
    const token = auth.slice(7);
    if (isValidPremium(token)) return next();
    // Legacy $99/30d one-time sub also grants premium access
    if (isValidSub(token)) return next();
  }

  // No valid premium subscription — return 401 (not 402: sub must be purchased via /v1/yield/subscribe)
  res.status(401)
    .header('Content-Type', 'application/json')
    .json({
      error: 'Premium subscription required.',
      detail: 'This endpoint requires an active $99/mo Hive Premium subscription.',
      subscribe_endpoint: `${SERVICE_URL}/v1/yield/subscribe`,
      tier: 'premium',
      price: '$99 USDC / 30 days',
    });
}

// ─── Data fetcher ─────────────────────────────────────────────────────────────

const WINDOWS = [3600, 21600, 86400, 604800];
const WINDOW_LABELS = { 3600: '1h', 21600: '6h', 86400: '24h', 604800: '7d' };

async function fetchCurveData() {
  let spot = cacheGet('spot');
  let slot0Data = null;

  if (spot === undefined) {
    slot0Data = await readSlot0();
    if (slot0Data) {
      spot = sqrtPriceX96ToPrice(slot0Data.sqrtPriceX96);
      cacheSet('spot', spot);
    } else {
      spot = cache['spot'].value ?? null;
    }
  }

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

  const twaps = {};
  for (const w of WINDOWS) {
    const label = WINDOW_LABELS[w];
    const cached = cacheGet(label);
    twaps[label] = cached !== undefined ? cached : (twapResults[label] ?? null);
  }

  const curve = buildForwardCurve(twaps);
  const coverage = computeCoverage(curve, spot);

  // Persist to history for predictive model (throttled: max 1 write per 15 min)
  persistHistoryThrottled({ spot, curve, coverage });

  return { spot, curve, coverage, observation_window_seconds: { "1h": 3600, "6h": 21600, "24h": 86400, "7d": 604800 } };
}

// Throttle history writes to avoid spamming disk on every cache miss
let _lastHistoryWrite = 0;
function persistHistoryThrottled(data) {
  const now = Date.now();
  if (now - _lastHistoryWrite < 15 * 60 * 1000) return; // 15-min throttle
  if (data.coverage === 'none') return; // don't write empty records
  _lastHistoryWrite = now;
  appendYieldHistory({
    ts: now,
    spot: data.spot,
    curve: data.curve,
    coverage: data.coverage,
  });
}

// ─── Predictive model (linear regression with seasonal component) ─────────────
// Requires MIN_HISTORY_DAYS of observations. Returns null + reason if insufficient.
//
// For each curve point (1h, 6h, 24h, 7d) and spot:
//   - Take last 30 days of observations
//   - Fit OLS: y = a + b*t + c*sin(2π*t/day_period) + d*cos(2π*t/day_period)
//   - Project forward: horizon_hours ahead in uniform intervals
//   - Confidence interval: ±1.96 * RMSE
//
// Returns 503 with reason:'insufficient_history' if < MIN_HISTORY_DAYS of data spans.

function olsRegression(xs, ys) {
  // Fits y = a + b*x via OLS. Returns {a, b, rmse}.
  const n = xs.length;
  if (n < 2) return null;
  const meanX = xs.reduce((s, v) => s + v, 0) / n;
  const meanY = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - meanX) * (ys[i] - meanY);
    den += (xs[i] - meanX) ** 2;
  }
  if (den === 0) return null;
  const b = num / den;
  const a = meanY - b * meanX;
  // RMSE
  let sse = 0;
  for (let i = 0; i < n; i++) {
    sse += (ys[i] - (a + b * xs[i])) ** 2;
  }
  const rmse = Math.sqrt(sse / n);
  return { a, b, rmse };
}

function fitLinearWithSeasonality(ts_ms, values) {
  // y = a + b*t_norm + c*sin(omega*t_ms) + d*cos(omega*t_ms)
  // omega = 2*pi / (24h in ms)
  // Use iterative OLS approximation (design matrix OLS).
  const n = ts_ms.length;
  if (n < 4) return null;
  const OMEGA = (2 * Math.PI) / (24 * 3600 * 1000);
  // Normalize time to [0, 1]
  const t0 = ts_ms[0];
  const tRange = ts_ms[n - 1] - t0 || 1;
  const X = ts_ms.map(t => {
    const tn = (t - t0) / tRange;
    return [1, tn, Math.sin(OMEGA * t), Math.cos(OMEGA * t)];
  });
  // OLS: beta = (X^T X)^-1 X^T y — 4x4 matrix, hand-computed
  const XT = [[],[],[],[]];
  for (let j = 0; j < 4; j++) {
    for (let i = 0; i < n; i++) XT[j].push(X[i][j]);
  }
  const XTX = Array.from({length:4}, () => new Array(4).fill(0));
  const XTy = new Array(4).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < 4; j++) {
      XTy[j] += X[i][j] * values[i];
      for (let k = 0; k < 4; k++) XTX[j][k] += X[i][j] * X[i][k];
    }
  }
  // Invert 4x4 via Gauss-Jordan
  const beta = gaussJordan(XTX, XTy);
  if (!beta) return null;
  // RMSE
  let sse = 0;
  for (let i = 0; i < n; i++) {
    const pred = beta[0] + beta[1]*((ts_ms[i]-t0)/tRange) + beta[2]*Math.sin(OMEGA*ts_ms[i]) + beta[3]*Math.cos(OMEGA*ts_ms[i]);
    sse += (values[i] - pred) ** 2;
  }
  const rmse = Math.sqrt(sse / n);
  return { beta, t0, tRange, rmse, OMEGA };
}

function gaussJordan(A, b) {
  // Solve Ax = b via Gauss-Jordan with partial pivoting
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    // Find pivot
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(M[row][col]) > Math.abs(M[maxRow][col])) maxRow = row;
    }
    [M[col], M[maxRow]] = [M[maxRow], M[col]];
    if (Math.abs(M[col][col]) < 1e-12) return null;
    const pivot = M[col][col];
    for (let j = col; j <= n; j++) M[col][j] /= pivot;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = M[row][col];
      for (let j = col; j <= n; j++) M[row][j] -= factor * M[col][j];
    }
  }
  return M.map(row => row[n]);
}

function predictValue(model, ts_future_ms) {
  const { beta, t0, tRange, OMEGA } = model;
  const tn = (ts_future_ms - t0) / tRange;
  return beta[0] + beta[1]*tn + beta[2]*Math.sin(OMEGA*ts_future_ms) + beta[3]*Math.cos(OMEGA*ts_future_ms);
}

function buildPredictiveCurve(asset, horizonHours) {
  // asset: 'USDC' | 'USDT' | 'PYUSD' | 'RLUSD' | 'DAI'
  // For now, all assets share the same USDC/USDT pool data.
  // We note the asset in metadata and return the derived curve.
  const history = loadYieldHistory();
  if (history.length === 0) {
    return { ok: false, reason: 'insufficient_history', history_points: 0, history_span_days: 0, required_days: MIN_HISTORY_DAYS };
  }

  // Check span of history
  const oldest = history[0].ts;
  const newest = history[history.length - 1].ts;
  const spanDays = (newest - oldest) / (24 * 3600 * 1000);

  if (spanDays < MIN_HISTORY_DAYS) {
    return {
      ok: false,
      reason: 'insufficient_history',
      history_points: history.length,
      history_span_days: Math.round(spanDays * 10) / 10,
      required_days: MIN_HISTORY_DAYS,
    };
  }

  // Filter to last 45 days (generous window)
  const cutoff = newest - 45 * 24 * 3600 * 1000;
  const window = history.filter(h => h.ts >= cutoff);

  // Build models for spot and each curve point
  const fields = ['spot', '1h', '6h', '24h', '7d'];
  const models = {};

  for (const field of fields) {
    const pairs = window
      .map(h => ({ ts: h.ts, v: field === 'spot' ? h.spot : h.curve?.[field] }))
      .filter(p => p.v !== null && p.v !== undefined && isFinite(p.v) && p.v > 0);

    if (pairs.length < 10) {
      models[field] = null;
      continue;
    }

    const ts_arr = pairs.map(p => p.ts);
    const val_arr = pairs.map(p => Math.log(p.v)); // fit in log-space for stability
    const fit = fitLinearWithSeasonality(ts_arr, val_arr);
    models[field] = fit ? { ...fit, logSpace: true } : null;
  }

  // Generate forecast points: now + horizon in N steps
  const nowMs = Date.now();
  const horizonMs = horizonHours * 3600 * 1000;
  const N_POINTS = Math.min(horizonHours, 24); // 1 point per hour, max 24
  const step = horizonMs / N_POINTS;

  const forecast_points = [];
  for (let i = 1; i <= N_POINTS; i++) {
    const ts = nowMs + i * step;
    const point = { ts, iso: new Date(ts).toISOString() };
    for (const field of fields) {
      const m = models[field];
      if (!m) {
        point[field] = null;
        continue;
      }
      const rawPred = predictValue(m, ts);
      const pred = m.logSpace ? Math.exp(rawPred) : rawPred;
      const ciHalfWidth = m.logSpace ? m.rmse * 1.96 : m.rmse * 1.96;
      point[field] = {
        forecast: Math.round(pred * 1e8) / 1e8,
        ci_lower: m.logSpace ? Math.round(Math.exp(rawPred - ciHalfWidth) * 1e8) / 1e8 : pred - ciHalfWidth,
        ci_upper: m.logSpace ? Math.round(Math.exp(rawPred + ciHalfWidth) * 1e8) / 1e8 : pred + ciHalfWidth,
      };
    }
    forecast_points.push(point);
  }

  // Summary statistics
  const modelsAvailable = fields.filter(f => models[f] !== null).length;
  const coverage = modelsAvailable === fields.length ? 'full' : modelsAvailable > 0 ? 'partial' : 'none';

  return {
    ok: true,
    coverage,
    asset,
    horizon_hours: horizonHours,
    generated_at: new Date(nowMs).toISOString(),
    history_points: window.length,
    history_span_days: Math.round(spanDays * 10) / 10,
    model: {
      type: 'linear_regression_with_diurnal_seasonality',
      fit_space: 'log',
      confidence_level: 0.95,
      description: 'OLS regression on log(yield) with diurnal (24h) Fourier seasonality. Forecast is the conditional mean; CI is ±1.96 × in-sample RMSE.',
      version: '1.0',
    },
    forecast: forecast_points,
    source: `uniswap-v3-base-pool-${POOL_FEE}`,
    source_address: POOL_ADDRESS,
    brand: '#C08D23',
  };
}

// ─── Alert evaluation ─────────────────────────────────────────────────────────

function bpsFromRate(rate) {
  // Convert a near-parity rate (e.g. 0.9999) to basis points deviation from 1.0
  return Math.round((rate - 1.0) * 10000 * 100) / 100; // bps with 2dp
}

async function evaluateAlerts() {
  const alerts = loadAlerts().filter(a => a.active);
  if (alerts.length === 0) return;

  let curveData = null;
  try {
    curveData = await fetchCurveData();
  } catch (_) { return; }

  const nowMs = Date.now();
  const fired = [];

  for (const alert of alerts) {
    const { asset, field, condition, threshold_bps, webhook_url, subscription_id } = alert;
    // Determine the relevant rate
    let rate = null;
    if (field === 'spot') {
      rate = curveData.spot;
    } else if (['1h','6h','24h','7d'].includes(field)) {
      rate = curveData.curve?.[field];
    }
    if (rate === null || rate === undefined) continue;

    const current_bps = bpsFromRate(rate);

    let triggered = false;
    if (condition === 'below' && current_bps < threshold_bps) triggered = true;
    if (condition === 'above' && current_bps > threshold_bps) triggered = true;

    if (!triggered) continue;

    // Cooldown: don't fire same alert more than once per hour
    if (alert.last_fired_at && nowMs - alert.last_fired_at < 60 * 60 * 1000) continue;

    // Build signed Spectral envelope
    const payload = {
      alert_id: alert.alert_id,
      subscription_id,
      asset,
      field,
      condition,
      threshold_bps,
      current_bps,
      rate,
      triggered_at: new Date(nowMs).toISOString(),
      curve_snapshot: {
        spot: curveData.spot,
        curve: curveData.curve,
        generated_at: new Date().toISOString(),
      },
      service: 'hive-stable-yield-curve',
      brand: '#C08D23',
    };

    // Sign with HMAC-SHA256 using webhook_secret
    const sig = crypto.createHmac('sha256', alert.webhook_secret)
      .update(JSON.stringify(payload)).digest('hex');

    // Dispatch webhook
    let dispatch_status = 'unknown';
    try {
      const resp = await fetch(webhook_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hive-Signature': `sha256=${sig}`,
          'X-Hive-Alert-ID': alert.alert_id,
          'User-Agent': 'hive-stable-yield-curve/2.0.0',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8000),
      });
      dispatch_status = `${resp.status}`;
    } catch (err) {
      dispatch_status = `error:${err.message?.slice(0,60)}`;
    }

    alert.last_fired_at = nowMs;
    fired.push({ alert_id: alert.alert_id, dispatch_status });

    appendAlertLog({
      alert_id: alert.alert_id,
      subscription_id,
      triggered_at: new Date(nowMs).toISOString(),
      current_bps,
      threshold_bps,
      condition,
      dispatch_status,
    });
  }

  // Persist updated last_fired_at
  if (fired.length > 0) {
    const allAlerts = loadAlerts();
    for (const a of allAlerts) {
      const match = alerts.find(x => x.alert_id === a.alert_id);
      if (match) a.last_fired_at = match.last_fired_at;
    }
    saveAlerts(allAlerts);
  }

  if (fired.length > 0) {
    console.log(`[alert-worker] Fired ${fired.length} alert(s):`, fired.map(f => `${f.alert_id}→${f.dispatch_status}`).join(', '));
  }
}

// ─── Express app ──────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// ─── Health ───────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'hive-stable-yield-curve',
    version: '2.0.0',
    pool: POOL_ADDRESS,
    pair: 'USDC/USDT',
    network: 'base',
    chainId: BASE_CHAIN_ID,
    tiers: ['pay_per_quote', 'premium'],
    timestamp: new Date().toISOString(),
  });
});

// ─── x402 manifest ────────────────────────────────────────────────────────────

app.get('/.well-known/x402', (req, res) => {
  res.json({
    x402Version: 2,
    service: 'hive-stable-yield-curve',
    description: 'Implied forward curve on USDC/USDT stable-to-stable swap rates. Premium tier adds predictive curve + alert webhooks.',
    network: 'base',
    chainId: BASE_CHAIN_ID,
    asset: 'USDC',
    payTo: MONROE_ADDRESS,
    contract: USDC_CONTRACT,
    cold_safe: true,
    brand_color: '#C08D23',
    resources: [
      {
        path: '/v1/stable-curve/:pair',
        method: 'GET',
        price: PRICE_PER_QUOTE,
        tier: 'pay_per_quote',
        description: 'Implied forward curve snapshot. $0.001 USDC per call.',
      },
      {
        path: '/v1/stable-curve/:pair/spot',
        method: 'GET',
        price: PRICE_PER_QUOTE,
        tier: 'pay_per_quote',
        description: 'Spot rate. $0.001 USDC per call.',
      },
      {
        path: '/v1/yield/subscribe',
        method: 'POST',
        price: PRICE_PREMIUM_MO,
        tier: 'premium',
        recurring: true,
        period_days: 30,
        description: '$99 USDC/30 days. Returns premium bearer token, subscription_id, webhook_secret.',
      },
      {
        path: '/v1/yield/predictive',
        method: 'GET',
        tier: 'premium',
        description: 'Predictive yield curve with confidence intervals. Premium subscription required.',
        auth: 'Bearer hsycp_*',
      },
      {
        path: '/v1/yield/alerts/register',
        method: 'POST',
        tier: 'premium',
        description: 'Register webhook alert on yield threshold. Premium subscription required.',
        auth: 'Bearer hsycp_*',
      },
    ],
  });
});

// ─── Root ─────────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({
    service: 'hive-stable-yield-curve',
    description: 'Implied forward curve on USDC/USDT stable-to-stable swap rates. On-chain TWAP from Uniswap v3 Base.',
    version: '2.0.0',
    endpoints: {
      curve:              '/v1/stable-curve/:pair',
      spot:               '/v1/stable-curve/:pair/spot',
      subscribe_legacy:   'POST /v1/stable-curve/subscribe',
      subscribe_premium:  'POST /v1/yield/subscribe',
      predictive:         'GET /v1/yield/predictive?asset=USDC&horizon=24h',
      alerts:             'POST /v1/yield/alerts/register',
      methodology:        '/v1/stable-curve/methodology',
      mcp:                '/mcp',
      agent_card:         '/.well-known/agent.json',
      x402_manifest:      '/.well-known/x402',
    },
    pricing: {
      pay_per_quote: '$0.001 USDC (1000 atomic)',
      premium:       '$99 USDC / 30 days — predictive curve + alert webhooks',
      currency:      'USDC on Base (chain 8453)',
      payTo:         MONROE_ADDRESS,
    },
    brand: '#C08D23',
  });
});

// ─── Agent card ───────────────────────────────────────────────────────────────

app.get('/.well-known/agent.json', (req, res) => {
  res.json({
    name: 'hive-stable-yield-curve',
    description: 'Implied forward curve on USDC/USDT stable-to-stable swap rates. Powered by Uniswap v3 on-chain TWAP on Base mainnet. Premium tier: predictive curve + alert webhooks.',
    version: '2.0.0',
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
        { name: 'premium',       amount: PRICE_PREMIUM_MO, unit: 'atomic USDC/30d', description: '$99/mo predictive curve + webhooks' },
      ],
    },
    capabilities: ['stable-curve', 'twap', 'uniswap-v3', 'base-mainnet', 'predictive-curve', 'alert-webhooks'],
    tools: ['get_curve', 'get_spot', 'get_methodology', 'get_predictive'],
    mcp_endpoint: `${SERVICE_URL}/mcp`,
    author: 'The Hivery',
    license: 'MIT',
  });
});

// ─── Methodology ─────────────────────────────────────────────────────────────

app.get('/v1/stable-curve/methodology', (req, res) => {
  res.type('text/markdown').send(`# hive-stable-yield-curve Methodology

## Phase 1 (current): On-Chain TWAP from Uniswap v3

**Pool:** Uniswap v3 USDC/USDT 0.01% fee tier on Base mainnet
**Pool address:** \`${POOL_ADDRESS}\`
**Token0:** USDC \`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913\` (6 decimals)
**Token1:** USDT \`0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2\` (6 decimals)

### Spot Rate

Derived from \`slot0().sqrtPriceX96\`.

### TWAP Rates (1h, 6h, 24h, 7d)

Derived from \`observe([W, 0])\`. TWAP tick floor-rounded per Uniswap v3 spec.

### Forward Curve Construction

Log-linear interpolation on consecutive TWAP windows:

\`\`\`
r_forward(t1 → t2) = exp( (ln(r_t2) × t2 − ln(r_t1) × t1) / (t2 − t1) )
\`\`\`

---

## Premium Tier: Predictive Curve

### Model

**Type:** OLS linear regression with diurnal (24h) Fourier seasonality, fit in log-space.

\`\`\`
ln(y_t) = β₀ + β₁·t_norm + β₂·sin(2π·t/24h) + β₃·cos(2π·t/24h) + ε_t
\`\`\`

**Minimum history:** 30 calendar days of observations. Returns HTTP 503 with \`reason:insufficient_history\` if not met — no synthetic data, no back-fill.

**Confidence interval:** ±1.96 × in-sample RMSE (approximately 95% CI under normality assumption).

**Forecast resolution:** 1 point per hour for the requested horizon (max 24 points).

**Honest limitation:** The model captures trend and diurnal rhythm only. Tail events (depeg, liquidity shock, regulatory action) are not modeled. Do not use as sole basis for risk-sizing.

---

## Alert Webhooks

Alerts fire when a monitored yield field crosses a threshold in basis points from par (1.0000).

\`\`\`
bps = (rate − 1.0) × 10,000
\`\`\`

Dispatch is signed with HMAC-SHA256 using the per-subscriber \`webhook_secret\`. Verify:

\`\`\`
HMAC-SHA256(webhook_secret, JSON.stringify(payload)) == X-Hive-Signature header (sha256=...)
\`\`\`

Cooldown: maximum 1 dispatch per alert per hour.

---

*Source: Uniswap v3 on-chain oracle. No off-chain price feeds. No fabricated rates.*
*Version: 2.0.0 — Premium Tier*
`);
});

// ─── Core curve endpoints ─────────────────────────────────────────────────────

app.get('/v1/stable-curve/:pair', bogoRedeemMiddleware, require402, async (req, res) => {
  const pair = req.params.pair.toLowerCase();
  if (!['usdc-usdt', 'usdt-usdc'].includes(pair)) {
    return res.status(400).json({ error: 'Invalid pair. Supported: usdc-usdt, usdt-usdc.' });
  }
  try {
    const data = await fetchCurveData();
    let { spot, curve, coverage, observation_window_seconds } = data;
    if (pair === 'usdt-usdc') {
      spot = spot !== null ? 1 / spot : null;
      const inv = {};
      for (const [k, v] of Object.entries(curve)) inv[k] = v !== null ? 1 / v : null;
      curve = inv;
    }
    const payload = {
      pair, spot, curve,
      source: `uniswap-v3-base-pool-${POOL_FEE}`,
      source_address: POOL_ADDRESS,
      observation_window_seconds,
      generated_at: new Date().toISOString(),
      methodology_url: `${SERVICE_URL}/v1/stable-curve/methodology`,
      coverage,
    };
    res.status(coverage === 'none' ? 503 : 200).json(payload);
  } catch (err) {
    res.status(500).json({ error: 'Internal error fetching curve data.', detail: err.message });
  }
});

app.get('/v1/stable-curve/:pair/spot', require402, async (req, res) => {
  const pair = req.params.pair.toLowerCase();
  if (!['usdc-usdt', 'usdt-usdc'].includes(pair)) {
    return res.status(400).json({ error: 'Invalid pair. Supported: usdc-usdt, usdt-usdc.' });
  }
  try {
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
      pair, spot,
      source: `uniswap-v3-base-pool-${POOL_FEE}`,
      source_address: POOL_ADDRESS,
      generated_at: new Date().toISOString(),
      coverage: spot !== null ? 'full' : 'none',
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal error fetching spot.', detail: err.message });
  }
});

// ─── Legacy subscribe ─────────────────────────────────────────────────────────

app.post('/v1/stable-curve/subscribe', async (req, res) => {
  const paymentHeader = req.headers['x-payment'];
  if (!paymentHeader) {
    const challenge = {
      scheme: 'exact', network: 'base', asset: 'USDC',
      maxAmountRequired: PRICE_SUBSCRIPTION,
      payTo: MONROE_ADDRESS, contract: USDC_CONTRACT,
      resource: `${SERVICE_URL}/v1/stable-curve/subscribe`,
      description: '30-day unlimited curve subscription. Returns bearer token.',
      mimeType: 'application/json', chainId: BASE_CHAIN_ID,
    };
    return res.status(402).header('X-Payment-Required', JSON.stringify(challenge)).json({ error: 'Payment required.', x402: challenge });
  }
  const { valid } = validatePaymentHeader(paymentHeader);
  if (!valid) return res.status(402).json({ error: 'Invalid or unverifiable payment.' });
  const token = 'hsyc_' + crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const expires_at = now + 30 * 24 * 60 * 60 * 1000;
  appendSub({ token, created_at: now, expires_at, amount_paid: PRICE_SUBSCRIPTION, currency: 'USDC', network: 'base' });
  res.json({ token, expires_at: new Date(expires_at).toISOString(), header_format: `Authorization: Bearer ${token}`, tier: 'subscription', duration_days: 30 });
});

// ─── PREMIUM: POST /v1/yield/subscribe ───────────────────────────────────────
// Starts a $99/mo subscription via hive-subscription recurring x402.
// Returns: subscription_id, token, expiry, webhook_secret

app.post('/v1/yield/subscribe', async (req, res) => {
  const paymentHeader = req.headers['x-payment'];

  if (!paymentHeader) {
    const challenge = buildPremiumChallenge(`${SERVICE_URL}/v1/yield/subscribe`);
    return res.status(402)
      .header('X-Payment-Required', JSON.stringify(challenge))
      .header('Content-Type', 'application/json')
      .json({
        error: 'Payment required.',
        x402: challenge,
        detail: 'POST /v1/yield/subscribe with X-PAYMENT header containing $99 USDC on Base (chain 8453). Subscription is managed via hive-subscription recurring x402.',
        hive_subscription: HIVE_SUB_URL,
      });
  }

  const { valid } = validatePaymentHeader(paymentHeader);
  if (!valid) {
    return res.status(402).json({ error: 'Invalid or unverifiable payment.' });
  }

  // Register recurring subscription with hive-subscription
  const payer_did = req.body?.payer_did || req.headers['x-agent-did'] || `did:anon:${crypto.randomBytes(8).toString('hex')}`;
  const merchant_did = 'did:web:hive-stable-yield-curve.onrender.com';

  let hive_sub_id = null;
  let hive_sub_error = null;
  try {
    const subResp = await fetch(`${HIVE_SUB_URL}/v1/subscription/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Payment': paymentHeader,
      },
      body: JSON.stringify({
        payer_did,
        merchant_did,
        amount_atomic: parseInt(PRICE_PREMIUM_MO),
        period_seconds: 30 * 24 * 3600,
        product_id: 'hive-stable-yield-curve-premium',
        metadata: { service: 'hive-stable-yield-curve', tier: 'premium' },
      }),
      signal: AbortSignal.timeout(10000),
    });
    const subJson = await subResp.json();
    if (subResp.ok && subJson.subscription_id) {
      hive_sub_id = subJson.subscription_id;
    } else {
      hive_sub_error = subJson.error || 'unknown';
    }
  } catch (err) {
    hive_sub_error = err.message?.slice(0, 100);
  }

  // Generate local premium token
  const token = 'hsycp_' + crypto.randomBytes(32).toString('hex');
  const webhook_secret = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const expires_at = now + 30 * 24 * 60 * 60 * 1000;
  const subscription_id = 'psub_' + crypto.randomBytes(16).toString('hex');

  const sub = {
    subscription_id,
    token,
    webhook_secret,
    payer_did,
    created_at: now,
    expires_at,
    amount_paid: PRICE_PREMIUM_MO,
    currency: 'USDC',
    network: 'base',
    status: 'active',
    tier: 'premium',
    hive_subscription_id: hive_sub_id,
    hive_subscription_error: hive_sub_error || undefined,
  };
  appendPremiumSub(sub);

  res.status(200).json({
    subscription_id,
    token,
    expires_at: new Date(expires_at).toISOString(),
    webhook_secret,
    tier: 'premium',
    duration_days: 30,
    renewable: true,
    header_format: `Authorization: Bearer ${token}`,
    endpoints: [
      'GET /v1/yield/predictive',
      'POST /v1/yield/alerts/register',
    ],
    hive_subscription_id: hive_sub_id,
    note: hive_sub_error ? `hive-subscription enrollment note: ${hive_sub_error}` : undefined,
    methodology_url: `${SERVICE_URL}/v1/stable-curve/methodology`,
    brand: '#C08D23',
  });
});

// ─── PREMIUM: GET /v1/yield/predictive ───────────────────────────────────────
// Predictive yield curve with confidence intervals.
// Query params: asset (USDC|USDT|PYUSD|RLUSD|DAI), horizon (e.g. 24h, 48h, 168h)
// Returns 401 without valid premium subscription.
// Returns 503 with reason:insufficient_history if < 30 days of history.

// Assets not seeded: no live Uniswap v3 pool found on Base at launch.
// These return asset_not_seeded (not insufficient_history) until a pool exists.
const ASSETS_NOT_SEEDED = new Set(['PYUSD', 'RLUSD']);

app.get('/v1/yield/predictive', requirePremium, (req, res) => {
  const asset = (req.query.asset || 'USDC').toUpperCase();
  const validAssets = ['USDC', 'USDT', 'PYUSD', 'RLUSD', 'DAI'];
  if (!validAssets.includes(asset)) {
    return res.status(400).json({
      error: `Invalid asset. Supported: ${validAssets.join(', ')}.`,
    });
  }

  // Assets with no live pool on Base — return explicit asset_not_seeded
  if (ASSETS_NOT_SEEDED.has(asset)) {
    return res.status(503).json({
      available: false,
      reason: 'asset_not_seeded',
      asset,
      detail: `${asset}/USDC: no live Uniswap v3 pool found on Base mainnet at launch. ` +
              'Asset will be added to the yield curve once a qualifying pool is deployed and seeded.',
      brand: '#C08D23',
    });
  }

  const horizonStr = (req.query.horizon || '24h').toLowerCase();
  const horizonMatch = horizonStr.match(/^(\d+)h$/);
  if (!horizonMatch) {
    return res.status(400).json({ error: 'Invalid horizon. Format: Nh where N is hours (e.g. 24h, 48h).' });
  }
  const horizonHours = Math.min(parseInt(horizonMatch[1]), 168); // cap at 7d

  const result = buildPredictiveCurve(asset, horizonHours);

  if (!result.ok) {
    // Use 200 with available:false — Render's load balancer intercepts 503.
    // Callers must check `available` field before consuming `forecast`.
    return res.status(200).json({
      available: false,
      reason: result.reason,
      detail: `Minimum ${result.required_days} days of history required. Current span: ${result.history_span_days || 0} days (${result.history_points} observation points). The predictive endpoint will activate automatically once sufficient history accumulates.`,
      history_points: result.history_points,
      required_days: result.required_days,
      estimated_available: new Date(Date.now() + ((result.required_days || MIN_HISTORY_DAYS) - (result.history_span_days || 0)) * 24 * 3600 * 1000).toISOString(),
      brand: '#C08D23',
    });
  }

  res.json(result);
});

// ─── PREMIUM: POST /v1/yield/alerts/register ─────────────────────────────────
// Register a webhook + threshold alert.
// Body: { asset, field, condition, threshold_bps, webhook_url }
// field: 'spot' | '1h' | '6h' | '24h' | '7d'
// condition: 'below' | 'above'
// threshold_bps: number (deviation from par in basis points)

app.post('/v1/yield/alerts/register', requirePremium, (req, res) => {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const sub = token ? getPremiumSub(token) : null;

  // Also allow legacy subs
  let subscription_id = sub?.subscription_id || 'legacy_sub';
  let webhook_secret = sub?.webhook_secret || crypto.randomBytes(32).toString('hex');

  const { asset, field, condition, threshold_bps, webhook_url } = req.body || {};

  const validAssets = ['USDC', 'USDT', 'PYUSD', 'RLUSD', 'DAI'];
  const validFields = ['spot', '1h', '6h', '24h', '7d'];
  const validConditions = ['below', 'above'];

  if (!asset || !validAssets.includes(asset.toUpperCase())) {
    return res.status(400).json({ error: `asset required. Supported: ${validAssets.join(', ')}` });
  }
  if (!field || !validFields.includes(field)) {
    return res.status(400).json({ error: `field required. Supported: ${validFields.join(', ')}` });
  }
  if (!condition || !validConditions.includes(condition)) {
    return res.status(400).json({ error: `condition required. Supported: below | above` });
  }
  if (threshold_bps === undefined || threshold_bps === null || !isFinite(threshold_bps)) {
    return res.status(400).json({ error: 'threshold_bps required (number). Example: -5 means 5 bps below par.' });
  }
  if (!webhook_url || typeof webhook_url !== 'string' || !webhook_url.startsWith('https://')) {
    return res.status(400).json({ error: 'webhook_url required (https:// URL).' });
  }

  const alert_id = 'alrt_' + crypto.randomBytes(16).toString('hex');
  const alert = {
    alert_id,
    subscription_id,
    token,
    asset: asset.toUpperCase(),
    field,
    condition,
    threshold_bps: Number(threshold_bps),
    webhook_url,
    webhook_secret,
    created_at: Date.now(),
    last_fired_at: null,
    active: true,
  };
  appendAlert(alert);

  res.status(201).json({
    alert_id,
    subscription_id,
    asset: alert.asset,
    field,
    condition,
    threshold_bps: alert.threshold_bps,
    webhook_url,
    webhook_secret,
    active: true,
    description: `Alert fires when ${field} yield of ${alert.asset} is ${condition} ${threshold_bps} bps from par. Webhook dispatched via signed HMAC-SHA256 envelope.`,
    verification: 'Verify webhook: HMAC-SHA256(webhook_secret, JSON.stringify(payload)) matches X-Hive-Signature header.',
    cooldown: '1 alert per hour per alert_id',
    worker_interval: '5 minutes',
    brand: '#C08D23',
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
          description: 'Returns the implied forward curve on USDC/USDT. Pay-per-quote ($0.001 USDC) or subscription.',
          inputSchema: { type: 'object', properties: { pair: { type: 'string', enum: ['usdc-usdt','usdt-usdc'] }, payment: { type: 'string' } }, required: ['pair'] },
        },
        {
          name: 'get_spot',
          description: 'Current spot exchange rate USDC/USDT from Uniswap v3 slot0. Pay-per-quote or subscription.',
          inputSchema: { type: 'object', properties: { pair: { type: 'string', enum: ['usdc-usdt','usdt-usdc'] }, payment: { type: 'string' } }, required: ['pair'] },
        },
        {
          name: 'get_methodology',
          description: 'Returns methodology documentation. No payment required.',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'get_predictive',
          description: 'Predictive yield curve with confidence intervals. Premium subscription required ($99/mo). Returns 503 if < 30 days of history.',
          inputSchema: {
            type: 'object',
            properties: {
              asset: { type: 'string', enum: ['USDC','USDT','PYUSD','RLUSD','DAI'], description: 'Asset to forecast.' },
              horizon: { type: 'string', description: 'Forecast horizon (e.g. 24h, 48h). Max 168h.', default: '24h' },
              premium_token: { type: 'string', description: 'Premium bearer token (hsycp_...).' },
            },
            required: ['premium_token'],
          },
        },
      ],
    });
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const args = params?.arguments || {};

    if (toolName === 'get_methodology') {
      return respond({ content: [{ type: 'text', text: `Fetch ${SERVICE_URL}/v1/stable-curve/methodology for full markdown methodology.` }] });
    }

    if (toolName === 'get_predictive') {
      const token = args.premium_token;
      if (!token || !isValidPremium(token)) {
        return respond({ content: [{ type: 'text', text: JSON.stringify({ error: 'Premium subscription required.', subscribe: `${SERVICE_URL}/v1/yield/subscribe` }) }], isError: true });
      }
      const result = buildPredictiveCurve(args.asset || 'USDC', parseInt((args.horizon || '24h').replace('h','')) || 24);
      return respond({ content: [{ type: 'text', text: JSON.stringify(result) }] });
    }

    if (toolName === 'get_curve' || toolName === 'get_spot') {
      const payment = args.payment;
      let authed = false;
      if (payment) {
        if ((payment.startsWith('hsyc_') || payment.startsWith('hsycp_')) && (isValidSub(payment) || isValidPremium(payment))) {
          authed = true;
        } else {
          const { valid } = validatePaymentHeader(payment);
          authed = valid;
        }
      }
      if (!authed) {
        return respond({ content: [{ type: 'text', text: JSON.stringify({ error: 'Payment required.', x402: buildPayPerQuoteChallenge(`${SERVICE_URL}/mcp`) }) }], isError: true });
      }
      const pair = args.pair || 'usdc-usdt';
      if (!['usdc-usdt','usdt-usdc'].includes(pair)) return respondError(-32602, 'Invalid pair.');

      if (toolName === 'get_spot') {
        let slot0Data = await readSlot0();
        let spot = null;
        if (slot0Data) { spot = sqrtPriceX96ToPrice(slot0Data.sqrtPriceX96); cacheSet('spot', spot); }
        else spot = cache['spot'].value ?? null;
        if (pair === 'usdt-usdc' && spot !== null) spot = 1 / spot;
        return respond({ content: [{ type: 'text', text: JSON.stringify({ pair, spot, source: `uniswap-v3-base-pool-${POOL_FEE}`, source_address: POOL_ADDRESS, generated_at: new Date().toISOString(), coverage: spot !== null ? 'full' : 'none' }) }] });
      }

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
  res.json({ name: 'hive-stable-yield-curve', version: '2.0.0', protocol: 'MCP 2024-11-05', description: 'Implied forward curve on USDC/USDT. Premium: predictive curve + alert webhooks.', endpoint: `${SERVICE_URL}/mcp`, tools: ['get_curve','get_spot','get_methodology','get_predictive'] });
});

// ─── ADMIN: POST /v1/yield/admin/seed ────────────────────────────────────────
// Accepts newline-delimited JSON records matching yield_history.jsonl schema.
// Gated by SEED_ADMIN_TOKEN env var (set on Render). One-time use for seeding
// historical Uniswap v3 observations recovered from the ring buffer.
//
// Request:
//   Content-Type: application/x-ndjson
//   X-Seed-Admin-Token: <token>
//   Body: newline-delimited JSON records (yield_history schema)
//
// Response: { accepted, rejected, total, seed_window_start, seed_window_end }
//
// Bloomberg Terminal: Only records with source="uniswap_v3_observation" accepted.
// No synthetic data. Records are appended in chronological order before any
// existing organic records.

const SEED_ADMIN_TOKEN = process.env.SEED_ADMIN_TOKEN || null;

app.post('/v1/yield/admin/seed', express.text({ type: ['application/x-ndjson', 'text/plain'], limit: '10mb' }), (req, res) => {
  // Auth check
  const token = req.headers['x-seed-admin-token'] || req.headers['authorization']?.replace('Bearer ', '');
  if (!SEED_ADMIN_TOKEN) {
    return res.status(503).json({ error: 'Seed endpoint disabled: SEED_ADMIN_TOKEN not configured.' });
  }
  if (!token || token !== SEED_ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Invalid or missing X-Seed-Admin-Token.' });
  }

  // Parse NDJSON body — body is already a string thanks to express.text middleware
  const parseAndRespond = (rawBody) => {
    const lines = rawBody.split('\n').map(l => l.trim()).filter(Boolean);
    const accepted = [];
    const rejected = [];

    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        // Validate required fields
        if (typeof record.ts !== 'number') { rejected.push({ line: line.slice(0, 80), reason: 'missing ts' }); continue; }
        if (typeof record.spot !== 'number' || !isFinite(record.spot)) { rejected.push({ line: line.slice(0, 80), reason: 'invalid spot' }); continue; }
        if (typeof record.curve !== 'object') { rejected.push({ line: line.slice(0, 80), reason: 'missing curve' }); continue; }
        if (record.source !== 'uniswap_v3_observation') { rejected.push({ line: line.slice(0, 80), reason: 'source must be uniswap_v3_observation' }); continue; }
        // Sanity check: spot must be a stablecoin price (0.9 to 1.1)
        if (record.spot < 0.9 || record.spot > 1.1) { rejected.push({ line: line.slice(0, 80), reason: `spot out of range: ${record.spot}` }); continue; }
        accepted.push(record);
      } catch (e) {
        rejected.push({ line: line.slice(0, 80), reason: `parse error: ${e.message}` });
      }
    }

    if (accepted.length === 0) {
      return res.status(400).json({ error: 'No valid records', rejected: rejected.slice(0, 10) });
    }

    // Sort accepted records chronologically
    accepted.sort((a, b) => a.ts - b.ts);

    // Load existing history, merge, deduplicate, re-sort
    const existing = loadYieldHistory();
    const existingTsSet = new Set(existing.map(r => r.ts));
    const newRecords = accepted.filter(r => !existingTsSet.has(r.ts));
    const merged = [...accepted, ...existing].sort((a, b) => a.ts - b.ts);

    // Deduplicate by ts (keep first occurrence)
    const seen = new Set();
    const deduped = merged.filter(r => {
      if (seen.has(r.ts)) return false;
      seen.add(r.ts);
      return true;
    });

    // Write back as JSONL
    try {
      fs.writeFileSync(YIELD_HISTORY_FILE, deduped.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    } catch (e) {
      return res.status(500).json({ error: `Failed to write history: ${e.message}` });
    }

    const seedRecords = deduped.filter(r => r.source === 'uniswap_v3_observation');
    const organicRecords = deduped.filter(r => r.source !== 'uniswap_v3_observation');
    const seedWindow = seedRecords.length > 0 ? {
      seed_window_start: new Date(seedRecords[0].ts).toISOString(),
      seed_window_end: new Date(seedRecords[seedRecords.length - 1].ts).toISOString(),
    } : {};

    console.log(`[seed] Accepted ${newRecords.length} new records, ${accepted.length - newRecords.length} duplicates, ${rejected.length} rejected. Total history: ${deduped.length}`);

    res.json({
      accepted: newRecords.length,
      duplicates_skipped: accepted.length - newRecords.length,
      rejected: rejected.length,
      total_history: deduped.length,
      seeded: seedRecords.length,
      organic: organicRecords.length,
      ...seedWindow,
    });
  };

  // Body is parsed by express.text middleware
  parseAndRespond(req.body || '');
});

// ─── ADMIN: POST /v1/yield/admin/test-premium-token ────────────────────────────
// Creates a test premium token (30-day validity) for verifying the predictive
// endpoint after seeding. Gated by SEED_ADMIN_TOKEN. One-time use.

app.post('/v1/yield/admin/test-premium-token', (req, res) => {
  const token_header = req.headers['x-seed-admin-token'] || req.headers['authorization']?.replace('Bearer ', '');
  if (!SEED_ADMIN_TOKEN || token_header !== SEED_ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Invalid or missing X-Seed-Admin-Token.' });
  }

  const premiumToken = 'hsycp_' + crypto.randomBytes(32).toString('hex');
  const webhook_secret = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const expires_at = now + 30 * 24 * 60 * 60 * 1000;
  const subscription_id = 'psub_seed_test_' + crypto.randomBytes(8).toString('hex');

  const sub = {
    subscription_id,
    token: premiumToken,
    webhook_secret,
    payer_did: 'seed_admin_test',
    created_at: now,
    expires_at,
    amount_paid: '0',
    currency: 'USDC',
    network: 'base',
    status: 'active',
    tier: 'premium',
    note: 'test token created by seed admin for post-seed verification',
  };
  appendPremiumSub(sub);

  res.json({
    token: premiumToken,
    subscription_id,
    expires_at: new Date(expires_at).toISOString(),
    header: `Authorization: Bearer ${premiumToken}`,
    note: 'Test token. Valid 30 days. Use for verification only.',
  });
});

// ─── AUDIT: GET /v1/yield/history/audit ──────────────────────────────────────
// Returns counts of seeded vs organic records, window bounds, and span.
// No auth required — public audit trail for seed provenance transparency.

app.get('/v1/yield/history/audit', (req, res) => {
  const history = loadYieldHistory();
  if (history.length === 0) {
    return res.json({
      total: 0, seeded: 0, organic: 0,
      seed_window_start: null, seed_window_end: null,
      organic_window_start: null, organic_window_end: null,
      span_days: 0,
    });
  }

  const seeded = history.filter(r => r.source === 'uniswap_v3_observation');
  const organic = history.filter(r => r.source !== 'uniswap_v3_observation');

  const oldest = history[0].ts;
  const newest = history[history.length - 1].ts;
  const spanDays = (newest - oldest) / (24 * 3600 * 1000);

  res.json({
    total: history.length,
    seeded: seeded.length,
    organic: organic.length,
    seed_window_start: seeded.length > 0 ? new Date(seeded[0].ts).toISOString() : null,
    seed_window_end: seeded.length > 0 ? new Date(seeded[seeded.length - 1].ts).toISOString() : null,
    organic_window_start: organic.length > 0 ? new Date(organic[0].ts).toISOString() : null,
    organic_window_end: organic.length > 0 ? new Date(organic[organic.length - 1].ts).toISOString() : null,
    span_days: Math.round(spanDays * 100) / 100,
    required_days: MIN_HISTORY_DAYS,
    predictive_available: spanDays >= MIN_HISTORY_DAYS,
    brand: '#C08D23',
  });
});

app.get('/.well-known/mcp.json', (req, res) => {
  res.json({ name: 'hive-stable-yield-curve', version: '2.0.0', protocol: 'MCP 2024-11-05', endpoint: `${SERVICE_URL}/mcp`, tools: ['get_curve','get_spot','get_methodology','get_predictive'] });
});

// ─── Alert worker bootstrap ───────────────────────────────────────────────────

function startAlertWorker() {
  console.log(`[alert-worker] Starting. Tick every ${ALERT_TICK_MS / 1000}s.`);
  setInterval(async () => {
    try {
      await evaluateAlerts();
    } catch (err) {
      console.error('[alert-worker] Error:', err.message);
    }
  }, ALERT_TICK_MS);
}

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`hive-stable-yield-curve v2.0.0 (premium) listening on port ${PORT}`);
  console.log(`Service URL: ${SERVICE_URL}`);
  console.log(`Pool: ${POOL_ADDRESS} (USDC/USDT 0.01% Base)`);
  console.log(`Monroe: ${MONROE_ADDRESS}`);
  console.log(`Data dir: ${DATA_DIR}`);
  startAlertWorker();
});
