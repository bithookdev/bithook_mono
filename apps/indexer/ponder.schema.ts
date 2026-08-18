import { index, onchainTable } from 'ponder';

/**
 * Every swap on the BITHOOK pool.
 *
 * `kind` is derived once at write time rather than in the API: the deltas are
 * from the swapper's side, so paying ETH (amount0 < 0) is a buy. Getting that
 * backwards inverts the whole feed, so it is computed in exactly one place.
 */
export const swap = onchainTable(
  'swap',
  (t) => ({
    id: t.text().primaryKey(), // `${txHash}:${logIndex}`
    blockNumber: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
    logIndex: t.integer().notNull(),
    sender: t.hex().notNull(),
    kind: t.text().notNull(), // 'buy' | 'sell'
    /** Absolute ETH moved, in wei. */
    eth: t.bigint().notNull(),
    /** Absolute BITHOOK moved, in wei. */
    bithook: t.bigint().notNull(),
    tick: t.integer().notNull(),
    sqrtPriceX96: t.bigint().notNull(),
  }),
  (t) => ({
    byBlock: index().on(t.blockNumber),
    byTime: index().on(t.timestamp),
  }),
);

/** Fee accrual, per swap. Currency is native ETH or BITHOOK. */
export const feeTaken = onchainTable('fee_taken', (t) => ({
  id: t.text().primaryKey(),
  timestamp: t.bigint().notNull(),
  txHash: t.hex().notNull(),
  currency: t.hex().notNull(),
  isEth: t.boolean().notNull(),
  amount: t.bigint().notNull(),
}));

/**
 * The burn ledger.
 *
 * `destroysSupply` is the distinction the whole dashboard hangs on: fee burns,
 * buyback burns and forfeited stakes remove tokens that existed. Unwon block
 * rewards and early-exit slashes are minted and burned in one transaction, so
 * they never entered supply at all. Summing the two would roughly double the
 * apparent burn.
 */
export const burn = onchainTable('burn', (t) => ({
  id: t.text().primaryKey(),
  timestamp: t.bigint().notNull(),
  blockNumber: t.bigint().notNull(),
  txHash: t.hex().notNull(),
  kind: t.text().notNull(), // 'fee' | 'buyback' | 'unrevealedStake' | 'exitSlash'
  amount: t.bigint().notNull(),
  /** ETH spent, for buybacks only. */
  ethSpent: t.bigint(),
  destroysSupply: t.boolean().notNull(),
}));

/** Mining lifecycle, for when mining is armed. */
export const miningCommit = onchainTable('mining_commit', (t) => ({
  id: t.text().primaryKey(), // `${blockId}:${who}`
  blockId: t.bigint().notNull(),
  who: t.hex().notNull(),
  timestamp: t.bigint().notNull(),
  txHash: t.hex().notNull(),
}));

export const miningReveal = onchainTable('mining_reveal', (t) => ({
  id: t.text().primaryKey(), // `${blockId}:${who}`
  blockId: t.bigint().notNull(),
  who: t.hex().notNull(),
  tick: t.integer().notNull(),
  dist: t.bigint().notNull(),
  timestamp: t.bigint().notNull(),
  txHash: t.hex().notNull(),
}));

/** TWAP checkpoints. Gaps here are what strand a block's target permanently. */
export const boundary = onchainTable('boundary', (t) => ({
  id: t.bigint().primaryKey(), // boundary index
  cumulative: t.bigint().notNull(),
  timestamp: t.bigint().notNull(),
}));

/** Claimed blocks. Only emitted on claim, never on finalization. */
export const blockWon = onchainTable('block_won', (t) => ({
  id: t.bigint().primaryKey(), // mining block id
  winner: t.hex().notNull(),
  reward: t.bigint().notNull(),
  targetTick: t.integer().notNull(),
  timestamp: t.bigint().notNull(),
  txHash: t.hex().notNull(),
}));

/**
 * One row per mining block, materialised from time rather than from events.
 *
 * Most blocks emit nothing at all, so an events-only index cannot tell that a
 * block existed and went unclaimed. A block-interval handler fills these in.
 */
export const miningBlock = onchainTable(
  'mining_block',
  (t) => ({
    n: t.bigint().primaryKey(),
    startTs: t.bigint().notNull(),
    era: t.integer().notNull(),
    lockSlice: t.integer().notNull(),
    /** Pure functions of n — same values the contract computes. */
    scheduledReward: t.bigint().notNull(),
    deposit: t.bigint().notNull(),
    vestDuration: t.integer().notNull(),

    commitCount: t.integer().notNull().default(0),
    revealCount: t.integer().notNull().default(0),

    /** Null until boundaries n+1 and n+2 both exist. */
    targetTick: t.integer(),
    targetResolvable: t.boolean().notNull().default(false),

    winner: t.hex(),
    bestDist: t.bigint(),
    bestTiebreak: t.hex(),

    emissionFinalized: t.boolean().notNull().default(false),
    claimed: t.boolean().notNull().default(false),
    depositsBurned: t.boolean().notNull().default(false),

    status: t.text().notNull().default('commit-open'),
  }),
  (t) => ({
    byStart: index().on(t.startTs),
    byWinner: index().on(t.winner),
  }),
);

/** Per-address rollup, for the leaderboard and miner pages. */
export const miner = onchainTable(
  'miner',
  (t) => ({
    address: t.hex().primaryKey(),
    commits: t.integer().notNull().default(0),
    reveals: t.integer().notNull().default(0),
    wins: t.integer().notNull().default(0),
    totalWon: t.bigint().notNull().default(0n),
    /** Sum of |prediction - target| over reveals, for a mean distance. */
    distSum: t.bigint().notNull().default(0n),
    bestDist: t.bigint(),
    depositsForfeited: t.bigint().notNull().default(0n),
    /** Rewards destroyed by exiting vests early. */
    slashedTotal: t.bigint().notNull().default(0n),
    firstSeenTs: t.bigint().notNull(),
    lastSeenTs: t.bigint().notNull(),
  }),
  (t) => ({ byWins: index().on(t.wins) }),
);

/** Deposit locks, per (address, slice). */
export const depositLock = onchainTable('deposit_lock', (t) => ({
  id: t.text().primaryKey(), // `${address}:${slice}`
  address: t.hex().notNull(),
  slice: t.bigint().notNull(),
  amount: t.bigint().notNull(),
  unlockAt: t.bigint().notNull(),
  unlockedAt: t.bigint(),
}));

/** Vesting entries created on claim. */
export const vest = onchainTable('vest', (t) => ({
  id: t.text().primaryKey(), // `${address}:${vestId}`
  address: t.hex().notNull(),
  vestId: t.bigint().notNull(),
  blockN: t.bigint(),
  total: t.bigint().notNull(),
  released: t.bigint().notNull().default(0n),
  startTs: t.bigint().notNull(),
  duration: t.integer(),
  exited: t.boolean().notNull().default(false),
  slashed: t.bigint().notNull().default(0n),
}));

/**
 * Transaction hash to vest key.
 *
 * `VestCreated` knows the vest id but not which block won it; `BlockWon` fires
 * later in the same transaction and knows the block but not the vest id. This
 * bridges them with a primary-key lookup, so the vest itself can be keyed
 * `address:vestId` — the form `EarlyExited` needs, since that event names vest
 * ids and nothing else.
 */
export const vestByTx = onchainTable('vest_by_tx', (t) => ({
  id: t.text().primaryKey(), // transaction hash
  vestKey: t.text().notNull(),
}));

/** Indexer bookkeeping: how far the block materialiser has run. */
export const cursor = onchainTable('cursor', (t) => ({
  id: t.text().primaryKey(),
  value: t.bigint().notNull(),
}));

/**
 * Cumulative mint and burn totals for BITHOOK. A single row.
 *
 * This exists because no on-chain counter covers every way supply is destroyed:
 * the hook tracks fee burns, buybacks, forfeited deposits and early-exit
 * slashing separately, and the mint-and-burn a no-winner block performs is
 * tracked nowhere at all. Summing the token's own mints and burns catches all of
 * it, and yields an invariant worth asserting: `minted - burned == totalSupply`.
 */
export const supply = onchainTable('supply', (t) => ({
  id: t.text().primaryKey(),
  minted: t.bigint().notNull().default(0n),
  burned: t.bigint().notNull().default(0n),
  mintCount: t.integer().notNull().default(0),
  burnCount: t.integer().notNull().default(0),
  /** Mints into the hook itself — the first leg of every mint-and-burn pair. */
  mintedToHook: t.bigint().notNull().default(0n),
  lastBlock: t.bigint().notNull().default(0n),
}));
