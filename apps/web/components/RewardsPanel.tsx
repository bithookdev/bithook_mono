'use client';

import { ADDRESSES, EXIT_SLASH_BPS, bithookHookAbi } from '@bithook/core';
import { useEffect, useMemo, useState } from 'react';
import { formatUnits } from 'viem';
import type { Hex } from 'viem';
import { useAccount, useReadContracts, useWaitForTransactionReceipt, useWriteContract } from 'wagmi';

const hook = { address: ADDRESSES.hook, abi: bithookHookAbi } as const;
const fmt = (n: number, d = 2) => n.toLocaleString('en-US', { maximumFractionDigits: d });
const tok = (wei: bigint, d = 2) => fmt(Number(formatUnits(wei, 18)), d);

/** vestsOf(who, i) -> total, released, start, duration, exited */
type Vest = readonly [bigint, bigint, bigint, number, boolean];

interface Lock {
  slice: string;
  amount: string;
  unlockAt: number;
  unlocked: boolean;
}

/**
 * Vesting and deposit withdrawal.
 *
 * Two separate pots that people confuse:
 *
 *  - **Deposits** are yours already. They came back the moment you revealed, and
 *    are simply time-locked before they can be withdrawn.
 *  - **Rewards** are minted gradually. Claiming created the schedule; the tokens
 *    do not exist until they vest and you unlock them.
 *
 * Early exit is shown as an exact token amount rather than "50%", because the
 * slash applies only to the *unvested* remainder and the real number is always
 * smaller than people assume from the percentage.
 */
export function RewardsPanel({ locks = [] }: { locks?: Lock[] }) {
  const { address, isConnected } = useAccount();
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 15_000);
    return () => clearInterval(t);
  }, []);

  const { data: countData } = useReadContracts({
    contracts: [{ ...hook, functionName: 'vestCount', args: [address ?? '0x0'] }],
    query: { enabled: Boolean(address), refetchInterval: 30_000 },
  });
  const vestCount = Number((countData?.[0]?.result as bigint | undefined) ?? 0n);

  const ids = useMemo(
    () => Array.from({ length: Math.min(vestCount, 50) }, (_, i) => BigInt(i)),
    [vestCount],
  );

  const vestRes = useReadContracts({
    contracts: ids.map((i) => ({ ...hook, functionName: 'vestsOf', args: [address ?? '0x0', i] })),
    query: { enabled: Boolean(address) && ids.length > 0, refetchInterval: 30_000 },
  });
  const vestRows = vestRes.data as ReadonlyArray<{ result?: unknown }> | undefined;
  const refetch = vestRes.refetch;

  const { writeContractAsync } = useWriteContract();
  const [txHash, setTxHash] = useState<Hex | undefined>();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmExit, setConfirmExit] = useState(false);
  const { isSuccess: done } = useWaitForTransactionReceipt({ hash: txHash });
  useEffect(() => {
    if (done) {
      refetch();
      setBusy(null);
      setTxHash(undefined);
      setConfirmExit(false);
    }
  }, [done, refetch]);

  const vests = useMemo(() => {
    if (!vestRows) return [];
    return ids
      .map((id, i) => ({ id, v: vestRows[i]?.result as Vest | undefined }))
      .filter((x): x is { id: bigint; v: Vest } => Boolean(x.v))
      .filter((x) => !x.v[4] && x.v[0] > 0n)
      .map(({ id, v }) => {
        const [total, released, start, duration] = v;
        const elapsed = BigInt(Math.max(0, nowSec - Number(start)));
        const d = BigInt(duration);
        const vested = elapsed >= d ? total : (total * elapsed) / d;
        return {
          id,
          total,
          released,
          claimable: vested > released ? vested - released : 0n,
          unvested: total - vested,
          pct: d === 0n ? 1 : Math.min(1, Number(elapsed) / Number(d)),
          endsAt: Number(start) + duration,
        };
      });
  }, [vestRows, ids, nowSec]);

  const totalClaimable = vests.reduce((a, v) => a + v.claimable, 0n);
  const totalUnvested = vests.reduce((a, v) => a + v.unvested, 0n);
  // Early exit slashes only the unvested part, and only half of that.
  const exitSlash = (totalUnvested * EXIT_SLASH_BPS) / 10_000n;
  const exitPayout = totalClaimable + (totalUnvested - exitSlash);

  const readyLocks = locks.filter(
    (l) => !l.unlocked && Number(l.amount) > 0 && l.unlockAt <= nowSec,
  );
  const pendingLocks = locks.filter(
    (l) => !l.unlocked && Number(l.amount) > 0 && l.unlockAt > nowSec,
  );

  if (!isConnected || (vests.length === 0 && locks.length === 0)) return null;

  async function send(label: string, fn: () => Promise<Hex>) {
    setError(null);
    setBusy(label);
    try {
      setTxHash(await fn());
    } catch (e) {
      setError(e instanceof Error ? e.message.split('\n')[0] : String(e));
      setBusy(null);
    }
  }

  return (
    <div className="rewards">
      {vests.length > 0 && (
        <div className="panel rpanel">
          <div className="k">Rewards vesting</div>
          <div className="grid">
            <div className="stat">
              <div className="k">Available now</div>
              <div className="v accent">{tok(totalClaimable)}</div>
              <div className="n">BITHOOK, minted when you unlock</div>
            </div>
            <div className="stat">
              <div className="k">Still vesting</div>
              <div className="v">{tok(totalUnvested)}</div>
              <div className="n">across {vests.length} reward{vests.length > 1 ? 's' : ''}</div>
            </div>
          </div>

          <div className="vlist">
            {vests.map((v) => (
              <div className="vrow" key={v.id.toString()}>
                <div className="vbar" aria-hidden="true">
                  <span style={{ width: `${Math.round(v.pct * 100)}%` }} />
                </div>
                <span className="vamt">{tok(v.claimable)} ready</span>
                <span className="vtot">of {tok(v.total)}</span>
              </div>
            ))}
          </div>

          <button
            type="button"
            className="btn full"
            disabled={busy !== null || totalClaimable === 0n}
            onClick={() =>
              send('unlock', () =>
                writeContractAsync({
                  ...hook,
                  functionName: 'unlockVested',
                  args: [vests.map((v) => v.id)],
                }),
              )
            }
          >
            {busy === 'unlock' ? 'Confirm in wallet…' : `Unlock ${tok(totalClaimable)} BITHOOK`}
          </button>

          {totalUnvested > 0n && (
            <div className="exitbox">
              {!confirmExit ? (
                <button type="button" className="btn ghost full" onClick={() => setConfirmExit(true)}>
                  Exit early instead
                </button>
              ) : (
                <div className="note danger">
                  <span className="lbl">You would destroy {tok(exitSlash)} BITHOOK</span>
                  <p>
                    Exiting now pays you <b>{tok(exitPayout)}</b> immediately and burns{' '}
                    <b>{tok(exitSlash)}</b> — half of the {tok(totalUnvested)} that has
                    not vested yet. Waiting costs nothing and the full amount arrives
                    on its own.
                  </p>
                  <div className="exitrow">
                    <button type="button" className="btn ghost" onClick={() => setConfirmExit(false)}>
                      Keep vesting
                    </button>
                    <button
                      type="button"
                      className="btn"
                      disabled={busy !== null}
                      onClick={() =>
                        send('exit', () =>
                          writeContractAsync({
                            ...hook,
                            functionName: 'exitEarly',
                            args: [vests.map((v) => v.id)],
                          }),
                        )
                      }
                    >
                      {busy === 'exit' ? 'Confirm…' : `Exit and burn ${tok(exitSlash)}`}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {(readyLocks.length > 0 || pendingLocks.length > 0) && (
        <div className="panel rpanel">
          <div className="k">Deposits</div>
          <p className="pfine">
            Already yours — returned when you revealed, held for part of the era
            before withdrawal.
          </p>
          {readyLocks.map((l) => (
            <div className="lrow" key={l.slice}>
              <span className="lamt">{tok(BigInt(l.amount))} BITHOOK</span>
              <button
                type="button"
                className="btn inline"
                disabled={busy !== null}
                onClick={() =>
                  send(`lock-${l.slice}`, () =>
                    writeContractAsync({
                      ...hook,
                      functionName: 'unlockStakes',
                      args: [BigInt(l.slice)],
                    }),
                  )
                }
              >
                {busy === `lock-${l.slice}` ? 'Confirm…' : 'Withdraw'}
              </button>
            </div>
          ))}
          {pendingLocks.map((l) => (
            <div className="lrow muted" key={l.slice}>
              <span className="lamt">{tok(BigInt(l.amount))} BITHOOK</span>
              <span className="lwhen">
                unlocks in {Math.ceil((l.unlockAt - nowSec) / 3600)}h
              </span>
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="note danger">
          <span className="lbl">Failed</span>
          <p>{error}</p>
        </div>
      )}
    </div>
  );
}
