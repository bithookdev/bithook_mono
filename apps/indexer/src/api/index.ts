import { db } from 'ponder:api';
// Named imports: the ponder:schema virtual module re-exports each table, it is
// not a namespace object — `swap` is undefined at runtime.
import { burn, depositLock, miner, miningBlock, miningReveal, supply, swap, vest } from 'ponder:schema';
import { Hono } from 'hono';
import { and, asc, count, desc, eq, gte, isNotNull, lte, sum } from 'ponder';

/**
 * REST surface the web app reads. Ponder also serves GraphQL, but the site only
 * needs a couple of shapes and this keeps the frontend free of a GraphQL client.
 */
const app = new Hono();

/** Recent trades, newest first. */
app.get('/trades', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') ?? 30), 100);

  const rows = await db
    .select()
    .from(swap)
    .orderBy(desc(swap.blockNumber), desc(swap.logIndex))
    .limit(limit);

  return c.json({
    trades: rows.map((r) => ({
      hash: r.txHash,
      block: r.blockNumber.toString(),
      logIndex: r.logIndex,
      kind: r.kind,
      eth: r.eth.toString(),
      bithook: r.bithook.toString(),
      tick: r.tick,
      ts: Number(r.timestamp),
    })),
  });
});

/**
 * Burn totals, split by whether they actually reduced supply. Kept as two
 * separate numbers on purpose — adding them together is the standard way these
 * dashboards end up overstating the burn.
 */
app.get('/burns', async (c) => {
  const [destroyed] = await db
    .select({ total: sum(burn.amount) })
    .from(burn)
    .where(eq(burn.destroysSupply, true));

  const [forgone] = await db
    .select({ total: sum(burn.amount) })
    .from(burn)
    .where(eq(burn.destroysSupply, false));

  const recent = await db
    .select()
    .from(burn)
    .orderBy(desc(burn.blockNumber))
    .limit(20);

  return c.json({
    supplyDestroyed: destroyed?.total ?? '0',
    emissionForgone: forgone?.total ?? '0',
    recent: recent.map((r) => ({
      // `id` is `${txHash}:${logIndex}` and unique per burn — a consumer that
      // must not act twice needs a stable key, and one transaction can produce
      // more than one burn. `blockNumber` lets it wait for confirmations before
      // treating a burn as real.
      id: r.id,
      kind: r.kind,
      amount: r.amount.toString(),
      ethSpent: r.ethSpent?.toString() ?? null,
      destroysSupply: r.destroysSupply,
      ts: Number(r.timestamp),
      blockNumber: r.blockNumber.toString(),
      hash: r.txHash,
    })),
  });
});


// ---------------------------------------------------------------------------
// Mining
// ---------------------------------------------------------------------------

const blockJson = (b: any) => ({
  n: b.n.toString(),
  startTs: Number(b.startTs),
  era: b.era,
  lockSlice: b.lockSlice,
  reward: b.scheduledReward.toString(),
  deposit: b.deposit.toString(),
  vestDuration: b.vestDuration,
  commits: b.commitCount,
  reveals: b.revealCount,
  targetTick: b.targetTick,
  targetResolvable: b.targetResolvable,
  winner: b.winner,
  bestDist: b.bestDist === null ? null : b.bestDist.toString(),
  claimed: b.claimed,
  depositsBurned: b.depositsBurned,
  status: b.status,
});

/** Explorer list, newest first. */
app.get('/mining/blocks', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 200);
  const from = c.req.query('from');
  const to = c.req.query('to');

  let q = db.select().from(miningBlock).$dynamic();
  if (from && to) q = q.where(and(gte(miningBlock.n, BigInt(from)), lte(miningBlock.n, BigInt(to))));
  const rows = await q.orderBy(desc(miningBlock.n)).limit(limit);
  return c.json({ blocks: rows.map(blockJson) });
});

/** One block, with every reveal — this drives the prediction scatter. */
app.get('/mining/blocks/:n', async (c) => {
  const n = BigInt(c.req.param('n'));
  const [b] = await db.select().from(miningBlock).where(eq(miningBlock.n, n)).limit(1);
  if (!b) return c.json({ error: 'unknown block' }, 404);

  const reveals = await db
    .select()
    .from(miningReveal)
    .where(eq(miningReveal.blockId, n))
    .orderBy(asc(miningReveal.timestamp));

  // The vest this block's claim minted, if it has been claimed. Keyed on
  // blockN, backfilled from BlockWon in the same transaction.
  const [vrow] = await db.select().from(vest).where(eq(vest.blockN, n)).limit(1);

  return c.json({
    block: blockJson(b),
    vest: vrow
      ? {
          total: vrow.total.toString(),
          released: vrow.released.toString(),
          slashed: vrow.slashed.toString(),
          exited: vrow.exited,
          startTs: Number(vrow.startTs),
          duration: vrow.duration,
        }
      : null,
    reveals: reveals.map((r) => ({
      who: r.who,
      tick: r.tick,
      dist: r.dist.toString(),
      ts: Number(r.timestamp),
      hash: r.txHash,
    })),
  });
});

/** Everything one address needs to know about its own position. */
app.get('/mining/miner/:address', async (c) => {
  const address = c.req.param('address').toLowerCase() as `0x${string}`;

  const [m] = await db.select().from(miner).where(eq(miner.address, address)).limit(1);
  const wins = await db
    .select()
    .from(miningBlock)
    .where(eq(miningBlock.winner, address))
    .orderBy(desc(miningBlock.n))
    .limit(100);
  const locks = await db
    .select()
    .from(depositLock)
    .where(eq(depositLock.address, address))
    .orderBy(asc(depositLock.slice));
  const vests = await db.select().from(vest).where(eq(vest.address, address));

  return c.json({
    miner: m
      ? {
          address: m.address,
          commits: m.commits,
          reveals: m.reveals,
          // From the replayed winner, not the claim event — see /leaderboard.
          wins: wins.length,
          totalWon: wins.reduce((a, b) => a + b.scheduledReward, 0n).toString(),
          meanDist: m.reveals > 0 ? Number(m.distSum / BigInt(m.reveals)) : null,
          depositsForfeited: m.depositsForfeited.toString(),
      slashedTotal: m.slashedTotal.toString(),
        }
      : null,
    wins: wins.map(blockJson),
    unclaimed: wins.filter((w) => !w.claimed).map(blockJson),
    locks: locks.map((l) => ({
      slice: l.slice.toString(),
      amount: l.amount.toString(),
      unlockAt: Number(l.unlockAt),
      unlocked: l.unlockedAt !== null,
    })),
    vests: vests.map((v) => ({
      vestId: v.vestId.toString(),
      blockN: v.blockN?.toString() ?? null,
      total: v.total.toString(),
      released: v.released.toString(),
      startTs: Number(v.startTs),
      duration: v.duration,
      exited: v.exited,
      // What exiting early destroyed. Zero unless `exited` is true: an early
      // exit burns half of whatever had not released yet.
      slashed: v.slashed.toString(),
    })),
  });
});

/**
 * Leaderboard.
 *
 * Wins are counted from the replayed `miningBlock.winner`, NOT from the
 * `BlockWon` event — that event only fires when a winner claims, so counting it
 * silently omits every win that has not been claimed yet, and a winner who never
 * claims would never appear at all.
 */
app.get('/mining/leaderboard', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 200);

  const won = await db
    .select({
      address: miningBlock.winner,
      wins: count(),
      totalWon: sum(miningBlock.scheduledReward),
    })
    .from(miningBlock)
    .where(isNotNull(miningBlock.winner))
    .groupBy(miningBlock.winner);

  const activity = await db.select().from(miner);
  const byAddr = new Map(activity.map((m) => [m.address.toLowerCase(), m]));

  const rows = won
    .map((w) => {
      const a = byAddr.get((w.address ?? '').toLowerCase());
      return {
        address: w.address,
        wins: Number(w.wins),
        totalWon: String(w.totalWon ?? '0'),
        commits: a?.commits ?? 0,
        reveals: a?.reveals ?? 0,
        meanDist: a && a.reveals > 0 ? Number(a.distSum / BigInt(a.reveals)) : null,
        /** A low rate means deposits are being forfeited to missed reveals. */
        revealRate: a && a.commits > 0 ? a.reveals / a.commits : null,
      };
    })
    .sort((x, y) => y.wins - x.wins || Number(BigInt(y.totalWon) - BigInt(x.totalWon)));

  // Participants who have not won anything still belong on the board.
  for (const a of activity) {
    if (!rows.some((r) => (r.address ?? '').toLowerCase() === a.address.toLowerCase())) {
      rows.push({
        address: a.address,
        wins: 0,
        totalWon: '0',
        commits: a.commits,
        reveals: a.reveals,
        meanDist: a.reveals > 0 ? Number(a.distSum / BigInt(a.reveals)) : null,
        revealRate: a.commits > 0 ? a.reveals / a.commits : null,
      });
    }
  }

  return c.json({ miners: rows.slice(0, limit) });
});

/**
 * Cumulative mint and burn totals.
 *
 * `burned` is the complete figure — every path that destroys BITHOOK ends in a
 * burn, so this needs no reconciling against the hook's four separate counters.
 * It is returned alongside them so a caller can derive the one nobody tracks:
 * emission from blocks that nobody won, minted and burned in the same
 * transaction and invisible everywhere else.
 */
app.get('/mining/supply', async (c) => {
  const [row] = await db.select().from(supply).limit(1);
  if (!row) return c.json({ error: 'not indexed yet' }, 503);
  return c.json({
    minted: row.minted.toString(),
    burned: row.burned.toString(),
    mintedToHook: row.mintedToHook.toString(),
    mintCount: row.mintCount,
    burnCount: row.burnCount,
    lastBlock: row.lastBlock.toString(),
    /** Must equal the token's totalSupply; a mismatch means this is wrong. */
    impliedSupply: (row.minted - row.burned).toString(),
  });
});

export default app;
