/**
 * TWAP Math Helper — Uniswap v3 tick-based implied forward rate computation.
 * Pure functions. Returns null explicitly when observations are insufficient.
 * NO FABRICATED RATES. If data is missing, return null.
 */

/**
 * Convert a Uniswap v3 tick to a price ratio (token1/token0).
 * For USDC/USDT 0.01% pool on Base:
 *   token0 = USDC (6 decimals), token1 = USDT (6 decimals)
 *   price = 1.0001^tick * (10^decimals0 / 10^decimals1)
 *
 * @param {bigint|number} tick
 * @param {number} decimal0 - decimals of token0
 * @param {number} decimal1 - decimals of token1
 * @returns {number} price of token0 in terms of token1
 */
export function tickToPrice(tick, decimal0 = 6, decimal1 = 6) {
  const t = Number(tick);
  const rawPrice = Math.pow(1.0001, t);
  const decimalAdjustment = Math.pow(10, decimal0 - decimal1);
  return rawPrice * decimalAdjustment;
}

/**
 * Compute implied TWAP spot rate from two cumulative tick observations.
 *
 * Uniswap v3 returns tickCumulatives from observe([secondsAgo]).
 * TWAP tick = (tickCumulative_now - tickCumulative_then) / secondsElapsed
 *
 * @param {bigint} tickCumulativeNow  - more recent observation
 * @param {bigint} tickCumulativeThen - older observation
 * @param {number} secondsElapsed     - seconds between observations
 * @param {number} decimal0
 * @param {number} decimal1
 * @returns {number|null} implied rate (price of token0 in token1), or null if insufficient
 */
export function computeTWAP(tickCumulativeNow, tickCumulativeThen, secondsElapsed, decimal0 = 6, decimal1 = 6) {
  if (secondsElapsed <= 0) return null;
  if (tickCumulativeNow === null || tickCumulativeThen === null) return null;

  const delta = BigInt(tickCumulativeNow) - BigInt(tickCumulativeThen);
  // Integer division, rounded toward negative infinity (match Uniswap v3 spec)
  let twapTick = delta / BigInt(secondsElapsed);
  // Handle negative rounding: if delta % secondsElapsed < 0, subtract 1
  const remainder = delta % BigInt(secondsElapsed);
  if (remainder < 0n) twapTick -= 1n;

  return tickToPrice(twapTick, decimal0, decimal1);
}

/**
 * Compute implied forward rate between two time windows.
 *
 * Forward rate from t1 to t2 derived from spot (0 to t2) and near (0 to t1):
 *   Using log-linear interpolation on implied rates:
 *   r_forward(t1->t2) = exp((r(0,t2)*t2 - r(0,t1)*t1) / (t2-t1))
 *
 * For stable-to-stable near-parity, we use a simpler compound approximation:
 *   forward ≈ (spot_t2^t2 / spot_t1^t1)^(1/(t2-t1))
 *
 * @param {number|null} rateShort - TWAP rate over short window (seconds: windowShort)
 * @param {number} windowShort    - shorter window in seconds
 * @param {number|null} rateLong  - TWAP rate over long window (seconds: windowLong)
 * @param {number} windowLong     - longer window in seconds
 * @returns {number|null}
 */
export function impliedForwardRate(rateShort, windowShort, rateLong, windowLong) {
  if (rateShort === null || rateLong === null) return null;
  if (windowLong <= windowShort) return null;
  if (rateShort <= 0 || rateLong <= 0) return null;

  const lnShort = Math.log(rateShort) * windowShort;
  const lnLong = Math.log(rateLong) * windowLong;
  const forwardWindow = windowLong - windowShort;

  if (forwardWindow === 0) return null;

  const lnForward = (lnLong - lnShort) / forwardWindow;
  return Math.exp(lnForward);
}

/**
 * Given a set of TWAP observations at various windows, build the forward curve.
 * Windows: spot (0→now via slot0 tick), 1h (3600s), 6h (21600s), 24h (86400s), 7d (604800s)
 *
 * Forward curve points:
 *   "1h"  = implied rate from now to +1h  ≈ TWAP(0,3600)   (same as 1h TWAP for parity pairs)
 *   "6h"  = implied forward from 1h to 6h
 *   "24h" = implied forward from 6h to 24h
 *   "7d"  = implied forward from 24h to 7d
 *
 * Returns null for any point where data is missing.
 *
 * @param {Object} twaps - keyed by window label, values are rates or null
 *   { spot: number|null, "1h": number|null, "6h": number|null, "24h": number|null, "7d": number|null }
 * @returns {Object} curve with forward rates
 */
export function buildForwardCurve(twaps) {
  return {
    "1h":  twaps["1h"]  ?? null,
    "6h":  impliedForwardRate(twaps["1h"], 3600, twaps["6h"], 21600),
    "24h": impliedForwardRate(twaps["6h"], 21600, twaps["24h"], 86400),
    "7d":  impliedForwardRate(twaps["24h"], 86400, twaps["7d"], 604800),
  };
}

/**
 * Determine coverage status from a curve object.
 * @param {Object} curve - { "1h", "6h", "24h", "7d" }
 * @param {number|null} spot
 * @returns {"full"|"partial"|"none"}
 */
export function computeCoverage(curve, spot) {
  const allPoints = [spot, curve["1h"], curve["6h"], curve["24h"], curve["7d"]];
  const nullCount = allPoints.filter(v => v === null).length;
  if (nullCount === 0) return "full";
  if (nullCount === allPoints.length) return "none";
  return "partial";
}
