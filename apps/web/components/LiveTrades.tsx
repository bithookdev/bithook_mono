'use client';

import { useEffect, useRef, useState } from 'react';

interface Trade {
  hash: string;
  block: string;
  logIndex: number;
  kind: 'buy' | 'sell';
  eth: string;
  bithook: string;
  tick: number;
  ts: number | null;
}

const key = (t: Trade) => `${t.hash}:${t.logIndex}`;

function fmtEth(wei: string): string {
  const n = Number(wei) / 1e18;
  if (n === 0) return '0';
  if (n < 0.0001) return '<0.0001';
  return n.toLocaleString('en-US', { maximumFractionDigits: n < 1 ? 4 : 3 });
}

function fmtTok(wei: string): string {
  const n = Number(wei) / 1e18;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function ago(ts: number | null): string {
  if (!ts) return '';
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export function LiveTrades() {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const seen = useRef<Set<string>>(new Set());
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  // Re-render on a timer so the relative timestamps keep counting up.
  const [, tick] = useState(0);

  useEffect(() => {
    let alive = true;

    async function pull() {
      try {
        const res = await fetch('/api/trades', { cache: 'no-store' });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as { trades: Trade[] };
        if (!alive) return;

        const incoming = data.trades ?? [];
        const isFirstLoad = seen.current.size === 0;
        const newOnes = new Set<string>();
        for (const t of incoming) {
          const k = key(t);
          // Never highlight on first paint, or the whole list flashes at once.
          if (!seen.current.has(k) && !isFirstLoad) newOnes.add(k);
          seen.current.add(k);
        }
        setTrades(incoming);
        setFailed(false);
        setLoading(false);
        if (newOnes.size > 0) {
          setFresh(newOnes);
          setTimeout(() => alive && setFresh(new Set()), 2000);
        }
      } catch {
        if (alive) {
          setLoading(false);
          setFailed(true);
        }
      }
    }

    void pull();
    const poll = setInterval(pull, 10_000);
    const clock = setInterval(() => tick((n) => n + 1), 15_000);
    return () => {
      alive = false;
      clearInterval(poll);
      clearInterval(clock);
    };
  }, []);

  if (loading) return <div className="feed empty">Loading recent trades…</div>;
  if (failed && trades.length === 0)
    return <div className="feed empty">Could not load trades just now.</div>;
  if (trades.length === 0)
    return <div className="feed empty">No trades in the last couple of hours.</div>;

  return (
    <div className="feed">
      {trades.map((t) => (
        <a
          key={key(t)}
          className={`trade ${t.kind} ${fresh.has(key(t)) ? 'fresh' : ''}`}
          href={`https://etherscan.io/tx/${t.hash}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          <span className={`side ${t.kind}`}>{t.kind === 'buy' ? 'Bought' : 'Sold'}</span>
          <span className="amt">{fmtTok(t.bithook)} BITHOOK</span>
          <span className="for">for</span>
          <span className="amt eth">{fmtEth(t.eth)} ETH</span>
          <span className="when">{ago(t.ts)}</span>
        </a>
      ))}
    </div>
  );
}
