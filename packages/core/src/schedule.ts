/**
 * Byte-exact TypeScript port of the hook's emission, era and lock arithmetic.
 *
 * Every function here mirrors a `pure` (or time-only `view`) function in
 * BithookMiningHook. They are used by the indexer and the app, so a drift in
 * any of them makes the app disagree with the chain about who won.
 * `test/schedule.diff.test.ts` pins them against values dumped from the real
 * contract.
 *
 * Rules for keeping the port honest:
 *   - everything is BigInt; Number would lose precision above 2^53
 *   - all quantities are non-negative, so `/` truncation equals Solidity's floor
 *   - do not "simplify" the loops into closed forms; the contract's rounding
 *     happens per era and a closed form rounds somewhere else
 */

import {
  BLOCK_TIME,
  ERA_ONE,
  LOCK_SLICES_PER_ERA,
  MAX_VEST,
  STAKE_BPS,
  TOTAL_MINING_SUPPLY,
} from './constants.js';

/**
 * Mining allocation released by `elapsed` seconds after start.
 *
 * Era k lasts `ERA_ONE * 2^k` and emits half of whatever remains, so the total
 * approaches TOTAL_MINING_SUPPLY without reaching it. Within an era the release
 * is linear in time.
 */
export function scheduleCap(elapsed: bigint): bigint {
  let cap = 0n;
  let remaining = TOTAL_MINING_SUPPLY;
  let dur = ERA_ONE;
  let rest = elapsed;

  for (;;) {
    const share = remaining / 2n;
    // Integer precision floor: past ~84 halvings nothing further is released.
    if (share === 0n) return cap;
    if (rest < dur) return cap + (share * rest) / dur;
    cap += share;
    remaining -= share;
    rest -= dur;
    dur *= 2n;
  }
}

export interface Era {
  /** 0-based era index. */
  era: bigint;
  /** Seconds from miningStart to the era's first second. */
  start: bigint;
  /** Era length in seconds. */
  duration: bigint;
}

/** Era containing `elapsed`. Era k spans [ERA_ONE*(2^k - 1), ERA_ONE*(2^(k+1) - 1)). */
export function eraAt(elapsed: bigint): Era {
  let era = 0n;
  let start = 0n;
  let duration = ERA_ONE;
  let rest = elapsed;

  while (rest >= duration) {
    rest -= duration;
    start += duration;
    duration *= 2n;
    era += 1n;
  }
  return { era, start, duration };
}

/** Era index containing `elapsed`. */
export function eraOf(elapsed: bigint): bigint {
  return eraAt(elapsed).era;
}

/** Emission the schedule earmarks for block n. A pure function of time. */
export function scheduledBlockReward(n: bigint): bigint {
  return scheduleCap((n + 1n) * BLOCK_TIME) - scheduleCap(n * BLOCK_TIME);
}

/** Stake required to commit to block n: STAKE_BPS of its scheduled reward. */
export function stakeFor(n: bigint): bigint {
  return (scheduledBlockReward(n) * STAKE_BPS) / 10_000n;
}

/**
 * Vesting duration for block n's reward: the era length of the block that was
 * *won*, capped at MAX_VEST. Note this comes from the block, not from when the
 * winner got round to claiming.
 */
export function vestDurationFor(n: bigint): bigint {
  const { duration } = eraAt(n * BLOCK_TIME);
  return duration > MAX_VEST ? MAX_VEST : duration;
}

/**
 * Lock slice for a stake placed `elapsed` seconds after mining start.
 *
 * Each era is cut into LOCK_SLICES_PER_ERA slices and a stake unlocks one slice
 * after the slice it was placed in — a 10-20% era lock. Stakes are bucketed by
 * slice rather than recorded per reveal, which is what makes unlockStakes O(1)
 * however many bets were placed.
 */
export function lockSliceAt(elapsed: bigint): bigint {
  const { era, start, duration } = eraAt(elapsed);
  const w = duration / LOCK_SLICES_PER_ERA;
  let idx = (elapsed - start) / w;
  // The contract clamps defensively; mirror it rather than assume exact division.
  if (idx >= LOCK_SLICES_PER_ERA) idx = LOCK_SLICES_PER_ERA - 1n;
  return era * LOCK_SLICES_PER_ERA + idx;
}

/**
 * Absolute timestamp at which `slice` unlocks: the end of the slice following it.
 * Mirrors the contract's view function, with miningStart passed in.
 */
export function stakeUnlockTime(slice: bigint, miningStart: bigint): bigint {
  const era = slice / LOCK_SLICES_PER_ERA;
  const idx = slice % LOCK_SLICES_PER_ERA;

  let duration = ERA_ONE;
  let start = 0n;
  for (let i = 0n; i < era; i += 1n) {
    start += duration;
    duration *= 2n;
  }
  const w = duration / LOCK_SLICES_PER_ERA;
  return miningStart + start + (idx + 2n) * w;
}

// ---------------------------------------------------------------------------
// Time-indexed blocks
// ---------------------------------------------------------------------------

/** First second of block n. */
export function blockStart(n: bigint, miningStart: bigint): bigint {
  return miningStart + n * BLOCK_TIME;
}

/** First second *after* block n. */
export function blockEnd(n: bigint, miningStart: bigint): bigint {
  return blockStart(n + 1n, miningStart);
}

/**
 * Block containing `timestamp`. Reverts on-chain when mining has not started;
 * here the caller must check `miningStart !== 0n` first, because a zero start
 * would silently produce an enormous block number.
 */
export function blockAt(timestamp: bigint, miningStart: bigint): bigint {
  if (miningStart === 0n) {
    throw new Error('blockAt: mining has not started (miningStart is 0)');
  }
  if (timestamp < miningStart) {
    throw new Error('blockAt: timestamp precedes miningStart');
  }
  return (timestamp - miningStart) / BLOCK_TIME;
}

/** Era the given moment falls in. */
export function eraAtTimestamp(timestamp: bigint, miningStart: bigint): bigint {
  return eraOf(timestamp - miningStart);
}

// ---------------------------------------------------------------------------
// Block lifecycle
// ---------------------------------------------------------------------------

export type BlockPhase =
  /** Commits are open for this block. */
  | 'commit'
  /** Commits closed; the TWAP target is being measured over block n+1. */
  | 'target'
  /** Target is known and public; reveals are open. */
  | 'reveal'
  /** Reveal window closed; the block can be finalized and claimed. */
  | 'settled';

/** Which phase block n is in at `timestamp`. */
export function blockPhase(
  n: bigint,
  timestamp: bigint,
  miningStart: bigint,
): BlockPhase {
  const current = blockAt(timestamp, miningStart);
  if (current <= n) return 'commit';
  if (current === n + 1n) return 'target';
  if (current === n + 2n) return 'reveal';
  return 'settled';
}

/**
 * The three windows of block n as absolute timestamps: when it accepts commits,
 * when its target is measured, and when it accepts reveals.
 */
export function blockWindows(n: bigint, miningStart: bigint) {
  return {
    commit: { start: blockStart(n, miningStart), end: blockStart(n + 1n, miningStart) },
    target: { start: blockStart(n + 1n, miningStart), end: blockStart(n + 2n, miningStart) },
    reveal: { start: blockStart(n + 2n, miningStart), end: blockStart(n + 3n, miningStart) },
  } as const;
}
