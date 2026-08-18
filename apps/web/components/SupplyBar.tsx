'use client';

import { MAX_SUPPLY } from '@bithook/core';
import { useEffect, useState } from 'react';

import { useLiveState, type StateJson } from './LiveFigures';

/**
 * The 21 million ceiling, split into what exists, what has been destroyed, and
 * what is still to come.
 *
 * The destroyed figure comes from the indexer's burn counter rather than the
 * hook's own totals, because the hook counts each path separately — fee burns,
 * buybacks, forfeited deposits, early-exit slashing — and a block that nobody
 * wins mints and burns its reward without touching any of them. Summing the
 * token's own burns catches every path at once, and reconciles exactly:
 * `minted - burned` equals `totalSupply` to the wei.
 *
 * Destroyed supply genuinely lowers the ceiling. `scheduledBlockReward` is a
 * pure function of the block index, so nothing lost is reissued later — the
 * schedule simply moves on.
 *
 * If the indexer is unreachable the bar hides rather than guessing: the cards
 * above already carry the individual figures, and a bar drawn from an incomplete
 * burn total would understate what is gone.
 */

const fmt = (n: number, d = 0) =>
  n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

function tok(v: number): string {
  if (v >= 1e6) return `${fmt(v / 1e6, 2)}M`;
  if (v >= 1e3) return `${fmt(v / 1e3, 1)}k`;
  return fmt(v, 2);
}

export function SupplyBar({ initial }: { initial: StateJson }) {
  const s = useLiveState(initial);
  const [burnedWei, setBurnedWei] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const pull = async () => {
      try {
        const res = await fetch('/api/mining/supply', { cache: 'no-store' });
        if (!res.ok) return;
        const body = (await res.json()) as { burned?: string };
        if (alive && body.burned) setBurnedWei(body.burned);
      } catch {
        // Leave the last good value; the bar hides if there never was one.
      }
    };
    void pull();
    const t = setInterval(pull, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (burnedWei === null) return null;

  const cap = Number(MAX_SUPPLY) / 1e18;
  const existing = Number(s.totalSupply) / 1e18;
  const destroyed = Number(burnedWei) / 1e18;
  const toMine = Math.max(0, cap - existing - destroyed);

  const pct = (v: number) => (v / cap) * 100;
  const ceiling = cap - destroyed;

  return (
    <div className="supbar">
      <div className="supbarhead">
        <span className="k">Of the 21 million ceiling</span>
        <span className="supdestroyed">
          &minus;{fmt(destroyed)} <span className="supceilsub">destroyed, permanently</span>
        </span>
      </div>

      <div
        className="supbartrack"
        role="img"
        aria-label={`Of a 21 million ceiling: ${tok(existing)} in existence, ${tok(toMine)} still to be mined, ${tok(destroyed)} destroyed. ${fmt(ceiling)} can still ever exist.`}
      >
        <span className="supseg exists" style={{ width: `${pct(existing)}%` }} />
        <span className="supseg future" style={{ width: `${pct(toMine)}%` }} />
        <span className="supseg gone" style={{ width: `${pct(destroyed)}%` }} />
      </div>

      {/* The reachable ceiling as its own band: everything except the destroyed
          tail. Shown under the track rather than inside it so the three parts
          still sum to the 21M the track represents. */}
      <div className="supceilrow">
        <span className="supceilband" style={{ width: `${pct(existing) + pct(toMine)}%` }} />
        <span className="supceillabel" style={{ width: `${pct(existing) + pct(toMine)}%` }}>
          {fmt(ceiling)} can still ever exist
        </span>
      </div>

      <div className="suplegend">
        <span className="supitem">
          <span className="supdot exists" />
          <b>{tok(existing)}</b> in existence
          <span className="suppct">{pct(existing).toFixed(1)}%</span>
        </span>
        <span className="supitem">
          <span className="supdot future" />
          <b>{tok(toMine)}</b> still to be mined
          <span className="suppct">{pct(toMine).toFixed(1)}%</span>
        </span>
        <span className="supitem">
          <span className="supdot gone" />
          <b>{tok(destroyed)}</b> destroyed
          <span className="suppct">{pct(destroyed).toFixed(1)}%</span>
        </span>
      </div>

      <p className="pfine">
        Destroyed BITHOOK does not come back. The emission schedule is a function of
        time rather than of supply, so nothing burned is reissued later — every
        destruction lowers the ceiling permanently. The ceiling is a limit rather
        than a target in any case: the schedule halves forever, approaching 10.5
        million mined without ever quite arriving.
      </p>
    </div>
  );
}
