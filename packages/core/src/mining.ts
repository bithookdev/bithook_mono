/**
 * Commit/reveal primitives and the winner rule.
 *
 * The contract never emits a winner — `BlockWon` only fires when someone
 * *claims*. The leader of a block is therefore something we recompute from the
 * ordered `Revealed` log, which means this file has to reproduce `reveal()`
 * exactly, tiebreak included.
 */

import { encodePacked, hexToBigInt, keccak256 } from 'viem';
import type { Address, Hex } from 'viem';

import { BLOCK_TIME } from './constants.js';

// ---------------------------------------------------------------------------
// Commitment
// ---------------------------------------------------------------------------

/**
 * keccak256(abi.encodePacked(int24 tick, bytes32 salt, address sender)) — 55 bytes.
 *
 * The field order is tick, salt, sender. Getting it wrong produces a commitment
 * that can never be revealed and a stake that is burned, so this is pinned by
 * a differential test rather than trusted.
 */
export function commitmentHash(tick: number, salt: Hex, sender: Address): Hex {
  return keccak256(
    encodePacked(['int24', 'bytes32', 'address'], [tick, salt, sender]),
  );
}

/**
 * keccak256(abi.encodePacked(address sender, uint256 blockId, int24 target)) — 55 bytes.
 *
 * Lowest hash wins an exact tie. This removes reveal-order bias, but it is
 * grindable when the target is predictable: an actor can search addresses
 * off-chain and fund only the best one.
 */
export function tiebreak(sender: Address, blockId: bigint, target: number): Hex {
  return keccak256(
    encodePacked(['address', 'uint256', 'int24'], [sender, blockId, target]),
  );
}

// ---------------------------------------------------------------------------
// Target
// ---------------------------------------------------------------------------

/**
 * Arithmetic-mean TWAP tick over block n+1, from the two bounding checkpoints.
 *
 * The contract computes `int24(diff / 600)` with Solidity signed division,
 * which truncates toward zero. BigInt division truncates toward zero too, so
 * this matches — but `Math.floor(diff / 600)` would NOT for a negative average,
 * and would be one tick low. Ticks are deeply positive at launch, so a bug here
 * would stay invisible until the price rose ~10^7x. Keep the BigInt path.
 */
export function targetTickFrom(cumAtN1: bigint, cumAtN2: bigint): number {
  const diff = cumAtN2 - cumAtN1;
  return Number(diff / BLOCK_TIME);
}

/** Distance between a prediction and the target, as the contract's uint32. */
export function distance(tick: number, target: number): number {
  return Math.abs(tick - target);
}

/**
 * Boundary indices required to resolve block n's target.
 *
 * Both must have been checkpointed. If either was skipped — which happens
 * permanently after MAX_ORACLE_SILENCE of no contract activity — the target can
 * never be computed, `reveal(n, ...)` reverts forever, and every stake on that
 * block is burned. The indexer flags these.
 */
export function requiredBoundaries(n: bigint): readonly [bigint, bigint] {
  return [n + 1n, n + 2n];
}

// ---------------------------------------------------------------------------
// Winner replay
// ---------------------------------------------------------------------------

export interface RevealLike {
  who: Address;
  tick: number;
}

export interface Leader {
  winner: Address | null;
  bestDist: number | null;
  bestTiebreak: Hex | null;
}

export const NO_LEADER: Leader = {
  winner: null,
  bestDist: null,
  bestTiebreak: null,
};

/**
 * Apply one reveal to the running leader, exactly as `reveal()` does:
 *
 *   if (winner == 0 || dist < bestDist)              -> take the lead
 *   else if (dist == bestDist && tb < bestTiebreak)  -> take the lead
 *
 * Note the contract does not reassign bestDist in the tie branch (it is equal
 * by definition). Returns the same object when the lead does not change, so a
 * caller can cheaply detect `tookLead`.
 */
export function applyReveal(
  leader: Leader,
  reveal: RevealLike,
  blockId: bigint,
  target: number,
): Leader {
  const dist = distance(reveal.tick, target);
  const tb = tiebreak(reveal.who, blockId, target);

  if (leader.winner === null || leader.bestDist === null || dist < leader.bestDist) {
    return { winner: reveal.who, bestDist: dist, bestTiebreak: tb };
  }

  if (
    dist === leader.bestDist &&
    leader.bestTiebreak !== null &&
    hexToBigInt(tb) < hexToBigInt(leader.bestTiebreak)
  ) {
    return { winner: reveal.who, bestDist: leader.bestDist, bestTiebreak: tb };
  }

  return leader;
}

/**
 * Replay an ordered list of reveals to find a block's winner.
 * `reveals` must be in log order (block number, then log index).
 */
export function replayWinner(
  reveals: readonly RevealLike[],
  blockId: bigint,
  target: number,
): Leader {
  let leader = NO_LEADER;
  for (const r of reveals) {
    leader = applyReveal(leader, r, blockId, target);
  }
  return leader;
}

/**
 * Replay while recording which reveals actually took the lead — this is what
 * drives the "lead changed hands N times" timeline in the block explorer.
 */
export function replayWinnerWithLeadChanges<T extends RevealLike>(
  reveals: readonly T[],
  blockId: bigint,
  target: number,
): { leader: Leader; entries: Array<T & { dist: number; tookLead: boolean }> } {
  let leader = NO_LEADER;
  const entries: Array<T & { dist: number; tookLead: boolean }> = [];

  for (const r of reveals) {
    const next = applyReveal(leader, r, blockId, target);
    const tookLead = next !== leader;
    entries.push({ ...r, dist: distance(r.tick, target), tookLead });
    leader = next;
  }

  return { leader, entries };
}
