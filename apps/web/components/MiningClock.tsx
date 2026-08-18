'use client';

import { BLOCK_TIME, blockAt, blockStart } from '@bithook/core';
import { useEffect, useState } from 'react';

/**
 * Announced start time for mining.
 *
 * This is a stated intention, NOT something the contract enforces. `startMining()`
 * is an owner call with no deadline anywhere in the bytecode, so this countdown
 * reaching zero does not start anything on its own — the UI has to say so, or it
 * implies a guarantee the chain does not make.
 */
const PLANNED_START_MS = Date.UTC(2026, 7, 15, 14, 0, 0); // 15 Aug 2026, 14:00 UTC

function twoDigit(n: number) {
  return String(Math.max(0, Math.floor(n))).padStart(2, '0');
}

/**
 * Live clock for the mining pipeline.
 *
 * Blocks are pure functions of time — block n starts at `miningStart + 600n` —
 * so this is computed locally from one on-chain number rather than polled.
 *
 * Time is anchored to the CHAIN's clock, not the browser's. The contract decides
 * which block you are in using `block.timestamp`, so a visitor whose machine is a
 * minute off would otherwise be shown the wrong block, and near a rollover would
 * be told a window is still open when the chain has already closed it.
 */
export function MiningClock({
  miningStart,
  chainTime,
  fetchedAt,
}: {
  miningStart: string;
  chainTime: string;
  fetchedAt: number;
}) {
  const start = BigInt(miningStart);
  const armed = start !== 0n;

  // Difference between chain time and this browser's clock, in ms.
  const [skew] = useState(() => Number(chainTime) * 1000 - fetchedAt);
  // Seeded from `fetchedAt`, NOT Date.now(). The first render has to be identical
  // on the server and during hydration, and Date.now() differs between them by the
  // page's transit time plus up to `revalidate` seconds of ISR cache age — so any
  // rendered clock mismatched, React threw away the server HTML and re-rendered the
  // whole page on the client (minified error #418). Combined with `skew` this
  // resolves to exactly chainTime on both sides; the effect below then switches to
  // live time on the first client tick.
  const [nowMs, setNowMs] = useState(fetchedAt);

  useEffect(() => {
    setNowMs(Date.now());
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const chainNowMs = nowMs + skew;

  // ---- not armed: count down to the announced time -----------------------
  if (!armed) {
    const left = PLANNED_START_MS - chainNowMs;
    const past = left <= 0;
    const s = Math.max(0, Math.floor(left / 1000));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;

    return (
      <div className="clock">
        <div className="clockhead">
          <div>
            <div className="k">Mining is planned to start</div>
            <div className="blocknum">15 Aug 2026, 14:00 UTC</div>
          </div>
          <div className="countdown">
            <div className="k">{past ? 'Planned time has passed' : 'Approximately'}</div>
            <div className="timer">
              {past ? '--:--' : `${d}d ${twoDigit(h)}:${twoDigit(m)}:${twoDigit(sec)}`}
            </div>
          </div>
        </div>

        <div className="note">
          <span className="lbl">This countdown is not enforced by the contract</span>
          <p>
            {past
              ? 'The announced time has passed. Mining begins only when startMining() is actually called, and the contract sets no deadline for it.'
              : 'It counts down to a time the deployer has stated. The contract has no scheduled start and no deadline — mining begins only when startMining() is actually called, which could be later than this, or not at all.'}{' '}
            Until that transaction lands, every mining function reverts.
          </p>
        </div>
      </div>
    );
  }

  // ---- armed: live block pipeline ---------------------------------------
  const chainNow = BigInt(Math.floor(chainNowMs / 1000));
  const current = blockAt(chainNow, start);
  const endsAt = blockStart(current + 1n, start);
  const remaining = Number(endsAt - chainNow);
  const elapsedFrac = 1 - Math.max(0, remaining) / Number(BLOCK_TIME);


  return (
    <div className="clock">
      <div className="clockhead">
        <div>
          <div className="k">Block</div>
          <div className="blocknum">{current.toString()}</div>
        </div>
        <div className="countdown">
          <div className="k">Rolls over in</div>
          <div className="timer">
            {twoDigit(Math.floor(Math.max(0, remaining) / 60))}:
            {twoDigit(Math.max(0, remaining) % 60)}
          </div>
        </div>
      </div>

      <div className="progress" aria-hidden="true">
        <span style={{ width: `${Math.min(100, Math.max(0, elapsedFrac * 100))}%` }} />
      </div>

    </div>
  );
}
