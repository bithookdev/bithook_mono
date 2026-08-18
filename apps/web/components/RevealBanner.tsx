'use client';

import { ADDRESSES, BLOCK_TIME, bithookHookAbi, blockAt, blockStart } from '@bithook/core';
import { useEffect, useRef, useState } from 'react';
import type { Hex } from 'viem';
import { useAccount, useReadContracts } from 'wagmi';

const hook = { address: ADDRESSES.hook, abi: bithookHookAbi } as const;
const ZERO32 = `0x${'0'.repeat(64)}` as Hex;

/**
 * Global "you must reveal" banner.
 *
 * Deliberately server-free. Real Web Push would need VAPID keys, stored
 * subscriptions and a backend, and it routes through Google/Mozilla/Apple push
 * services — the first thing on this site that would phone out to a third party,
 * after we proxied the RPC and skipped WalletConnect specifically to avoid that.
 *
 * The tradeoff is stated rather than hidden: notifications only fire while the
 * tab is open. The banner says so, and the tab title carries the countdown so a
 * backgrounded tab still shows it.
 *
 * Outstanding reveals are detected from `entries(n, address)` on-chain, not from
 * local storage, so a cleared browser or a different device still gets warned.
 */
export function RevealBanner() {
  const { address, isConnected } = useAccount();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const notifiedFor = useRef<string | null>(null);
  const originalTitle = useRef<string | null>(null);

  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const { data: startData } = useReadContracts({
    contracts: [{ ...hook, functionName: 'miningStart' }],
    query: { enabled: isConnected, refetchInterval: 60_000 },
  });
  const miningStart = (startData?.[0]?.result as bigint | undefined) ?? 0n;
  const armed = miningStart !== 0n;

  const nowSec = BigInt(Math.floor(nowMs / 1000));
  const current = armed && nowSec > miningStart ? blockAt(nowSec, miningStart) : 0n;
  const revealFor = current - 2n;

  const { data } = useReadContracts({
    contracts: [
      { ...hook, functionName: 'entries', args: [revealFor > 0n ? revealFor : 0n, address ?? '0x0'] },
    ],
    query: { enabled: Boolean(address) && armed && revealFor >= 0n, refetchInterval: 10_000 },
  });

  const entry = data?.[0]?.result as readonly [Hex, number, boolean] | undefined;
  const mustReveal = Boolean(entry && entry[0] !== ZERO32 && !entry[2]);

  const secondsLeft = armed ? Number(blockStart(current + 1n, miningStart) - nowSec) : 0;
  const mm = String(Math.floor(Math.max(0, secondsLeft) / 60)).padStart(2, '0');
  const ss = String(Math.max(0, secondsLeft) % 60).padStart(2, '0');

  // Fire once per block, when the window opens.
  useEffect(() => {
    if (!mustReveal) return;
    const key = `${address}:${revealFor}`;
    if (notifiedFor.current === key) return;
    notifiedFor.current = key;

    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        new Notification('Bithook — reveal now', {
          body: `Your prediction for block #${revealFor} must be revealed within 10 minutes or the deposit is burned.`,
          tag: `bithook-reveal-${revealFor}`,
          requireInteraction: true,
        });
      } catch {
        /* some browsers refuse constructor notifications; the banner still shows */
      }
    }
  }, [mustReveal, address, revealFor]);

  // Countdown in the tab title, so a backgrounded tab still shows it without
  // needing notification permission at all.
  useEffect(() => {
    if (originalTitle.current === null) originalTitle.current = document.title;
    if (mustReveal) {
      document.title = `⚠ REVEAL ${mm}:${ss} — Bithook`;
    } else if (originalTitle.current) {
      document.title = originalTitle.current;
    }
    return () => {
      if (originalTitle.current) document.title = originalTitle.current;
    };
  }, [mustReveal, mm, ss]);

  if (!mustReveal) return null;

  const urgent = secondsLeft < 180;

  return (
    <div className={`revealbar${urgent ? ' urgent' : ''}`} role="alert">
      <span className="rb-dot" aria-hidden="true" />
      <span className="rb-text">
        <b>Reveal your prediction for block #{revealFor.toString()}</b> — {mm}:{ss} left.
        Miss it and the deposit is burned.
      </span>
      <button
        type="button"
        className="btn rb-btn"
        onClick={() => document.querySelector('.mining')?.scrollIntoView({ block: 'center' })}
      >
        Go to reveal
      </button>
    </div>
  );
}

/**
 * Permission prompt must come from a user gesture, so this is exported for the
 * commit button to call rather than being requested on page load.
 */
export async function askNotificationPermission(): Promise<boolean> {
  if (typeof Notification === 'undefined') return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try {
    return (await Notification.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}
