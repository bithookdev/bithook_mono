'use client';

import { useEffect, useState } from 'react';

interface Reveal {
  who: string;
  tick: number;
  dist: string;
  ts: number;
  hash: string;
}
interface BlockData {
  n: string;
  targetTick: number | null;
  targetResolvable: boolean;
  commits: number;
  reveals: number;
  winner: string | null;
  bestDist: string | null;
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * Live standings while a reveal window is open.
 *
 * The target becomes public the moment the window opens, so every revealed
 * prediction can be scored immediately and openly — there is nothing secret left
 * to protect at this point. Reveals that have not happened yet simply are not
 * here; a commitment stays sealed until its owner opens it.
 */
export function RevealBoard({ blockId, you }: { blockId: string; you?: string }) {
  const [data, setData] = useState<{ block: BlockData; reveals: Reveal[] } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    async function pull() {
      try {
        const res = await fetch(`/api/mining/blocks/${blockId}`, { cache: 'no-store' });
        if (!res.ok) throw new Error(String(res.status));
        const j = await res.json();
        if (alive) {
          setData(j);
          setFailed(false);
        }
      } catch {
        if (alive) setFailed(true);
      }
    }
    void pull();
    const t = setInterval(pull, 6_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [blockId]);

  if (failed && !data) return null;
  if (!data) return <div className="feed empty">Loading standings…</div>;

  const { block, reveals } = data;
  if (reveals.length === 0) {
    return (
      <div className="feed empty">
        {block.commits > 0
          ? `${block.commits} sealed prediction${block.commits > 1 ? 's' : ''} for block #${block.n}, none opened yet.`
          : `No predictions for block #${block.n}.`}
      </div>
    );
  }

  const sorted = [...reveals].sort((a, b) => Number(BigInt(a.dist) - BigInt(b.dist)));
  const me = you?.toLowerCase();

  return (
    <div className="board">
      <div className="boardhead">
        <span>
          Block #{block.n} · target tick{' '}
          <b>{block.targetTick !== null ? block.targetTick.toLocaleString() : '—'}</b>
        </span>
        <span className="bmuted">
          {block.reveals} of {block.commits} opened
        </span>
      </div>
      {sorted.map((r, i) => (
        <div
          className={`brow${r.who.toLowerCase() === me ? ' mine' : ''}${i === 0 ? ' lead' : ''}`}
          key={`${r.who}-${r.hash}`}
        >
          <span className="brank">{i + 1}</span>
          <span className="bwho">
            {short(r.who)}
            {r.who.toLowerCase() === me && <b> you</b>}
          </span>
          <span className="btick">{r.tick.toLocaleString()}</span>
          <span className="bdist">{Number(r.dist).toLocaleString()} off</span>
        </div>
      ))}
      <p className="pfine">
        Leading now, not final — anyone still holding a sealed prediction can
        overtake this until the window closes.
      </p>
    </div>
  );
}
