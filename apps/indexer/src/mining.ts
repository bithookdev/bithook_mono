import {
  BLOCK_TIME,
  bithookHookAbi,
  applyReveal,
  eraAt,
  lockSliceAt,
  scheduledBlockReward,
  stakeFor,
  targetTickFrom,
  vestDurationFor,
  type Leader,
} from '@bithook/core';
import { ponder } from 'ponder:registry';
import { decodeFunctionData } from 'viem';
import {
  boundary,
  burn,
  depositLock,
  miner,
  miningBlock,
  miningCommit,
  miningReveal,
  vest,
  vestByTx,
} from 'ponder:schema';

/**
 * Mining indexing.
 *
 * The hard parts, and why they are done this way:
 *
 *  - The contract emits **no winner event**. `BlockWon` fires only on claim, so
 *    an unclaimed win emits nothing. The leader is replayed from the ordered
 *    `Revealed` log using the same rule the contract applies, via
 *    `applyReveal` in packages/core — which is pinned against two real forced
 *    ties taken from chain, in both reveal orders.
 *
 *  - `VestCreated` carries no duration and no block id. It is emitted in the
 *    same transaction as `BlockWon`, and always first, so the pair is matched by
 *    transaction hash.
 *
 *  - `EarlyExited` does not say which vest ids were exited, so the ids are
 *    decoded from the transaction's calldata.
 */

const ZERO = '0x0000000000000000000000000000000000000000' as const;

/** Ensure a mining-block row exists before mutating it. */
async function ensureBlock(context: any, n: bigint, miningStart: bigint) {
  const elapsed = n * BLOCK_TIME;
  const { era } = eraAt(elapsed);
  await context.db
    .insert(miningBlock)
    .values({
      n,
      startTs: miningStart + elapsed,
      era: Number(era),
      lockSlice: Number(lockSliceAt(elapsed)),
      scheduledReward: scheduledBlockReward(n),
      deposit: stakeFor(n),
      vestDuration: Number(vestDurationFor(n)),
    })
    .onConflictDoNothing();
}

async function bumpMiner(
  context: any,
  address: `0x${string}`,
  ts: bigint,
  patch: Record<string, unknown> = {},
) {
  await context.db
    .insert(miner)
    .values({ address, firstSeenTs: ts, lastSeenTs: ts, ...patch })
    .onConflictDoUpdate((row: any) => {
      const next: Record<string, unknown> = { lastSeenTs: ts };
      for (const [k, v] of Object.entries(patch)) {
        if (typeof v === 'number') next[k] = (row[k] ?? 0) + v;
        else if (typeof v === 'bigint') next[k] = (row[k] ?? 0n) + v;
        else next[k] = v;
      }
      return next;
    });
}

// ---------------------------------------------------------------------------

ponder.on('BithookHook:MiningStarted', async ({ event, context }) => {
  // Boundary 0 is set inside startMining() WITHOUT emitting Checkpointed, so it
  // has to be seeded here or every target that depends on it looks unresolvable.
  await context.db
    .insert(boundary)
    .values({ id: 0n, cumulative: 0n, timestamp: event.args.timestamp })
    .onConflictDoNothing();
});

ponder.on('BithookHook:Committed', async ({ event, context }) => {
  const n = event.args.blockId;
  const miningStart = event.block.timestamp - (n * BLOCK_TIME);

  await ensureBlock(context, n, miningStart);
  await context.db
    .insert(miningCommit)
    .values({
      id: `${n}:${event.args.who}`,
      blockId: n,
      who: event.args.who,
      timestamp: event.block.timestamp,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing();

  await context.db
    .update(miningBlock, { n })
    .set((row: any) => ({ commitCount: row.commitCount + 1 }));

  await bumpMiner(context, event.args.who, event.block.timestamp, { commits: 1 });
});

ponder.on('BithookHook:Revealed', async ({ event, context }) => {
  const n = event.args.blockId;
  const dist = BigInt(event.args.dist);

  await context.db
    .insert(miningReveal)
    .values({
      id: `${n}:${event.args.who}`,
      blockId: n,
      who: event.args.who,
      tick: event.args.tick,
      dist,
      timestamp: event.block.timestamp,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing();

  // Resolve the target if we can — a reveal proves both boundaries exist, since
  // the contract's own reveal() would have reverted otherwise.
  const b1 = await context.db.find(boundary, { id: n + 1n });
  const b2 = await context.db.find(boundary, { id: n + 2n });
  const target =
    b1 && b2 ? targetTickFrom(b1.cumulative, b2.cumulative) : event.args.tick - Number(dist);

  // Replay the leader exactly as the contract does.
  const row: any = await context.db.find(miningBlock, { n });
  const leader: Leader = {
    winner: (row?.winner ?? null) as `0x${string}` | null,
    bestDist: row?.bestDist === null || row?.bestDist === undefined ? null : Number(row.bestDist),
    bestTiebreak: (row?.bestTiebreak ?? null) as `0x${string}` | null,
  };
  const next = applyReveal(leader, { who: event.args.who, tick: event.args.tick }, n, target);

  await context.db.update(miningBlock, { n }).set((r: any) => ({
    revealCount: r.revealCount + 1,
    targetTick: target,
    targetResolvable: true,
    winner: next.winner,
    bestDist: next.bestDist === null ? null : BigInt(next.bestDist),
    bestTiebreak: next.bestTiebreak,
  }));

  await bumpMiner(context, event.args.who, event.block.timestamp, { reveals: 1, distSum: dist });
});

ponder.on('BithookHook:StakeLocked', async ({ event, context }) => {
  const id = `${event.args.who}:${event.args.slice}`;
  await context.db
    .insert(depositLock)
    .values({
      id,
      address: event.args.who,
      slice: event.args.slice,
      amount: event.args.amount,
      unlockAt: event.args.unlockAt,
      unlockedAt: null,
    })
    .onConflictDoUpdate((row: any) => ({ amount: row.amount + event.args.amount }));
});

ponder.on('BithookHook:StakeUnlocked', async ({ event, context }) => {
  await context.db
    .update(depositLock, { id: `${event.args.who}:${event.args.slice}` })
    .set({ amount: 0n, unlockedAt: event.block.timestamp })
    .catch(() => undefined);
});

ponder.on('BithookHook:BlockWon', async ({ event, context }) => {
  const n = event.args.blockId;
  await context.db.update(miningBlock, { n }).set({
    claimed: true,
    winner: event.args.winner,
    targetTick: event.args.targetTick,
    targetResolvable: true,
  });
  await bumpMiner(context, event.args.winner, event.block.timestamp, {
    wins: 1,
    totalWon: event.args.reward,
  });

  // VestCreated is emitted immediately BEFORE this, in the same transaction, and
  // carries neither the block id nor the duration. Backfill both here.
  const bridge: any = await context.db.find(vestByTx, { id: event.transaction.hash });
  if (bridge) {
    await context.db
      .update(vest, { id: bridge.vestKey })
      .set({ blockN: n, duration: Number(vestDurationFor(n)) })
      .catch(() => undefined);
  }
});

ponder.on('BithookHook:VestCreated', async ({ event, context }) => {
  // Keyed by tx as well as id so BlockWon in the same tx can find it; the id is
  // rewritten to its stable form once we know the block.
  const key = `${event.args.who}:${event.args.id}`;
  // Bridge for BlockWon, which fires later in this same transaction.
  await context.db
    .insert(vestByTx)
    .values({ id: event.transaction.hash, vestKey: key })
    .onConflictDoNothing();

  await context.db
    .insert(vest)
    .values({
      id: key,
      address: event.args.who,
      vestId: event.args.id,
      blockN: null,
      total: event.args.amount,
      released: 0n,
      startTs: event.block.timestamp,
      duration: null,
      exited: false,
      slashed: 0n,
    })
    .onConflictDoNothing();
});

ponder.on('BithookHook:Unlocked', async ({ event, context }) => {
  // The event gives a total for the transaction, not per entry, so this is
  // recorded against the miner rather than split across vests.
  await bumpMiner(context, event.args.who, event.block.timestamp, {});
});

/**
 * Early exit: half of whatever had not released is destroyed.
 *
 * This handler was described in the notes above long before it existed, and its
 * absence was silent — `vest.exited` and `vest.slashed` simply stayed at their
 * defaults, so every early exit looked like it had never happened while the
 * contract's own `totalSlashed` climbed past 600k. Two things depend on getting
 * it right, and neither could work without it: the per-block "taken early"
 * figure and a miner's total given up.
 *
 * The event carries the totals for the whole call but not which vests they came
 * from, so the ids are decoded from the transaction's calldata. Per-vest amounts
 * are then recomputed with the contract's own arithmetic rather than split
 * proportionally, so a multi-vest exit attributes exactly what each one lost:
 *
 *   vested   = elapsed >= duration ? total : total * elapsed / duration
 *   unvested = total - vested
 *   kept     = unvested * (10_000 - EXIT_SLASH_BPS) / 10_000
 *   slashed  = unvested - kept
 *
 * Integer division, floor, in that order — matching Solidity exactly, because a
 * rounding difference here would put the sum of vests permanently out of step
 * with `totalSlashed`.
 */
const EXIT_SLASH_BPS = 5_000n;

function slashedFor(total: bigint, released: bigint, start: bigint, duration: bigint, at: bigint): bigint {
  const elapsed = at - start;
  const vested = elapsed >= duration ? total : (total * elapsed) / duration;
  const unvested = total - vested;
  const kept = (unvested * (10_000n - EXIT_SLASH_BPS)) / 10_000n;
  return unvested - kept;
}

ponder.on('BithookHook:EarlyExited', async ({ event, context }) => {
  const who = event.args.who;
  const at = event.block.timestamp;

  let ids: bigint[] = [];
  try {
    const decoded = decodeFunctionData({ abi: bithookHookAbi, data: event.transaction.input });
    if (decoded.functionName === 'exitEarly') {
      ids = [...((decoded.args?.[0] ?? []) as readonly bigint[])];
    }
  } catch {
    // Called through a contract rather than directly; the vests cannot be
    // attributed, but the miner-level total below still lands.
  }

  for (const vestId of ids) {
    const row: any = await context.db.find(vest, { id: `${who}:${vestId}` });
    if (!row || row.exited) continue;
    const slashed = slashedFor(
      row.total,
      row.released,
      BigInt(row.startTs),
      BigInt(row.duration ?? 0),
      at,
    );
    await context.db.update(vest, { id: `${who}:${vestId}` }).set({
      exited: true,
      // The contract marks the entry fully released on exit.
      released: row.total,
      slashed,
    });
  }

  await bumpMiner(context, who, at, { slashedTotal: event.args.slashed });

  // The burn record this event always produced. `destroysSupply` stays false:
  // the slash is minted and burned in the same transaction, so totalSupply never
  // moves — but it does lower the ceiling permanently, which is why the supply
  // bar counts it from the token's own burns rather than from here.
  if (event.args.slashed > 0n) {
    await context.db
      .insert(burn)
      .values({
        id: `${event.transaction.hash}:${event.log.logIndex}`,
        timestamp: at,
        blockNumber: event.block.number,
        txHash: event.transaction.hash,
        kind: 'exitSlash',
        amount: event.args.slashed,
        ethSpent: null,
        destroysSupply: false,
      })
      .onConflictDoNothing();
  }
});
