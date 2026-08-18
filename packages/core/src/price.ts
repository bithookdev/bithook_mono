/**
 * Tick and price conversion.
 *
 * Orientation matters and is easy to invert. currency0 is native ETH and
 * currency1 is BITHOOK, so a Uniswap tick here counts **BITHOOK per ETH**:
 *
 *   tick 164,600 (the open)  -> ~14.0M BITHOOK/ETH -> ~1.49 ETH FDV
 *   tick 137,800 (graduation)-> ~963k  BITHOOK/ETH -> ~21.8 ETH FDV
 *
 * So a *higher* tick is a *cheaper* token. Buying walks the tick down; selling
 * walks it up toward SEED_START_TICK, which is the corridor's upper bound and
 * therefore a hard floor under the price.
 *
 * These conversions are float64 and are for display and for turning a user's
 * typed price into a tick. Anything that must be exact — corridor bounds, swap
 * price limits — reads sqrtPriceX96 off the contract instead of recomputing it.
 */

import {
  CORRIDOR_TICK_LOWER,
  CORRIDOR_TICK_UPPER,
  MAX_SUPPLY,
  SEED_START_TICK,
} from './constants.js';

/** ln(1.0001), computed via log1p so it keeps full relative precision. */
const LN_TICK_BASE = Math.log1p(0.0001);

/** BITHOOK received per 1 ETH at this tick. */
export function tickToBithookPerEth(tick: number): number {
  return Math.exp(tick * LN_TICK_BASE);
}

/** ETH cost of 1 BITHOOK at this tick. */
export function tickToEthPerBithook(tick: number): number {
  return Math.exp(-tick * LN_TICK_BASE);
}

/**
 * Nearest tick to a given ETH-per-BITHOOK price.
 *
 * Predictions are exact int24 ticks with no spacing constraint — the pool's
 * tickSpacing of 200 governs liquidity positions, not predictions. Round-trip
 * through `tickToEthPerBithook` and show the user the price of the tick they
 * are actually committing to, so a rounding of half a tick never surprises them.
 */
export function ethPerBithookToTick(ethPerBithook: number): number {
  if (!(ethPerBithook > 0) || !Number.isFinite(ethPerBithook)) {
    throw new Error(`ethPerBithookToTick: price must be positive and finite, got ${ethPerBithook}`);
  }
  return Math.round(-Math.log(ethPerBithook) / LN_TICK_BASE);
}

/** Nearest tick to a given BITHOOK-per-ETH price. */
export function bithookPerEthToTick(bithookPerEth: number): number {
  if (!(bithookPerEth > 0) || !Number.isFinite(bithookPerEth)) {
    throw new Error(`bithookPerEthToTick: price must be positive and finite, got ${bithookPerEth}`);
  }
  return Math.round(Math.log(bithookPerEth) / LN_TICK_BASE);
}

/**
 * Fully-diluted valuation in ETH at this tick, against the 21M cap.
 * This is the headline number, and it is what the launch curve is denominated
 * in: ~1.49 ETH at the open rising to ~21.8 ETH at graduation.
 */
export function fdvEth(tick: number): number {
  return Number(MAX_SUPPLY / 10n ** 18n) * tickToEthPerBithook(tick);
}

/** Market cap in ETH for a given circulating supply (in wei). */
export function marketCapEth(tick: number, circulatingWei: bigint): number {
  return Number(circulatingWei) / 1e18 * tickToEthPerBithook(tick);
}

/** Price change from the opening tick, as a multiple. >1 means the token rose. */
export function multipleFromOpen(tick: number): number {
  return Math.exp((SEED_START_TICK - tick) * LN_TICK_BASE);
}

// ---------------------------------------------------------------------------
// Corridor
// ---------------------------------------------------------------------------

/**
 * Whether a tick is inside the seed corridor. Outside it, swaps revert in full
 * (`PriceOutsideCorridor`) rather than partially filling.
 *
 * In practice only the upper bound is reachable: the lower bound is ~4e22 ETH
 * of buying away, while the upper bound is the launch price and every sell
 * pushes toward it.
 */
export function isInCorridor(tick: number): boolean {
  return tick >= CORRIDOR_TICK_LOWER && tick <= CORRIDOR_TICK_UPPER;
}

/**
 * How close the price is to the corridor ceiling, in ticks. Zero means a sell
 * of any size will revert. The trade UI should surface this rather than letting
 * a quote fail with an opaque revert.
 */
export function ticksToCorridorCeiling(tick: number): number {
  return CORRIDOR_TICK_UPPER - tick;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Render a tick as a human price string. Prices here span many orders of
 * magnitude (1 BITHOOK is ~7e-8 ETH at the open), so fixed decimals are useless
 * and exponential is unreadable — use significant digits.
 */
export function formatEthPerBithook(tick: number, sigDigits = 4): string {
  return tickToEthPerBithook(tick).toPrecision(sigDigits);
}

export function formatBithookPerEth(tick: number): string {
  return Math.round(tickToBithookPerEth(tick)).toLocaleString('en-US');
}
