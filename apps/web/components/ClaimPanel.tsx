'use client';

import { ADDRESSES, bithookHookAbi, blockAt } from '@bithook/core';
import { useEffect, useMemo, useState } from 'react';
import { formatUnits } from 'viem';
import type { Hex } from 'viem';
import { useAccount, useReadContracts, useWaitForTransactionReceipt, useWriteContract } from 'wagmi';

const hook = { address: ADDRESSES.hook, abi: bithookHookAbi } as const;

/** blocks(n) -> stakedTotal, returnedTotal, reward, winner, bestDist, bestTiebreak, emissionFinalized, claimed, burned */
type BlockRow = readonly [bigint, bigint, bigint, `0x${string}`, number, Hex, boolean, boolean, boolean];

const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });

/**
 * Blocks this address won but has not claimed.
 *
 * Scans a recent window on-chain rather than relying on events: `BlockWon` only
 * fires on claim, so an unclaimed win emits nothing at all and cannot be found
 * from logs. Phase B replaces this scan with an indexer lookup; until then a
 * bounded multicall is both correct and cheap.
 */
export function ClaimPanel({
  miningStart,
  chainTime,
  fetchedAt,
  window: windowSize = 60,
}: {
  miningStart: string;
  chainTime: string;
  fetchedAt: number;
  window?: number;
}) {
  const start = BigInt(miningStart);
  const armed = start !== 0n;
  const { address, isConnected } = useAccount();

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
    const t = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const current = armed ? blockAt(BigInt(Math.floor((nowMs + skew) / 1000)), start) : 0n;

  // Only settled blocks can be claimed: currentBlock must be > n + 2.
  const candidates = useMemo(() => {
    const out: bigint[] = [];
    const newest = current - 3n;
    for (let i = 0; i < windowSize; i++) {
      const n = newest - BigInt(i);
      if (n < 0n) break;
      out.push(n);
    }
    return out;
  }, [current, windowSize]);

  // Cast the RESULT, not the input: casting `contracts` to never makes wagmi
  // infer `data` as never too, and every `.result` access then fails to compile.
  const readRes = useReadContracts({
    contracts: candidates.map((n) => ({ ...hook, functionName: 'blocks', args: [n] })),
    query: { enabled: armed && isConnected && candidates.length > 0, refetchInterval: 60_000 },
  });
  const data = readRes.data as ReadonlyArray<{ result?: unknown }> | undefined;
  const refetch = readRes.refetch;

  const { writeContractAsync } = useWriteContract();
  const [txHash, setTxHash] = useState<Hex | undefined>();
  const [busy, setBusy] = useState<bigint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { isSuccess: done } = useWaitForTransactionReceipt({ hash: txHash });
  useEffect(() => {
    if (done) {
      refetch();
      setBusy(null);
      setTxHash(undefined);
    }
  }, [done, refetch]);

  const wins = useMemo(() => {
    if (!data || !address) return [];
    const me = address.toLowerCase();
    return candidates
      .map((n, i) => ({ n, row: data[i]?.result as BlockRow | undefined }))
      .filter(({ row }) => row && row[3].toLowerCase() === me && !row[7])
      .map(({ n, row }) => ({ n, reward: row![2] }));
  }, [data, candidates, address]);

  if (!armed || !isConnected || wins.length === 0) return null;

  const total = wins.reduce((a, w) => a + w.reward, 0n);

  async function claim(n: bigint) {
    setError(null);
    setBusy(n);
    try {
      setTxHash(await writeContractAsync({ ...hook, functionName: 'claimBlock', args: [n] }));
    } catch (e) {
      setError(e instanceof Error ? e.message.split('\n')[0] : String(e));
      setBusy(null);
    }
  }

  return (
    <div className="note claimbox">
      <span className="lbl">You won {wins.length} block{wins.length > 1 ? 's' : ''}</span>
      <p>
        {fmt(Number(formatUnits(total, 18)))} BITHOOK unclaimed. Claiming starts a
        vesting schedule rather than paying out at once — the tokens are minted as
        they vest. There is no deadline, and claiming later costs you nothing.
      </p>
      <div className="claimlist">
        {wins.slice(0, 8).map((w) => (
          <div className="claimrow" key={w.n.toString()}>
            <span className="cb">#{w.n.toString()}</span>
            <span className="cr">{fmt(Number(formatUnits(w.reward, 18)))} BITHOOK</span>
            <button
              type="button"
              className="btn inline"
              disabled={busy !== null}
              onClick={() => claim(w.n)}
            >
              {busy === w.n ? 'Confirm…' : 'Claim'}
            </button>
          </div>
        ))}
      </div>
      {wins.length > 8 && (
        <p className="pfine">
          Showing 8 of {wins.length}. The rest stay claimable — nothing expires.
        </p>
      )}
      {error && <p className="pfine">{error}</p>}
    </div>
  );
}
