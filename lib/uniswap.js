/**
 * Uniswap v3 pool reader for USDC/USDT 0.01% on Base.
 * Reads slot0 (current tick) and observe(secondsAgo[]) for TWAP.
 * No fabricated data — if read fails, returns null for that observation.
 */

import { ethers } from 'ethers';

// Base mainnet RPC endpoints (public)
const BASE_RPC_URLS = [
  'https://mainnet.base.org',
  'https://base.llamarpc.com',
  'https://base-rpc.publicnode.com',
];

// Uniswap v3 USDC/USDT 0.01% pool on Base
// token0 = USDC (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)
// token1 = USDT (0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2)
// Verified via factory.getPool(USDC, USDT, 100) on Base 8453
export const POOL_ADDRESS = '0xd56da2b74ba826f19015e6b7dd9dae1903e85da1';
export const POOL_TOKEN0 = 'USDC';
export const POOL_TOKEN1 = 'USDT';
export const POOL_FEE = '0.01%';

// Minimal IUniswapV3Pool ABI — only what we need
const POOL_ABI = [
  // slot0: returns (sqrtPriceX96, tick, observationIndex, observationCardinality, observationCardinalityNext, feeProtocol, unlocked)
  'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  // observe: returns (tickCumulatives[], secondsPerLiquidityCumulativeX128[])
  'function observe(uint32[] calldata secondsAgos) external view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)',
  // token0, token1, fee
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
];

let _provider = null;

function getProvider() {
  if (_provider) return _provider;
  // Rotate through RPCs; use first that responds
  _provider = new ethers.JsonRpcProvider(BASE_RPC_URLS[0]);
  return _provider;
}

function getPool() {
  return new ethers.Contract(POOL_ADDRESS, POOL_ABI, getProvider());
}

/**
 * Read the current tick from slot0.
 * @returns {Promise<{tick: number, sqrtPriceX96: bigint}|null>}
 */
export async function readSlot0() {
  for (const rpcUrl of BASE_RPC_URLS) {
    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const pool = new ethers.Contract(POOL_ADDRESS, POOL_ABI, provider);
      const slot0 = await pool.slot0();
      return {
        tick: Number(slot0.tick),
        sqrtPriceX96: slot0.sqrtPriceX96,
      };
    } catch (err) {
      // Try next RPC
      continue;
    }
  }
  return null; // all RPCs failed
}

/**
 * Read TWAP observations for multiple secondsAgo values.
 * Uniswap v3 observe() takes an array of uint32 secondsAgo and returns tickCumulatives.
 * To get TWAP over a window W: observe([W, 0]) → (cumulativeAtStart, cumulativeNow)
 * TWAP tick = (cumulativeNow - cumulativeAtStart) / W
 *
 * @param {number[]} windowsSeconds - e.g. [3600, 21600, 86400, 604800]
 * @returns {Promise<Object>} keyed by windowSeconds → {tickCumulativeStart, tickCumulativeEnd, secondsElapsed} or null
 */
export async function readTWAPObservations(windowsSeconds) {
  // We need observe([W, 0]) for each W, but can batch: observe([w1, w2, ..., 0])
  // to minimize calls. However, Uniswap observe reverts if secondsAgo > oldest observation.
  // We'll do per-window calls with individual try/catch to get partial data.

  const results = {};

  for (const rpcUrl of BASE_RPC_URLS) {
    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const pool = new ethers.Contract(POOL_ADDRESS, POOL_ABI, provider);

      // Try a batch call first for efficiency
      const secondsAgos = [...windowsSeconds, 0]; // e.g. [3600, 21600, ..., 0]
      let batchResult = null;
      try {
        batchResult = await pool.observe(secondsAgos.map(s => s));
      } catch (_) {
        batchResult = null;
      }

      if (batchResult) {
        const tickCumulatives = batchResult[0]; // array of int56
        const nowCumulative = tickCumulatives[tickCumulatives.length - 1];
        for (let i = 0; i < windowsSeconds.length; i++) {
          results[windowsSeconds[i]] = {
            tickCumulativeStart: tickCumulatives[i],
            tickCumulativeEnd: nowCumulative,
            secondsElapsed: windowsSeconds[i],
          };
        }
        return results; // success from this RPC
      }

      // Batch failed (e.g. observation cardinality too low for long windows).
      // Fall back to individual calls, starting from shortest window.
      for (const w of windowsSeconds) {
        try {
          const obs = await pool.observe([w, 0]);
          results[w] = {
            tickCumulativeStart: obs[0][0],
            tickCumulativeEnd: obs[0][1],
            secondsElapsed: w,
          };
        } catch (_) {
          results[w] = null; // insufficient observations for this window
        }
      }
      return results;
    } catch (_) {
      continue; // try next RPC
    }
  }

  // All RPCs failed
  for (const w of windowsSeconds) {
    results[w] = null;
  }
  return results;
}

/**
 * Get spot price from slot0 sqrtPriceX96.
 * price = (sqrtPriceX96 / 2^96)^2 * (10^decimal0 / 10^decimal1)
 * For USDC/USDT both 6 decimals → decimal adjustment = 1.
 *
 * @param {bigint} sqrtPriceX96
 * @returns {number}
 */
export function sqrtPriceX96ToPrice(sqrtPriceX96) {
  const Q96 = 2n ** 96n;
  // Use floating point for precision (acceptable for stablecoins near parity)
  const sqrt = Number(sqrtPriceX96) / Number(Q96);
  return sqrt * sqrt; // price of token0 in token1 (USDC per USDT)
}
