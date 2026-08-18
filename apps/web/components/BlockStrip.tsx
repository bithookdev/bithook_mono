'use client';

import { BLOCK_TIME, blockAt, blockStart } from '@bithook/core';
import { useEffect, useMemo, useRef, useState } from 'react';

import { BlockDetail } from './BlockDetail';

/**
 * The mining pipeline as a row of blocks either side of a "now" divider.
 *
 * Three blocks are always in flight, so the left side is not a queue of pending
 * work but three distinct stages of the same cycle: one taking predictions, one
 * whose answer is forming, one taking reveals. Right of the divider are settled
 * blocks with their winner.
 *
 * Two deliberate choices:
 *
 *  - **Stage is derived from `n` versus the current block, never from the
 *    indexer.** The API exposes a `status` field, but nothing ever writes it —
 *    every block comes back "commit-open", including ones settled hours ago.
 *    Stage is a pure function of time anyway, and it changes every ten minutes
 *    with no event to trigger a write, so computing it here is both correct and
 *    the only thing that stays correct.
 *
 *  - **Chain time drives the cubes; the indexer only fills in counts.** Block
 *    numbers, stages and countdowns all come from `miningStart` plus the clock,
 *    so if the indexer is unreachable the strip still renders the right blocks
 *    at the right stages and the participation figures degrade to a dash. The
 *    reveal countdown in particular must never depend on an HTTP response.
 */

interface BlockRow {
  n: string;
  commits: number;
  reveals: number;
  targetTick: number | null;
  winner: string | null;
  reward: string;
  claimed: boolean;
  depositsBurned?: boolean;
}

type Stage = 'predict' | 'forming' | 'reveal' | 'settled';

const STAGE_LABEL: Record<Stage, string> = {
  predict: 'Taking predictions',
  forming: 'Answer forming',
  reveal: 'Taking reveals',
  settled: 'Settled',
};

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function tok(wei: string): string {
  const n = Number(wei) / 1e18;
  if (!Number.isFinite(n) || n === 0) return '0';
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function mmss(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function ago(seconds: number): string {
  const m = Math.floor(seconds / 60);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function BlockStrip({
  miningStart,
  chainTime,
  fetchedAt,
  ethUsd,
  settledCount = 6,
}: {
  miningStart: string;
  chainTime: string;
  fetchedAt: number;
  /** Passed through so the detail panel can price predictions in dollars. */
  ethUsd: number | null;
  /** How many settled blocks to show right of the divider. */
  settledCount?: number;
}) {
  const start = BigInt(miningStart);
  const armed = start !== 0n;

  // Same deterministic seeding as the other clocks: initial state comes from a
  // prop so the server render and hydration agree, then the effect goes live.
  const [skew] = useState(() => Number(chainTime) * 1000 - fetchedAt);
  const [nowMs, setNowMs] = useState(fetchedAt);
  useEffect(() => {
    setNowMs(Date.now());
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const railRef = useRef<HTMLDivElement | null>(null);
  const pinnedRight = useRef(false);
  const [rows, setRows] = useState<Map<string, BlockRow>>(new Map());
  const [selected, setSelected] = useState<bigint | null>(null);

  /**
   * The open block lives in the URL, so what you are looking at is what you can
   * share.
   *
   * Deliberately the History API rather than `useSearchParams`/`router.push`.
   * Two reasons: this route is statically prerendered, and reading search params
   * in a client component under it forces a Suspense boundary; more importantly
   * a router navigation would refetch the RSC payload, which is exactly the
   * mechanism removed earlier for reloading the page and losing scroll position.
   * `pushState` changes the URL and nothing else.
   */
  const [cameFromUrl, setCameFromUrl] = useState(false);
  useEffect(() => {
    const read = () => {
      const raw = new URLSearchParams(window.location.search).get('block');
      if (raw === null) return setSelected(null);
      try {
        const n = BigInt(raw);
        setSelected(n >= 0n ? n : null);
      } catch {
        setSelected(null);
      }
    };
    read();
    setCameFromUrl(new URLSearchParams(window.location.search).has('block'));
    // Back and forward move between blocks rather than off the page.
    window.addEventListener('popstate', read);
    return () => window.removeEventListener('popstate', read);
  }, []);

  const show = (n: bigint | null, replace = false) => {
    setSelected(n);
    const url = new URL(window.location.href);
    if (n === null) url.searchParams.delete('block');
    else url.searchParams.set('block', n.toString());
    const next = url.pathname + (url.search || '') + url.hash;
    if (replace) window.history.replaceState(null, '', next);
    else window.history.pushState(null, '', next);
  };
  const [reachable, setReachable] = useState(true);

  const chainNow = BigInt(Math.floor((nowMs + skew) / 1000));
  const current = armed ? blockAt(chainNow, start) : 0n;

  // Poll the indexer for participation figures. Deliberately not tied to the
  // countdown above: if this never resolves, the cubes still tick.
  useEffect(() => {
    if (!armed) return;
    let alive = true;
    const pull = async () => {
      try {
        const res = await fetch(`/api/mining/blocks?limit=${settledCount + 6}`, {
          cache: 'no-store',
        });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { blocks?: BlockRow[] };
        if (!alive) return;
        setRows(new Map((body.blocks ?? []).map((b) => [b.n, b])));
        setReachable(true);
      } catch {
        if (alive) setReachable(false);
      }
    };
    void pull();
    const t = setInterval(pull, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [armed, settledCount]);

  const cells = useMemo(() => {
    if (!armed) return [];
    const out: { n: bigint; stage: Stage }[] = [];
    // Time runs left to right: oldest settled block at the far left, the three
    // in flight at the right, newest of all on the end.
    //
    //   […#n-4][#n-3] │ now │ [#n-2][#n-1][#n]
    //
    // Note this is mirrored from mempool.space, which puts pending blocks left
    // and mined blocks right. Left-to-right chronology is the more conventional
    // timeline direction and is what was asked for here.
    for (let i = settledCount - 1; i >= 0; i--) {
      const n = current - 3n - BigInt(i);
      if (n < 0n) continue;
      out.push({ n, stage: 'settled' });
    }
    for (const offset of [2, 1, 0]) {
      const n = current - BigInt(offset);
      if (n < 0n) continue;
      out.push({ n, stage: (['predict', 'forming', 'reveal'] as Stage[])[offset]! });
    }
    return out;
  }, [armed, current, settledCount]);

  // Scroll to the live end once the cubes exist. Only the first time, so it
  // never yanks the rail back while someone is reading older blocks.
  useEffect(() => {
    if (pinnedRight.current || !railRef.current || cells.length === 0) return;
    railRef.current.scrollLeft = railRef.current.scrollWidth;
    pinnedRight.current = true;
  }, [cells.length]);

  if (!armed) return null;

  const secondsIntoBlock = Number(chainNow - blockStart(current, start));
  const elapsedFrac = Math.min(1, Math.max(0, secondsIntoBlock / Number(BLOCK_TIME)));

  return (
    <div className="strip">
      <div className="striprail" ref={railRef}>
        {cells.map(({ n, stage }, i) => {
          const row = rows.get(n.toString());
          const endsAt = blockStart(n + 3n, start); // reveal window closes here
          const rollsAt = blockStart(n + 1n, start);
          const revealOpensAt = blockStart(n + 2n, start);
          const settledFor = Number(chainNow - blockStart(n + 3n, start));

          // The active block fills as its ten minutes run down; the reveal block
          // fills toward its own deadline. Both are the same idea as a block
          // explorer's "in ~N minutes".
          const fill =
            stage === 'predict'
              ? elapsedFrac
              : stage === 'reveal'
                ? Math.min(1, Math.max(0, 1 - Number(endsAt - chainNow) / Number(BLOCK_TIME)))
                : stage === 'forming'
                  ? 1
                  : 0;

          const isDivider = stage !== 'settled' && cells[i - 1]?.stage === 'settled';

          return (
            <div className="cellwrap" key={n.toString()}>
              {isDivider && (
                <div className="nowmark" aria-hidden="true">
                  <span className="nowline" />
                  <span className="nowlabel">now</span>
                  <span className="nowline" />
                </div>
              )}
              <div className="cubewrap">
              <div className="cnum">#{n.toString()}</div>
              <button
                type="button"
                className={`cube s-${stage}${selected === n ? ' picked' : ''}`}
                onClick={() => show(selected === n ? null : n)}
                aria-expanded={selected === n}
                aria-label={`Block ${n.toString()}, ${STAGE_LABEL[stage].toLowerCase()}`}
              >
                <div className="cubetop" aria-hidden="true" />
                <div className="cubeside" aria-hidden="true" />
                <div className="cubeface">
                  <span className="cfill" style={{ height: `${fill * 100}%` }} aria-hidden="true" />
                  <div className="cbody">
                    <div className="cstage">{STAGE_LABEL[stage]}</div>

                    {stage === 'predict' && (
                      <>
                        <div className="cbig">{row ? row.commits : '—'}</div>
                        <div className="csub">
                          {row?.commits === 1 ? 'prediction in' : 'predictions in'}
                        </div>
                        <div className="cfoot">closes in {mmss(Number(rollsAt - chainNow))}</div>
                      </>
                    )}

                    {stage === 'forming' && (
                      <>
                        <div className="cbig">{row ? row.commits : '—'}</div>
                        <div className="csub">sealed, being scored</div>
                        <div className="cfoot">
                          reveals open in {mmss(Number(revealOpensAt - chainNow))}
                        </div>
                      </>
                    )}

                    {stage === 'reveal' && (
                      <>
                        <div className="cbig">
                          {row ? `${row.reveals}/${row.commits}` : '—'}
                        </div>
                        <div className="csub">revealed</div>
                        <div className="cfoot urgent">
                          closes in {mmss(Number(endsAt - chainNow))}
                        </div>
                      </>
                    )}

                    {stage === 'settled' && (
                      <>
                        <div className="cbig">{row ? tok(row.reward) : '—'}</div>
                        <div className="csub">BITHOOK to the closest</div>
                        <div className="cmeta">
                          {row?.targetTick !== null && row?.targetTick !== undefined
                            ? `tick ${row.targetTick.toLocaleString()}`
                            : 'tick —'}
                          {row ? ` · ${row.reveals}/${row.commits} revealed` : ''}
                        </div>
                        <div className="cfoot">{ago(settledFor)}</div>
                      </>
                    )}
                  </div>
                </div>
              </button>

              {selected === n && <div className="cpoint" aria-hidden="true" />}

              {/* Winner sits where a block explorer puts the pool name. */}
              <div className="cwinner">
                {stage === 'settled' ? (
                  row?.winner ? (
                    <a href={`/miners/${row.winner}`} className="wlink">
                      <span className={`wdot${row.claimed ? ' claimed' : ''}`} />
                      {short(row.winner)}
                    </a>
                  ) : row ? (
                    <span className="wnone">nobody revealed</span>
                  ) : (
                    <span className="wnone">—</span>
                  )
                ) : null}
              </div>
              </div>
            </div>
          );
        })}
      </div>

      {selected !== null && (
        <BlockDetail
          n={selected}
          ethUsd={ethUsd}
          scrollIntoView={cameFromUrl}
          onClose={() => show(null)}
          onNavigate={(to) => show(to < 0n ? 0n : to, true)}
        />
      )}

      {!reachable && (
        <p className="pfine">
          The indexer is unreachable, so the participation figures above are the
          last ones received and may be out of date. Block numbers, stages and
          countdowns are computed from the contract and are still correct.
        </p>
      )}
    </div>
  );
}
