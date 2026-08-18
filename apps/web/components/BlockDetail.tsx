'use client';

import { tickToEthPerBithook } from '@bithook/core';
import { useEffect, useRef, useState } from 'react';

import { plain, usd } from '../lib/format';

/**
 * Detail for one mining block, opened by clicking a cube in the strip.
 *
 * The point of this panel is to make a scored block legible: what the answer
 * turned out to be, who was closest, and by how much. A tick distance is the
 * contract's unit but means nothing to a reader, so every distance is also
 * shown as the percentage the prediction was off by — 1.0001^dist - 1, which is
 * exactly what a tick gap means in price terms.
 *
 * Ranking is computed here rather than read from the API. The contract stores
 * only the leader, not an ordering, so the standings are derived by sorting
 * reveals on the same `dist` the chain emitted with each one.
 */

interface Reveal {
  who: string;
  tick: number;
  dist: string;
  ts: number;
  hash: string;
}

interface BlockJson {
  n: string;
  reward: string;
  deposit: string;
  commits: number;
  reveals: number;
  targetTick: number | null;
  targetResolvable: boolean;
  winner: string | null;
  claimed: boolean;
}

interface VestJson {
  total: string;
  released: string;
  slashed: string;
  exited: boolean;
  startTs: number;
  duration: number;
}

interface MinerJson {
  address: string;
  wins: number;
  commits: number;
  reveals: number;
  totalWon: string;
}

const ETHERSCAN = 'https://etherscan.io';
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const tok = (wei: string) => {
  const v = Number(wei) / 1e18;
  if (!Number.isFinite(v)) return '—';
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(2)}k`;
  return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
};

/** A tick gap expressed as the price difference it represents. */
function offByPct(distTicks: number): number {
  return Math.expm1(distTicks * Math.log1p(1e-4)) * 100;
}

export function BlockDetail({
  n,
  ethUsd,
  scrollIntoView = false,
  onClose,
  onNavigate,
}: {
  n: bigint;
  /** Set when the panel was opened from a shared URL rather than a click. */
  scrollIntoView?: boolean;
  /** For showing predictions in dollars. Null when the price feed is stale. */
  ethUsd: number | null;
  onClose: () => void;
  onNavigate: (to: bigint) => void;
}) {
  const [data, setData] = useState<{ block: BlockJson; vest: VestJson | null; reveals: Reveal[] } | null>(null);
  const [winner, setWinner] = useState<MinerJson | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'missing' | 'error'>('loading');
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    setState('loading');
    setData(null);
    setWinner(null);

    (async () => {
      try {
        const res = await fetch(`/api/mining/blocks/${n.toString()}`, { cache: 'no-store' });
        if (res.status === 404) {
          if (alive) setState('missing');
          return;
        }
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { block: BlockJson; vest: VestJson | null; reveals: Reveal[] };
        if (!alive) return;
        setData(body);
        setState('ok');

        // Second hop, deliberately not blocking the panel: the winner's history
        // is context, and the block itself should render without it.
        if (body.block.winner) {
          const m = await fetch(`/api/mining/miner/${body.block.winner}`, { cache: 'no-store' });
          if (m.ok && alive) {
            const mj = (await m.json()) as { miner: MinerJson };
            setWinner(mj.miner ?? null);
          }
        }
      } catch {
        if (alive) setState('error');
      }
    })();

    return () => {
      alive = false;
    };
  }, [n]);

  // Only when arriving from a link — clicking a cube should never yank the page.
  const scrolled = useRef(false);
  useEffect(() => {
    if (!scrollIntoView || scrolled.current || state !== 'ok') return;
    scrolled.current = true;
    // Not scrollIntoView with block:'center' — the panel runs well over a
    // viewport tall once the standings table fills in, so centring it drops the
    // reader into the middle of the table. Land just above the header instead.
    const el = panelRef.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top + window.scrollY - 90;
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }, [scrollIntoView, state]);

  const block = data?.block;
  const target = block?.targetTick ?? null;

  const ranked = (data?.reveals ?? [])
    .map((r) => ({ ...r, distNum: Number(r.dist) }))
    .sort((a, b) => a.distNum - b.distNum);

  const burned = block ? Math.max(0, block.commits - block.reveals) : 0;

  return (
    <div className="bdetail" ref={panelRef}>
      <div className="bdhead">
        <div className="bdtitle">
          <button
            type="button"
            className="bdnav"
            onClick={() => onNavigate(n - 1n)}
            disabled={n <= 0n}
            aria-label="Previous block"
          >
            ‹
          </button>
          <a className="bdn bdperma" href={`/blocks/${n.toString()}`} title="Open this block on its own page">
            Block #{n.toString()}
            <span className="bdpermaicon" aria-hidden="true">↗</span>
          </a>
          <button
            type="button"
            className="bdnav"
            onClick={() => onNavigate(n + 1n)}
            aria-label="Next block"
          >
            ›
          </button>
        </div>
        <button type="button" className="bdclose" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      {state === 'loading' && <p className="bdmsg">Loading block…</p>}
      {state === 'missing' && (
        <p className="bdmsg">
          Nothing indexed for this block yet. Blocks appear here once someone commits
          to them.
        </p>
      )}
      {state === 'error' && (
        <p className="bdmsg">
          The indexer is unreachable, so this block&rsquo;s detail cannot be shown. The
          countdowns and block numbers above still come from the contract.
        </p>
      )}

      {state === 'ok' && block && (
        <>
          <div className="bdfacts">
            <div className="bdfact">
              <span className="k">The answer</span>
              {target !== null ? (
                <>
                  <span className="v">tick {target.toLocaleString()}</span>
                  <span className="n">
                    {plain(tickToEthPerBithook(target))} ETH
                    {ethUsd !== null && <> · {usd(tickToEthPerBithook(target) * ethUsd, 5)}</>}
                  </span>
                </>
              ) : (
                <>
                  <span className="v">not yet</span>
                  <span className="n">the average is still being measured</span>
                </>
              )}
            </div>

            <div className="bdfact">
              <span className="k">Reward</span>
              <span className="v">{tok(block.reward)}</span>
              <span className="n">
                BITHOOK
                {!block.winner
                  ? ''
                  : data?.vest
                    ? ` · releasing over ${Math.round(data.vest.duration / 86400)} days`
                    : block.claimed
                      ? ' · vesting'
                      : ' · not claimed yet'}
              </span>
            </div>

            {data?.vest?.exited && (
              <div className="bdfact">
                <span className="k">Taken early</span>
                <span className="v bdburn">−{tok(data.vest.slashed)}</span>
                <span className="n">
                  BITHOOK destroyed by exiting the vest before it finished
                </span>
              </div>
            )}

            <div className="bdfact">
              <span className="k">Took part</span>
              <span className="v">
                {block.reveals}/{block.commits}
              </span>
              <span className="n">
                revealed
                {burned > 0 && (
                  <>
                    {' · '}
                    <span className="bdburn">
                      {burned} deposit{burned > 1 ? 's' : ''} burned
                    </span>
                  </>
                )}
              </span>
            </div>
          </div>

          {block.winner && (
            <div className="bdwinner">
              <span className="k">Won by</span>
              <div className="bdwrow">
                <a
                  className="bdaddr"
                  href={`${ETHERSCAN}/address/${block.winner}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {short(block.winner)}
                </a>
                <a className="bdsub" href={`/miners/${block.winner}`}>
                  miner page
                </a>
                {winner && (
                  <span className="bdsub">
                    {winner.wins} block{winner.wins === 1 ? '' : 's'} won so far ·{' '}
                    {winner.reveals}/{winner.commits} revealed · {tok(winner.totalWon)} BITHOOK
                    total
                  </span>
                )}
              </div>
            </div>
          )}

          {ranked.length > 0 ? (
            <div className="bdtablewrap">
              <table className="bdtable">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Miner</th>
                    <th className="num">Predicted</th>
                    {ethUsd !== null && <th className="num">In dollars</th>}
                    <th className="num">Off by</th>
                    <th className="num">Ticks</th>
                    <th>Tx</th>
                  </tr>
                </thead>
                <tbody>
                  {ranked.map((r, i) => {
                    const price = tickToEthPerBithook(r.tick);
                    return (
                      <tr
                        key={r.hash + r.who}
                        className={
                          block.winner && r.who.toLowerCase() === block.winner.toLowerCase()
                            ? 'bdwin'
                            : undefined
                        }
                      >
                        <td>{i + 1}</td>
                        <td>
                          <a
                            href={`${ETHERSCAN}/address/${r.who}`}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {short(r.who)}
                          </a>
                        </td>
                        <td className="num">{plain(price)}</td>
                        {ethUsd !== null && (
                          <td className="num">{usd(price * ethUsd, 5)}</td>
                        )}
                        <td className="num">
                          {target === null ? '—' : `${offByPct(r.distNum).toFixed(2)}%`}
                        </td>
                        <td className="num">{r.distNum.toLocaleString()}</td>
                        <td>
                          <a
                            href={`${ETHERSCAN}/tx/${r.hash}`}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            view
                          </a>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="bdmsg">
              {block.commits > 0
                ? `${block.commits} prediction${block.commits > 1 ? 's' : ''} committed, none revealed yet. Predictions stay sealed until their reveal window opens.`
                : 'Nobody has committed to this block.'}
            </p>
          )}

          {block.winner && (
            <p className="pfine">
              Claiming a block does not pay it out. It starts a vesting schedule the
              length of the era, and the tokens are minted only as they release —
              so a claimed block is not the same as a collected one.
            </p>
          )}

          <p className="pfine">
            &ldquo;Off by&rdquo; is the distance between a prediction and the answer,
            expressed as the price difference it represents. Ranking is derived from the
            distances the contract emitted; ties are broken on an address hash, so the
            top row is not always the winner.
          </p>
        </>
      )}
    </div>
  );
}
