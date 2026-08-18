import { ponder } from 'ponder:registry';
import './mining.js';
import './supply.js';

import {
  boundary,
  burn,
  feeTaken,
  miningBlock,
  swap,
} from 'ponder:schema';

const abs = (v: bigint) => (v < 0n ? -v : v);

ponder.on('PoolManager:Swap', async ({ event, context }) => {
  const { amount0, amount1, tick, sqrtPriceX96, sender } = event.args;

  // Deltas are from the swapper's perspective: negative means they paid it.
  // Paying ETH (currency0) is therefore a buy. Derived once, here, so the API
  // and the UI can never disagree about which way round a trade was.
  const kind = amount0 < 0n ? 'buy' : 'sell';

  await context.db.insert(swap).values({
    id: `${event.transaction.hash}:${event.log.logIndex}`,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
    txHash: event.transaction.hash,
    logIndex: event.log.logIndex,
    sender,
    kind,
    eth: abs(amount0),
    bithook: abs(amount1),
    tick,
    sqrtPriceX96,
  });
});

ponder.on('BithookHook:HookFeeTaken', async ({ event, context }) => {
  const zero = '0x0000000000000000000000000000000000000000';
  await context.db.insert(feeTaken).values({
    id: `${event.transaction.hash}:${event.log.logIndex}`,
    timestamp: event.block.timestamp,
    txHash: event.transaction.hash,
    currency: event.args.currency,
    isEth: event.args.currency.toLowerCase() === zero,
    amount: event.args.amount,
  });
});

// --- burns that really destroy supply -------------------------------------

ponder.on('BithookHook:FeesBurned', async ({ event, context }) => {
  await context.db.insert(burn).values({
    id: `${event.transaction.hash}:${event.log.logIndex}`,
    timestamp: event.block.timestamp,
    blockNumber: event.block.number,
    txHash: event.transaction.hash,
    kind: 'fee',
    amount: event.args.amount,
    ethSpent: null,
    destroysSupply: true,
  });
});

ponder.on('BithookHook:BoughtBackAndBurned', async ({ event, context }) => {
  await context.db.insert(burn).values({
    id: `${event.transaction.hash}:${event.log.logIndex}`,
    timestamp: event.block.timestamp,
    blockNumber: event.block.number,
    txHash: event.transaction.hash,
    kind: 'buyback',
    amount: event.args.bithookBurned,
    ethSpent: event.args.ethSpent,
    destroysSupply: true,
  });
});

ponder.on('BithookHook:StakesBurned', async ({ event, context }) => {
  await context.db.insert(burn).values({
    id: `${event.transaction.hash}:${event.log.logIndex}`,
    timestamp: event.block.timestamp,
    blockNumber: event.block.number,
    txHash: event.transaction.hash,
    kind: 'unrevealedStake',
    amount: event.args.amount,
    ethSpent: null,
    destroysSupply: true,
  });
  // Same event also settles the mining block's deposit state.
  await context.db
    .update(miningBlock, { n: event.args.blockId })
    .set({ depositsBurned: true })
    .catch(() => undefined);
});

// --- emission that was never issued (net-zero on supply) ------------------

/*
 * `BithookHook:EarlyExited` is handled in mining.ts.
 *
 * Ponder permits one handler per event, and the burn row has to be written
 * beside the vest attribution (vest.exited, vest.slashed) so the two cannot
 * drift apart.
 */

// --- mining lifecycle ------------------------------------------------------

ponder.on('BithookHook:Checkpointed', async ({ event, context }) => {
  // Boundaries arrive out of order — one call can emit up to 32 at once — so
  // this is keyed by boundary index rather than appended.
  await context.db
    .insert(boundary)
    .values({
      id: event.args.boundary,
      cumulative: event.args.cumulative,
      timestamp: event.block.timestamp,
    })
    .onConflictDoNothing();
});
