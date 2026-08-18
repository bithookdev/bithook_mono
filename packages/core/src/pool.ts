/**
 * Reading the pool's live price out of the v4 PoolManager.
 *
 * There is no getter for this — v4 exposes raw storage through `extsload` and
 * expects callers to compute slots themselves (that is what the StateView lens
 * and StateLibrary do on-chain). Doing it directly here avoids depending on a
 * lens deployment.
 *
 * Note the hook's own `lastTick` is NOT a substitute: `_accumulate()` returns
 * immediately while `miningStart == 0`, so during the trading-only window
 * `lastTick` is frozen at the opening tick while the real price moves.
 */

import { keccak256, encodePacked, toHex } from 'viem';
import type { Hex } from 'viem';

/** Index of PoolManager's `_pools` mapping in storage. */
export const POOLS_SLOT = 6n;

/** Storage slot of `_pools[poolId]`, matching StateLibrary._getPoolStateSlot. */
export function poolStateSlot(poolId: Hex): Hex {
  return keccak256(
    encodePacked(['bytes32', 'bytes32'], [poolId, toHex(POOLS_SLOT, { size: 32 })]),
  );
}

export interface Slot0 {
  sqrtPriceX96: bigint;
  tick: number;
  protocolFee: number;
  lpFee: number;
}

/**
 * Unpack Slot0 from a raw storage word.
 *
 * Layout, low bits first: sqrtPriceX96 (160) | tick (24, signed) |
 * protocolFee (24) | lpFee (24).
 */
export function decodeSlot0(raw: Hex): Slot0 {
  const v = BigInt(raw);
  const sqrtPriceX96 = v & ((1n << 160n) - 1n);

  let tick = Number((v >> 160n) & ((1n << 24n) - 1n));
  // int24 is stored two's-complement; without this the whole negative half of
  // the tick range decodes as a huge positive number.
  if (tick >= 1 << 23) tick -= 1 << 24;

  return {
    sqrtPriceX96,
    tick,
    protocolFee: Number((v >> 184n) & ((1n << 24n) - 1n)),
    lpFee: Number((v >> 208n) & ((1n << 24n) - 1n)),
  };
}

/** Minimal ABI for PoolManager.extsload(bytes32). */
export const extsloadAbi = [
  {
    type: 'function',
    name: 'extsload',
    stateMutability: 'view',
    inputs: [{ name: 'slot', type: 'bytes32' }],
    outputs: [{ name: 'value', type: 'bytes32' }],
  },
] as const;
