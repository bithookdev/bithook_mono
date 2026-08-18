import { NextResponse } from 'next/server';

/**
 * Read-only pass-through to the indexer's /mining/* endpoints.
 *
 * The indexer is bound to loopback and never exposed by nginx, so the browser
 * cannot reach it directly — and should not, since that would also mean shipping
 * its address to every visitor. This proxies only the paths we serve, with a
 * short cache so a page full of people polling collapses into one query.
 */

export const dynamic = 'force-dynamic';

const INDEXER_URL = process.env.BITHOOK_INDEXER_URL ?? 'http://127.0.0.1:42069';
const CACHE_MS = 4_000;

/** Only these shapes are proxied; anything else 404s rather than being forwarded. */
const ALLOWED = [
  /^blocks$/,
  /^blocks\/\d+$/,
  /^miner\/0x[0-9a-fA-F]{40}$/,
  /^leaderboard$/,
  /^supply$/,
];

const cache = new Map<string, { at: number; body: unknown }>();

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


export async function GET(
  req: Request,
  ctx: { params: Promise<{ path: string[] }> },
) {
  const { path } = await ctx.params;
  const sub = (path ?? []).join('/');
  if (!ALLOWED.some((re) => re.test(sub))) {
    return NextResponse.json({ error: 'not found' }, { status: 404, headers: DEGRADED });
  }

  const qs = new URL(req.url).searchParams.toString();
  const key = qs ? `${sub}?${qs}` : sub;

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return NextResponse.json(hit.body as object, { headers: { ...FRESH, 'x-cache': 'hit' } });
  }

  try {
    const res = await fetch(`${INDEXER_URL}/mining/${key}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`indexer ${res.status}`);
    const body = await res.json();

    cache.set(key, { at: Date.now(), body });
    // Bounded so a crawler hitting many block ids cannot grow this forever.
    if (cache.size > 500) cache.delete(cache.keys().next().value as string);

    return NextResponse.json(body, { headers: FRESH });
  } catch (err) {
    if (hit) return NextResponse.json(hit.body as object, { headers: { ...DEGRADED, 'x-cache': 'stale' } });
    return NextResponse.json(
      { error: err instanceof Error ? err.message.split('\n')[0] : 'indexer unavailable' },
      { status: 503, headers: DEGRADED },
    );
  }
}
