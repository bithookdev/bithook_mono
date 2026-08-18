'use client';

import { MAX_SUPPLY } from '@bithook/core';
import { useEffect, useState } from 'react';

import { plain, usd } from '../lib/format';

/**
 * The figures on the page that have to keep moving.
 *
 * Each group is seeded with the server render, so the first paint is immediate
 * and correct-looking, then polls /api/state and replaces itself. Nothing here
 * re-renders the route, which is the point: the previous approach called
 * `router.refresh()` on a timer, and when that RSC fetch failed — including
 * after every deploy, when the build id changes — Next fell back to a full
 * browser navigation that reloaded the page and lost the reader's scroll
 * position.
 *
 * Seeding also covers the other complaint. The route is ISR with a
 * stale-while-revalidate window of a year, so a quiet period could leave the
 * cached HTML hours old. Now a stale first paint corrects itself on the first
 * poll instead of persisting until someone hard-reloads.
 */

export interface StateJson {
  tick: number;
  ethPerBithook: number;
  bithookPerEth: number;
  fdvEth: number;
  ethUsd: number | null;
  usdPerBithook: number | null;
  fdvUsd: number | null;
  totalSupply: string;
  destroyed: string;
  feeBurned: string;
  buybackBurned: string;
  stakesBurned: string;
  slashed: string;
  lockedStakes: string;
  minedSoFar: string;
  releasedByNow: string;
  pendingEth: string;
  pendingToken: string;
  blockNumber: string;
  chainTime: string;
  fetchedAt: number;
}

const fmt = (n: number, d = 0) =>
  n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

function tok(wei: string, digits = 2): string {
  const n = Number(wei) / 1e18;
  if (!Number.isFinite(n) || n === 0) return '0';
  if (n >= 1e6) return `${fmt(n / 1e6, 2)}M`;
  if (n >= 1e3) return `${fmt(n / 1e3, 1)}k`;
  if (n < 0.01) return '<0.01';
  return fmt(n, digits);
}

const eth = (wei: string, d = 4) => fmt(Number(wei) / 1e18, d);

/**
 * One poll, shared by every consumer.
 *
 * Five card groups read this state. Each running its own timer would mean five
 * identical requests every tick for one set of numbers, so the fetch lives at
 * module scope and components subscribe to it. The timer only runs while at
 * least one is mounted and the tab is visible.
 */
const subscribers = new Set<(s: StateJson) => void>();
let latest: StateJson | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
let inflight: Promise<void> | null = null;

async function pullShared(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch('/api/state', { cache: 'no-store' });
      if (!res.ok) return;
      const body = (await res.json()) as StateJson;
      // Never move backwards: a stale-served response would make the page look
      // like it jumped back in time.
      if (!latest || body.fetchedAt >= latest.fetchedAt) {
        latest = body;
        for (const fn of subscribers) fn(body);
      }
    } catch {
      // Leave the last good values on screen.
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function useLiveState(initial: StateJson, intervalMs = 10_000): StateJson {
  const [state, setState] = useState<StateJson>(() =>
    latest && latest.fetchedAt >= initial.fetchedAt ? latest : initial,
  );

  useEffect(() => {
    const onUpdate = (s: StateJson) => setState(s);
    subscribers.add(onUpdate);

    const start = () => {
      if (!timer) timer = setInterval(() => void pullShared(), intervalMs);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    };
    // A backgrounded tab has nobody reading it; catch up on return rather than
    // waiting out the interval.
    const onVisibility = () => {
      if (document.hidden) stop();
      else {
        void pullShared();
        start();
      }
    };

    void pullShared();
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      subscribers.delete(onUpdate);
      document.removeEventListener('visibilitychange', onVisibility);
      if (subscribers.size === 0) stop();
    };
  }, [intervalMs]);

  return state;
}

// ---------------------------------------------------------------------------

export function PoolCards({ initial }: { initial: StateJson }) {
  const s = useLiveState(initial);
  return (
    <>
      <div className="grid">
        <div className="stat">
          <div className="k">Price</div>
          <div className="v accent">
            {s.usdPerBithook !== null ? usd(s.usdPerBithook, 8) : plain(s.ethPerBithook)}
          </div>
          <div className="n">
            {s.usdPerBithook !== null ? (
              <>per BITHOOK · {plain(s.ethPerBithook)} ETH</>
            ) : (
              'ETH per BITHOOK'
            )}
          </div>
        </div>
        <div className="stat">
          <div className="k">Fully diluted</div>
          <div className="v">{fmt(s.fdvEth, 2)} ETH</div>
          <div className="n">
            {s.fdvUsd !== null ? `${usd(s.fdvUsd, 0)} · ` : ''}against the 21M cap
          </div>
        </div>
        <div className="stat">
          <div className="k">Pool tick</div>
          <div className="v">{fmt(s.tick)}</div>
          <div className="n">{fmt(s.bithookPerEth)} BITHOOK per ETH</div>
        </div>
      </div>
      {s.ethUsd !== null && (
        <p className="pfine">
          Dollar amounts are a reference conversion, not a price you can trade at.
          They are the pool tick multiplied by a Chainlink ETH/USD reading, and both
          of those move continuously.
        </p>
      )}
    </>
  );
}

export function MiningTotals({ initial }: { initial: StateJson }) {
  const s = useLiveState(initial);
  return (
    <div className="grid">
      <div className="stat">
        <div className="k">Mined so far</div>
        <div className="v">{tok(s.minedSoFar)}</div>
        <div className="n">BITHOOK minted to miners</div>
      </div>
      <div className="stat">
        <div className="k">Released by schedule</div>
        <div className="v">{tok(s.releasedByNow)}</div>
        <div className="n">emission earmarked to date</div>
      </div>
      <div className="stat">
        <div className="k">Deposits locked</div>
        <div className="v">{tok(s.lockedStakes)}</div>
        <div className="n">miner capital under lock</div>
      </div>
    </div>
  );
}

export function SupplyCards({ initial }: { initial: StateJson }) {
  const s = useLiveState(initial);
  return (
    <div className="grid">
      <div className="stat">
        <div className="k">Total supply</div>
        <div className="v">{tok(s.totalSupply)}</div>
        <div className="n">of {tok(MAX_SUPPLY.toString())} cap</div>
      </div>
      <div className="stat">
        <div className="k">Supply destroyed</div>
        <div className="v accent">{tok(s.destroyed)}</div>
        <div className="n">
          {tok(s.feeBurned)} fees · {tok(s.buybackBurned)} buyback ·{' '}
          {tok(s.stakesBurned)} deposits
        </div>
      </div>
      <div className="stat">
        <div className="k">Given up by early exit</div>
        <div className="v">{tok(s.slashed)}</div>
        <div className="n">
          half of unreleased rewards, taken early · minted and burned in the same
          transaction, so net-zero on supply
        </div>
      </div>
      <div className="stat">
        <div className="k">Fees awaiting burn</div>
        <div className="v">{eth(s.pendingEth)} ETH</div>
        <div className="n">plus {tok(s.pendingToken)} BITHOOK</div>
      </div>
    </div>
  );
}

/** Block height and read time in the footer, so staleness is visible. */
export function LiveFooter({ initial }: { initial: StateJson }) {
  const s = useLiveState(initial);
  return (
    <>
      Block {s.blockNumber} · read {new Date(s.fetchedAt).toISOString()} · no
      professional firm has audited this software
    </>
  );
}
