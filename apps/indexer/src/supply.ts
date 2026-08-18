import { ADDRESSES } from '@bithook/core';
import { ponder } from 'ponder:registry';
import { supply } from 'ponder:schema';

/**
 * Cumulative mint and burn accounting for BITHOOK.
 *
 * Why this is worth indexing when the hook already exposes four burn counters:
 * those four do not add up to everything destroyed. `totalFeeBurned`,
 * `totalBuybackBurned`, `totalBurnedStakes` and `totalSlashed` each cover one
 * path, but a block that nobody wins mints its reward and burns it in the same
 * transaction inside `_finalizeBlock`, touching none of them, yet that emission
 * is gone from the 21M ceiling.
 *
 * Summing the token's own Transfers to and from the zero address catches every
 * path at once — including any added later — and gives an invariant to check
 * against the chain: `minted - burned` must equal `totalSupply`.
 *
 * The no-winner figure then falls out by subtraction, with no tx-level
 * correlation needed:
 *
 *   noWinnerEmission = burned - feeBurned - buybackBurned - stakesBurned - slashed
 */

const ROW = 'bithook' as const;

async function bump(
  context: any,
  patch: {
    minted?: bigint;
    burned?: bigint;
    mintedToHook?: bigint;
    mintCount?: number;
    burnCount?: number;
  },
  blockNumber: bigint,
) {
  await context.db
    .insert(supply)
    .values({
      id: ROW,
      minted: patch.minted ?? 0n,
      burned: patch.burned ?? 0n,
      mintedToHook: patch.mintedToHook ?? 0n,
      mintCount: patch.mintCount ?? 0,
      burnCount: patch.burnCount ?? 0,
      lastBlock: blockNumber,
    })
    .onConflictDoUpdate((row: any) => ({
      minted: row.minted + (patch.minted ?? 0n),
      burned: row.burned + (patch.burned ?? 0n),
      mintedToHook: row.mintedToHook + (patch.mintedToHook ?? 0n),
      mintCount: row.mintCount + (patch.mintCount ?? 0),
      burnCount: row.burnCount + (patch.burnCount ?? 0),
      lastBlock: blockNumber,
    }));
}

ponder.on('BithookMint:Transfer', async ({ event, context }) => {
  const toHook = event.args.to.toLowerCase() === ADDRESSES.hook.toLowerCase();
  await bump(
    context,
    {
      minted: event.args.amount,
      mintCount: 1,
      // The first leg of a mint-and-burn pair always lands on the hook, so this
      // bounds how much of the minted total was never really issued to anyone.
      mintedToHook: toHook ? event.args.amount : 0n,
    },
    event.block.number,
  );
});

ponder.on('BithookBurn:Transfer', async ({ event, context }) => {
  await bump(
    context,
    { burned: event.args.amount, burnCount: 1 },
    event.block.number,
  );
});
