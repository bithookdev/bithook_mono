'use client';

import {
  ADDRESSES,
  BLOCK_TIME,
  bithookHookAbi,
  bithookTokenAbi,
  blockAt,
  blockStart,
  commitmentHash,
  bithookPerEthToTick,
  ethPerBithookToTick,
  scheduledBlockReward,
  stakeFor,
  tickToBithookPerEth,
  vestDurationFor,
  tickToEthPerBithook,
} from '@bithook/core';
import { useEffect, useMemo, useState } from 'react';
import { formatUnits, maxUint256 } from 'viem';
import type { Address, Hex } from 'viem';
import {
  useAccount,
  useChainId,
  usePublicClient,
  useReadContracts,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWalletClient,
  useWriteContract,
} from 'wagmi';
import { mainnet } from 'wagmi/chains';

import { ClaimPanel } from './ClaimPanel';
import { RevealBoard } from './RevealBoard';
import { RewardsPanel } from './RewardsPanel';
import { askNotificationPermission } from './RevealBanner';
import { plain, usd } from '../lib/format';
import { deriveSalt, forgetTick, recallTick, recoverTick, rememberTick } from '../lib/salt';

const hook = { address: ADDRESSES.hook, abi: bithookHookAbi } as const;
const token = { address: ADDRESSES.token, abi: bithookTokenAbi } as const;

const fmt = (n: number, d = 2) =>
  n.toLocaleString('en-US', { maximumFractionDigits: d });

/** entries(n, who) -> [commitment, tick, revealed] */
type Entry = readonly [Hex, number, boolean];

export function MiningPanel({
  miningStart,
  chainTime,
  fetchedAt,
  currentTick,
  ethUsd,
}: {
  miningStart: string;
  chainTime: string;
  fetchedAt: number;
  /** Live pool tick, so a prediction can be shown relative to the market. */
  currentTick: number;
  /** ETH/USD from Chainlink, or null if the feed was stale. Every dollar figure
   *  below is conditional on this, so a dead feed hides them rather than
   *  showing a stale conversion next to a live token price. */
  ethUsd: number | null;
}) {
  const start = BigInt(miningStart);
  const armed = start !== 0n;
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();
  const { data: wallet } = useWalletClient();
  const publicClient = usePublicClient();

  // Chain time, not browser time — the contract decides your block from
  // block.timestamp, and a skewed clock would show the wrong window.
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
  const chainNow = BigInt(Math.floor((nowMs + skew) / 1000));

  const current = armed ? blockAt(chainNow, start) : 0n;
  const revealFor = current - 2n; // reveal(n) is only valid while currentBlock == n+2
  const secondsLeft = armed ? Number(blockStart(current + 1n, start) - chainNow) : 0;

  const deposit = armed ? stakeFor(current) : 0n;
  const vestDays = armed ? Math.round(Number(vestDurationFor(current)) / 86400) : 0;
  const reward = armed ? scheduledBlockReward(current) : 0n;

  // Everything about the user's position comes from the chain, so a cleared
  // browser or a different device still shows an outstanding reveal.
  const { data: reads, refetch } = useReadContracts({
    contracts: [
      { ...token, functionName: 'allowance', args: [address ?? '0x0', ADDRESSES.hook] },
      { ...token, functionName: 'balanceOf', args: [address ?? '0x0'] },
      { ...hook, functionName: 'entries', args: [current, address ?? '0x0'] },
      { ...hook, functionName: 'entries', args: [revealFor > 0n ? revealFor : 0n, address ?? '0x0'] },
      { ...hook, functionName: 'targetAvailable', args: [revealFor > 0n ? revealFor : 0n] },
    ],
    query: { enabled: Boolean(address) && armed, refetchInterval: 12_000 },
  });

  const allowance = (reads?.[0]?.result as bigint | undefined) ?? 0n;
  const balance = (reads?.[1]?.result as bigint | undefined) ?? 0n;
  const entryNow = reads?.[2]?.result as Entry | undefined;
  const entryReveal = reads?.[3]?.result as Entry | undefined;
  const targetReady = (reads?.[4]?.result as boolean | undefined) ?? false;

  const hasCommittedNow = Boolean(entryNow && entryNow[0] !== `0x${'0'.repeat(64)}`);
  const mustReveal = Boolean(
    entryReveal && entryReveal[0] !== `0x${'0'.repeat(64)}` && !entryReveal[2],
  );

  const [price, setPrice] = useState('');
  /** Which way round the price is typed. Neither unit is "right" — people think
   *  in both, and the tiny ETH-per-token number is easy to mistype by a zero. */
  const [unit, setUnit] = useState<'ethPerTok' | 'tokPerEth'>('ethPerTok');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const { writeContractAsync } = useWriteContract();
  const [txHash, setTxHash] = useState<Hex | undefined>();
  const { isSuccess: txDone } = useWaitForTransactionReceipt({ hash: txHash });
  useEffect(() => {
    if (txDone) {
      refetch();
      setBusy(null);
      setTxHash(undefined);
    }
  }, [txDone, refetch]);

  // Deposit locks come from the indexer: the contract has no way to enumerate a
  // user's slices, only to read one you already know the number of.
  const [locks, setLocks] = useState<
    { slice: string; amount: string; unlockAt: number; unlocked: boolean }[]
  >([]);
  useEffect(() => {
    if (!address) return;
    let alive = true;
    fetch(`/api/mining/miner/${address}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (alive && j?.locks) setLocks(j.locks); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [address, txDone]);

  const tick = useMemo(() => {
    const p = Number(price);
    if (!price || !Number.isFinite(p) || p <= 0) return null;
    try {
      return unit === 'ethPerTok' ? ethPerBithookToTick(p) : bithookPerEthToTick(p);
    } catch {
      return null;
    }
  }, [price, unit]);

  /** Fill the box from a tick, in whichever unit is selected. */
  const setFromTick = (t: number) =>
    setPrice(
      unit === 'ethPerTok'
        ? plain(tickToEthPerBithook(t), 6)
        : String(Math.round(tickToBithookPerEth(t))),
    );

  // Percentage move implied by the prediction. This is the real safety net: a
  // mistyped zero shows up immediately as an absurd percentage rather than as a
  // plausible-looking number.
  const deltaPct = useMemo(() => {
    if (tick === null) return null;
    return (Math.exp((currentTick - tick) * Math.log1p(1e-4)) - 1) * 100;
  }, [tick, currentTick]);

  // Dollars per BITHOOK at the live pool tick. Everything shown in dollars below
  // is derived from this, so there is one place where a stale feed switches all
  // of them off together rather than leaving some card showing a stale number.
  const usdPerTok = ethUsd === null ? null : tickToEthPerBithook(currentTick) * ethUsd;
  const rewardTok = Number(formatUnits(reward, 18));
  const depositTok = Number(formatUnits(deposit, 18));

  const wrongChain = isConnected && chainId !== mainnet.id;

  async function run(label: string, fn: () => Promise<Hex>) {
    setError(null);
    setNote(null);
    setBusy(label);
    try {
      setTxHash(await fn());
    } catch (e) {
      setError(e instanceof Error ? e.message.split('\n')[0] : String(e));
      setBusy(null);
    }
  }

  async function onApprove() {
    await run('approve', () =>
      writeContractAsync({ ...token, functionName: 'approve', args: [ADDRESSES.hook, maxUint256] }),
    );
  }

  async function onCommit() {
    if (tick === null || !address || !wallet) return;
    setError(null);
    setBusy('commit');
    try {
      // Asked here, from a real user gesture — browsers reject the prompt on load,
      // and asking before someone has committed is asking for nothing.
      void askNotificationPermission();
      const salt = await deriveSalt(wallet, address, current);
      const h = commitmentHash(tick, salt, address);
      // Cached only as a convenience; recovery works without it.
      rememberTick(address, current, tick);
      setTxHash(await writeContractAsync({ ...hook, functionName: 'commit', args: [h] }));
    } catch (e) {
      setError(e instanceof Error ? e.message.split('\n')[0] : String(e));
      setBusy(null);
    }
  }

  async function onReveal() {
    if (!address || !wallet || !entryReveal) return;
    setError(null);
    setNote(null);
    setBusy('reveal');
    try {
      const salt = await deriveSalt(wallet, address, revealFor);
      let t = recallTick(address, revealFor);

      if (t === null || commitmentHash(t, salt, address) !== entryReveal[0]) {
        setNote('Recovering your prediction from the commitment…');
        const spot = await publicClient!.readContract({ ...hook, functionName: 'lastTick' });
        const found = recoverTick(entryReveal[0], salt, address, Number(spot));
        if (found.tick === null) {
          throw new Error(
            `Could not recover the prediction after ${found.searched.toLocaleString()} candidates. If you signed with a different wallet, switch to it.`,
          );
        }
        t = found.tick;
        setNote(`Recovered prediction: tick ${t}.`);
      }

      setTxHash(
        await writeContractAsync({
          ...hook,
          functionName: 'reveal',
          args: [revealFor, t, salt],
        }),
      );
      forgetTick(address, revealFor);
    } catch (e) {
      setError(e instanceof Error ? e.message.split('\n')[0] : String(e));
      setBusy(null);
    }
  }

  if (!armed) return null;

  const mm = String(Math.floor(Math.max(0, secondsLeft) / 60)).padStart(2, '0');
  const ss = String(Math.max(0, secondsLeft) % 60).padStart(2, '0');
  const needsApproval = allowance < deposit;
  const tooPoor = balance < deposit;

  return (
    <div className="mining">
      <ClaimPanel miningStart={miningStart} chainTime={chainTime} fetchedAt={fetchedAt} />
      <RewardsPanel locks={locks} />

      {mustReveal && (
        <div className="note danger revealbox">
          <span className="lbl">Reveal now — {mm}:{ss} left</span>
          <p>
            You have an unrevealed prediction for block #{revealFor.toString()}. If
            this window closes first, the whole deposit is burned and nobody can
            return it.
          </p>
          <button
            type="button"
            className="btn full"
            disabled={busy !== null || wrongChain || !targetReady}
            onClick={onReveal}
          >
            {busy === 'reveal' ? 'Confirm in wallet…' : 'Reveal my prediction'}
          </button>
        </div>
      )}

      <div className="grid">
        <div className="stat">
          <div className="k">Predicting for block</div>
          <div className="v">#{current.toString()}</div>
          <div className="n">closes in {mm}:{ss}</div>
        </div>
        <div className="stat">
          <div className="k">Pays</div>
          <div className="v accent">{fmt(rewardTok)}</div>
          <div className="n">
            BITHOOK, released over {vestDays} days after you claim — not at once
            {usdPerTok !== null && <> · {usd(rewardTok * usdPerTok, 0)} at today&apos;s price</>}
          </div>
        </div>
        <div className="stat">
          <div className="k">Deposit</div>
          <div className="v">{fmt(depositTok)}</div>
          <div className="n">
            returned in full when you reveal
            {usdPerTok !== null && <> · {usd(depositTok * usdPerTok)} today</>}
          </div>
        </div>
      </div>

      {usdPerTok !== null && (
        <p className="pfine">
          Dollar amounts here are a reference conversion at the current pool price
          and ETH/USD rate. Both move continuously, so these figures move with them.
        </p>
      )}

      {/* The form renders before connecting too: people should be able to see
          exactly what mining asks of them before being asked for a wallet. */}
      {wrongChain ? (
        <div className="note danger">
          <span className="lbl">Wrong network</span>
          <p>
            Bithook is on Ethereum mainnet.{' '}
            <button type="button" className="btn inline" onClick={() => switchChain({ chainId: mainnet.id })}>
              Switch
            </button>
          </p>
        </div>
      ) : hasCommittedNow ? (
        <div className="note">
          <span className="lbl">Committed to block #{current.toString()}</span>
          <p>
            One prediction per address per block. Your reveal window opens in{' '}
            {fmt((Number(BLOCK_TIME) * 2 + secondsLeft) / 60, 0)} minutes and lasts
            ten. <b>Keep this tab open</b> — the reminder cannot reach you if you
            close it.
          </p>
        </div>
      ) : (
        <div className="predict">
          <div className="prow">
            <label className="plabel" htmlFor="price">
              What will one BITHOOK average over the next ten minutes?
            </label>
            <div className="unitpick" role="group" aria-label="Price unit">
              <button
                type="button"
                className={unit === 'ethPerTok' ? 'on' : ''}
                onClick={() => {
                  if (unit !== 'ethPerTok' && tick !== null) {
                    setUnit('ethPerTok');
                    setPrice(plain(tickToEthPerBithook(tick), 6));
                  } else setUnit('ethPerTok');
                }}
              >
                ETH per BITHOOK
              </button>
              <button
                type="button"
                className={unit === 'tokPerEth' ? 'on' : ''}
                onClick={() => {
                  if (unit !== 'tokPerEth' && tick !== null) {
                    setUnit('tokPerEth');
                    setPrice(String(Math.round(tickToBithookPerEth(tick))));
                  } else setUnit('tokPerEth');
                }}
              >
                BITHOOK per ETH
              </button>
            </div>
          </div>

          <input
            id="price"
            className="pinput"
            inputMode="decimal"
            placeholder={
              unit === 'ethPerTok'
                ? `e.g. ${plain(tickToEthPerBithook(currentTick), 6)}`
                : `e.g. ${Math.round(tickToBithookPerEth(currentTick))}`
            }
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
          {/* Priced as you type, pinned to the field rather than left to the
              summary further down — the field is where someone is looking while
              entering a number. Stays empty until the value parses, so a
              half-typed figure is never given a price. */}
          <div className="pusd" aria-live="polite">
            {tick === null ? (
              <span className="pusdhint">
                {price.trim() === ''
                  ? 'Type a price, or use the buttons below'
                  : 'Not a usable price yet'}
              </span>
            ) : (
              <>
                <span className="pusdval">
                  {ethUsd !== null
                    ? usd(tickToEthPerBithook(tick) * ethUsd, 5)
                    : `${plain(tickToEthPerBithook(tick))} ETH`}
                </span>
                <span className="pusdunit">
                  per BITHOOK
                  {deltaPct !== null && (
                    <>
                      {' · '}
                      <span className={Math.abs(deltaPct) > 50 ? 'pusdwarn' : undefined}>
                        {deltaPct >= 0 ? '+' : ''}
                        {deltaPct.toFixed(2)}% vs now
                      </span>
                    </>
                  )}
                </span>
              </>
            )}
          </div>

          <div className="nudges">
            <span className="nlabel">
              Now: {unit === 'ethPerTok'
                ? plain(tickToEthPerBithook(currentTick))
                : Math.round(tickToBithookPerEth(currentTick)).toLocaleString()}
              {/* Labelled "each" because it stays per-BITHOOK even when the box
                  is showing the inverted BITHOOK-per-ETH unit. */}
              {usdPerTok !== null && <> · {usd(usdPerTok, 4)} each</>}
            </span>
            {[-5, -2, -1, 0, 1, 2, 5].map((p) => (
              <button
                key={p}
                type="button"
                className="nbtn"
                onClick={() =>
                  // A percentage move in price is a fixed number of ticks:
                  // tick = log(1+p) / log(1.0001), negative because a higher
                  // tick is a cheaper token.
                  setFromTick(Math.round(currentTick - Math.log1p(p / 100) / Math.log1p(1e-4)))
                }
              >
                {p === 0 ? 'now' : `${p > 0 ? '+' : ''}${p}%`}
              </button>
            ))}
          </div>

          {tick !== null && (
            <div className={`preview${Math.abs(deltaPct ?? 0) > 50 ? ' warn' : ''}`}>
              <div className="prow2">
                <span className="pk">Exact tick</span>
                <span className="pv">{tick.toLocaleString()}</span>
              </div>
              <div className="prow2">
                <span className="pk">Versus now</span>
                <span className="pv">
                  {deltaPct === null
                    ? '—'
                    : `${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(2)}%`}
                </span>
              </div>
              <div className="prow2">
                <span className="pk">Scored as</span>
                <span className="pv">
                  {plain(tickToEthPerBithook(tick))} ETH ·{' '}
                  {Math.round(tickToBithookPerEth(tick)).toLocaleString()} per ETH
                </span>
              </div>
              {ethUsd !== null && (
                <div className="prow2">
                  <span className="pk">In dollars</span>
                  <span className="pv">
                    {usd(tickToEthPerBithook(tick) * ethUsd, 4)} per BITHOOK
                  </span>
                </div>
              )}
              {Math.abs(deltaPct ?? 0) > 50 && (
                <p className="pwarn">
                  That is {Math.abs(deltaPct ?? 0).toFixed(0)}% away from the current
                  price in ten minutes. Check for a missing or extra zero.
                </p>
              )}
            </div>
          )}

          {tooPoor && isConnected && (
            <div className="note danger">
              <span className="lbl">Not enough BITHOOK</span>
              <p>
                The deposit is {fmt(Number(formatUnits(deposit, 18)))} BITHOOK and you
                hold {fmt(Number(formatUnits(balance, 18)))}.
              </p>
            </div>
          )}

          <button
            type="button"
            className="btn full"
            disabled={!isConnected || busy !== null || tick === null || tooPoor || wrongChain}
            onClick={needsApproval ? onApprove : onCommit}
          >
            {!isConnected
              ? 'Connect a wallet to commit'
              : busy === 'approve'
                ? 'Approving…'
                : busy === 'commit'
                  ? 'Confirm in wallet…'
                  : needsApproval
                    ? 'Approve BITHOOK for deposits'
                    : `Commit and lock ${fmt(depositTok)} BITHOOK${
                        usdPerTok !== null ? ` · ${usd(depositTok * usdPerTok)}` : ''
                      }`}
          </button>
          <p className="pfine">
            Sealed until you reveal — nobody can read your prediction, including us.
            You must return in the third window to reveal it, or the deposit is burned.
          </p>
        </div>
      )}

      {revealFor >= 0n && (
        <div className="boardwrap">
          <div className="k boardtitle">Standings for block #{revealFor.toString()}</div>
          <RevealBoard blockId={revealFor.toString()} you={address} />
        </div>
      )}

      {note && <div className="note"><p>{note}</p></div>}
      {error && (
        <div className="note danger">
          <span className="lbl">Failed</span>
          <p>{error}</p>
        </div>
      )}
    </div>
  );
}
