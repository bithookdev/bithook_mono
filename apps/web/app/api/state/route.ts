import { NextResponse } from 'next/server';

import { getProtocolState } from '../../../lib/chain';

/**
 * Protocol state as JSON, so the live figures on the page can stay current
 * without re-rendering the whole route.
 *
 * Client polling rather than `router.refresh()` on a timer, for two reasons:
 *
 *  - A failed RSC fetch makes Next fall back to a full browser navigation,
 *    which reloads the page and loses scroll position. A changed build id on
 *    deploy forces the same fallback for any tab already open.
 *
 *  - The page route is ISR with `revalidate = 15`, which Next pairs with
 *    `stale-while-revalidate` of a year, so on a quiet site the first paint can
 *    be hours old.
 *
 * Polling this instead fixes both: no RSC round trip to fall back from, and a
 * stale first paint corrects itself within seconds instead of waiting for a
 * refresh that might reload the page.
 */

export const dynamic = 'force-dynamic';

const FRESH = { 'cache-control': 'public, s-maxage=5, stale-while-revalidate=15' } as const;
const DEGRADED = { 'cache-control': 'no-store' } as const;

/** Same in-process collapse as the other read routes: a crowd costs one RPC read. */
const CACHE_MS = 4_000;
let cache: { at: number; body: unknown } | null = null;

export async function GET() {
  if (cache && Date.now() - cache.at < CACHE_MS) {
    return NextResponse.json(cache.body as object, { headers: FRESH });
  }

  try {
    const s = await getProtocolState();
    // bigint does not survive JSON; every amount goes over as a decimal string.
    const body = {
      tick: s.tick,
      ethPerBithook: s.ethPerBithook,
      bithookPerEth: s.bithookPerEth,
      fdvEth: s.fdvEth,

      ethUsd: s.ethUsd,
      usdPerBithook: s.usdPerBithook,
      fdvUsd: s.fdvUsd,

      totalSupply: s.totalSupply.toString(),
      destroyed: s.destroyed.toString(),
      feeBurned: s.feeBurned.toString(),
      buybackBurned: s.buybackBurned.toString(),
      stakesBurned: s.stakesBurned.toString(),
      slashed: s.slashed.toString(),
      lockedStakes: s.lockedStakes.toString(),
      minedSoFar: s.minedSoFar.toString(),
      releasedByNow: s.releasedByNow.toString(),

      pendingEth: s.pendingEth.toString(),
      pendingToken: s.pendingToken.toString(),

      blockNumber: s.blockNumber.toString(),
      chainTime: s.chainTime.toString(),
      fetchedAt: s.fetchedAt,
    };
    cache = { at: Date.now(), body };
    return NextResponse.json(body, { headers: FRESH });
  } catch (err) {
    // Serve the last good reading rather than blanking every figure on the page
    // while an RPC hiccups.
    if (cache) {
      return NextResponse.json({ ...(cache.body as object), stale: true }, { headers: DEGRADED });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message.split('\n')[0] : 'unavailable' },
      { status: 503, headers: DEGRADED },
    );
  }
}
