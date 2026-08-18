/**
 * Differential test: packages/core vs. the real contract.
 *
 * fixtures/contract.json is produced by test/DumpFixtures.t.sol running against
 * a live BithookMiningHook — not by re-deriving the formulas in Solidity. Every
 * commitment in it was accepted by a real commit()+reveal() pair, and the tie
 * outcomes were read back off the contract after two real revealers collided.
 *
 * Regenerate with:  DUMP_FIXTURES=1 forge test --match-contract DumpFixtures
 */

import { describe, expect, it } from 'vitest';

import fixture from '../fixtures/contract.json' with { type: 'json' };

import {
  BLOCK_TIME,
  CURVE_TOKENS,
  ERA_ONE,
  EXIT_SLASH_BPS,
  FEE_BPS,
  INITIAL_SUPPLY,
  LOCK_SLICES_PER_ERA,
  MAX_CHECKPOINTS,
  MAX_SUPPLY,
  MAX_VEST,
  SEED_FLOOR_TICK,
  SEED_GRAD_TICK,
  SEED_START_TICK,
  STAKE_BPS,
  TOTAL_MINING_SUPPLY,
} from '../src/constants.js';
import {
  eraAt,
  lockSliceAt,
  scheduleCap,
  scheduledBlockReward,
  stakeFor,
  stakeUnlockTime,
  vestDurationFor,
} from '../src/schedule.js';
import {
  commitmentHash,
  distance,
  replayWinner,
  targetTickFrom,
} from '../src/mining.js';

const {
  meta,
  schedule,
  scheduleCap: capRows,
  commitments,
  signedDiv,
  ties,
  targets,
} = fixture;
const MINING_START = BigInt(meta.miningStart);

describe('constants match the deployed contract', () => {
  it('mining schedule', () => {
    expect(BLOCK_TIME).toBe(BigInt(meta.blockTime));
    expect(ERA_ONE).toBe(BigInt(meta.eraOne));
    expect(STAKE_BPS).toBe(BigInt(meta.stakeBps));
    expect(LOCK_SLICES_PER_ERA).toBe(BigInt(meta.lockSlicesPerEra));
    expect(MAX_VEST).toBe(BigInt(meta.maxVest));
    expect(MAX_CHECKPOINTS).toBe(BigInt(meta.maxCheckpoints));
    expect(EXIT_SLASH_BPS).toBe(BigInt(meta.exitSlashBps));
    expect(TOTAL_MINING_SUPPLY).toBe(BigInt(meta.totalMiningSupply));
  });

  it('token and pool', () => {
    expect(MAX_SUPPLY).toBe(BigInt(meta.maxSupply));
    expect(INITIAL_SUPPLY).toBe(BigInt(meta.initialSupply));
    expect(FEE_BPS).toBe(BigInt(meta.feeBps));
    expect(CURVE_TOKENS).toBe(BigInt(meta.curveTokens));
    expect(SEED_START_TICK).toBe(Number(meta.seedStartTick));
    expect(SEED_GRAD_TICK).toBe(Number(meta.seedGradTick));
    expect(SEED_FLOOR_TICK).toBe(Number(meta.seedFloorTick));
  });
});

describe('scheduleCap', () => {
  it.each(capRows)('scheduleCap($elapsed)', (row) => {
    expect(scheduleCap(BigInt(row.elapsed))).toBe(BigInt(row.cap));
  });
});

describe('per-block schedule', () => {
  // Sampled across every early era boundary, the lock-slice boundaries inside
  // era 0, and out to block 1e11 where per-block rewards approach the integer
  // floor. A closed-form "simplification" of the loops breaks in the deep tail.
  it.each(schedule)('block $n', (row) => {
    const n = BigInt(row.n);
    const elapsed = n * BLOCK_TIME;

    expect(scheduleCap(elapsed)).toBe(BigInt(row.cap));
    expect(scheduledBlockReward(n)).toBe(BigInt(row.reward));
    expect(stakeFor(n)).toBe(BigInt(row.stake));
    expect(vestDurationFor(n)).toBe(BigInt(row.vestDuration));

    const era = eraAt(elapsed);
    expect(era.era).toBe(BigInt(row.era));
    expect(era.start).toBe(BigInt(row.eraStart));
    expect(era.duration).toBe(BigInt(row.eraDuration));

    const slice = lockSliceAt(elapsed);
    expect(slice).toBe(BigInt(row.lockSlice));
    expect(stakeUnlockTime(slice, MINING_START)).toBe(BigInt(row.unlockTime));
  });

  it('reward rounding is not uniform across blocks', () => {
    // Guards the test itself: if every sampled reward were identical, the
    // fixture would pass against a constant and prove nothing.
    const rewards = new Set(schedule.map((r) => r.reward));
    expect(rewards.size).toBeGreaterThan(5);
  });
});

describe('commitment hash', () => {
  // Each of these was accepted by a real commit() and then successfully
  // revealed, so the field order (tick, salt, sender) is proven, not assumed.
  it.each(commitments)('tick $tick', (row) => {
    expect(
      commitmentHash(
        Number(row.tick),
        row.salt as `0x${string}`,
        row.sender as `0x${string}`,
      ),
    ).toBe(row.hash);
  });

  it.each(commitments)('distance for tick $tick', (row) => {
    expect(distance(Number(row.tick), Number(row.target))).toBe(Number(row.dist));
  });

  it('covers negative ticks', () => {
    expect(commitments.some((c) => Number(c.tick) < 0)).toBe(true);
  });
});

describe('target tick division', () => {
  // Solidity truncates signed division toward zero. BigInt division does too;
  // Math.floor does not, and would be one tick low on any non-integral negative
  // average. -700/600 is -1 truncated and -2 floored, so these rows fail loudly
  // if the implementation ever reaches for Math.floor.
  it.each(signedDiv)('diff $diff', (row) => {
    expect(targetTickFrom(0n, BigInt(row.diff))).toBe(Number(row.tick));
  });

  it('includes non-integral negative quotients', () => {
    const discriminating = signedDiv.filter((r) => {
      const diff = Number(r.diff);
      return diff < 0 && diff % 600 !== 0;
    });
    expect(discriminating.length).toBeGreaterThan(0);
    // Every one of them must differ from what Math.floor would return.
    for (const r of discriminating) {
      expect(Number(r.tick)).not.toBe(Math.floor(Number(r.diff) / 600));
    }
  });

  // Ties the expression above back to the real targetTickRaw() for blocks that
  // were actually played, using their real boundary cumulatives.
  it.each(targets)('real targetTickRaw for block $n', (row) => {
    expect(targetTickFrom(BigInt(row.cumAtN1), BigInt(row.cumAtN2))).toBe(
      Number(row.targetRaw),
    );
  });
});

describe('tie rule', () => {
  // Both fixtures are the same two addresses colliding on the same tick, with
  // the reveal order swapped between runs. The contract decides ties on
  // keccak(sender, blockId, target), so the replay must pick the same winner
  // regardless of who revealed first.
  it.each(ties)('block $blockId, order $revealOrder', (tie) => {
    const reveals = tie.revealOrder.map((who) => ({
      who: who as `0x${string}`,
      tick: Number(tie.tick),
    }));

    const leader = replayWinner(reveals, BigInt(tie.blockId), Number(tie.target));

    expect(leader.winner?.toLowerCase()).toBe(tie.winner.toLowerCase());
    expect(leader.bestDist).toBe(distance(Number(tie.tick), Number(tie.target)));
  });

  it('the winner is not simply the first revealer', () => {
    // If it were, this fixture pair could never disagree with a buggy replay.
    const secondRevealerWon = ties.some(
      (t) => t.winner.toLowerCase() === t.revealOrder[1]!.toLowerCase(),
    );
    expect(secondRevealerWon).toBe(true);
  });
});
