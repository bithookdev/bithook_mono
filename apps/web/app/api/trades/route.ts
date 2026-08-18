import { NextResponse } from 'next/server';

/**
 * Recent swaps, read from the Ponder indexer.
 *
 * A thin pass-through. Querying eth_getLogs per request would depend on the RPC
 * serving log queries, see only one query window back, and handle no reorgs; the
 * indexer does getLogs once during backfill, follows the chain head, and reverts
 * its own writes on reorgs.
 */

export const dynamic = 'force-dynamic';

const INDEXER_URL = process.env.BITHOOK_INDEXER_URL ?? 'http://127.0.0.1:42069';
const CACHE_MS = 4_000;

interface Payload {
  trades: unknown[];
}

let cache: { at: number; body: Payload } | null = null;

/**
 * Edge cache policy.
 *
 * `s-maxage` applies to shared caches (Cloudflare) but not the browser, so a
 * visitor still gets a fresh response per navigation while a crowd collapses
 * into one origin hit per window. Kept short because the reveal board is read
 * during a live 10-minute window and stale standings there are misleading.
 *
 * Degraded responses are deliberately NOT cacheable: pinning a 503 or a stale
 * body at the edge would stretch a momentary indexer restart into a window
 * where every visitor sees the failure.
 */
const FRESH = { 'cache-control': 'public, s-maxage=5, stale-while-revalidate=30' } as const;
const DEGRADED = { 'cache-control': 'no-store' } as const;


export async function GET() {
  if (cache && Date.now() - cache.at < CACHE_MS) {
    return NextResponse.json({ ...cache.body, cached: true }, { headers: FRESH });
  }

  try {
    const res = await fetch(`${INDEXER_URL}/trades?limit=30`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`indexer ${res.status}`);

    const body = (await res.json()) as Payload;
    cache = { at: Date.now(), body };
    return NextResponse.json(body, { headers: FRESH });
  } catch (err) {
    // Serve stale rather than blanking the feed while the indexer restarts.
    if (cache) return NextResponse.json({ ...cache.body, stale: true }, { headers: DEGRADED });
    return NextResponse.json(
      {
        trades: [],
        error: err instanceof Error ? err.message.split('\n')[0] : 'indexer unavailable',
      },
      { status: 503, headers: DEGRADED },
    );
  }
}
