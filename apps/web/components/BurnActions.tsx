'use client';

import { ADDRESSES, bithookHookAbi } from '@bithook/core';
import { useEffect, useState } from 'react';
import { formatEther, formatUnits } from 'viem';
import {
  useAccount,
  useChainId,
  useConnect,
  useDisconnect,
  useReadContracts,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi';
import { mainnet } from 'wagmi/chains';

import { useLiveState, type StateJson } from './LiveFigures';

const hook = { address: ADDRESSES.hook, abi: bithookHookAbi } as const;

type ActionKey = 'buyback' | 'burnFees' | 'poke';

function short(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/**
 * The three calls anyone can make, live before mining starts.
 *
 * All are permissionless and unrewarded — the contract pays no bounty, so they
 * only happen if someone bothers. Nothing here can take a user's funds: the
 * only cost is gas.
 */
export function BurnActions({
  miningArmed,
  initial,
}: {
  miningArmed: boolean;
  /**
   * Seed for the fee balances a disconnected visitor sees.
   *
   * Polled from /api/state like the other live figures, rather than kept
   * current by a page-wide `router.refresh()`, which loses scroll position.
   */
  initial: StateJson;
}) {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { connect, connectors, isPending: connecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  const { writeContract, data: txHash, isPending: signing, error: writeError, reset } =
    useWriteContract();
  const { isLoading: mining, isSuccess: confirmed } = useWaitForTransactionReceipt({ hash: txHash });
  const [active, setActive] = useState<ActionKey | null>(null);

  // Live pending-fee balances; refetched once a transaction confirms. Only polls
  // for a connected wallet, since that is what supplies the RPC.
  const { data, refetch } = useReadContracts({
    contracts: [
      { ...hook, functionName: 'pendingEth' },
      { ...hook, functionName: 'pendingToken' },
    ],
    query: { enabled: isConnected, refetchInterval: 20_000 },
  });

  useEffect(() => {
    if (confirmed) {
      refetch();
      setActive(null);
    }
  }, [confirmed, refetch]);

  // A connected wallet reads straight from the chain; everyone else gets the
  // polled figures. Never 0n as a fallback: "0.0000 ETH awaiting burn" would be
  // a wrong number rather than a missing one, and this panel exists to say there
  // is something to burn.
  const live = useLiveState(initial);
  const pendingEth = (data?.[0]?.result as bigint | undefined) ?? BigInt(live.pendingEth);
  const pendingToken = (data?.[1]?.result as bigint | undefined) ?? BigInt(live.pendingToken);

  const wrongChain = isConnected && chainId !== mainnet.id;
  const busy = signing || mining;

  function run(key: ActionKey) {
    reset();
    setActive(key);
    if (key === 'buyback') {
      // 0 spends the entire pending ETH claim in one atomic purchase.
      writeContract({ ...hook, functionName: 'buybackAndBurn', args: [0n] });
    } else if (key === 'burnFees') {
      writeContract({ ...hook, functionName: 'burnFees' });
    } else {
      writeContract({ ...hook, functionName: 'poke' });
    }
  }

  const actions: Array<{
    key: ActionKey;
    title: string;
    desc: string;
    ready: boolean;
    blocked?: string;
  }> = [
    {
      key: 'buyback',
      title: 'Buy back and burn',
      desc: `Spends the ${Number(formatEther(pendingEth)).toLocaleString('en-US', { maximumFractionDigits: 5 })} ETH collected in fees on a swap against this pool, and burns the BITHOOK it receives.`,
      ready: pendingEth > 0n,
      blocked: pendingEth > 0n ? undefined : 'No ETH fees pending yet.',
    },
    {
      key: 'burnFees',
      title: 'Burn collected BITHOOK',
      desc: `Burns the ${Number(formatUnits(pendingToken, 18)).toLocaleString('en-US', { maximumFractionDigits: 0 })} BITHOOK the pool has collected in fees, removing it from the total supply.`,
      ready: pendingToken > 0n,
      blocked: pendingToken > 0n ? undefined : 'No BITHOOK fees pending yet.',
    },
    {
      key: 'poke',
      title: 'Advance the oracle',
      desc: 'Checkpoints the TWAP boundaries that mining targets are measured from. Keeping this current is what stops miners losing deposits to an unresolvable block.',
      ready: miningArmed,
      blocked: miningArmed ? undefined : 'Does nothing until mining starts.',
    },
  ];

  return (
    <div className="actions">
      <div className="connectbar">
        {isConnected ? (
          <>
            <span className="who">
              <span className="dot" /> {address ? short(address) : ''}
            </span>
            <button type="button" className="btn ghost" onClick={() => disconnect()}>
              Disconnect
            </button>
          </>
        ) : (
          <>
            {connectors.length === 0 && (
              <span className="who muted">No browser wallet detected.</span>
            )}
            {connectors.map((c) => (
              <button
                key={c.uid}
                type="button"
                className="btn"
                disabled={connecting}
                onClick={() => connect({ connector: c })}
              >
                {connecting ? 'Connecting…' : `Connect ${c.name}`}
              </button>
            ))}
          </>
        )}
      </div>

      {wrongChain && (
        <div className="note danger">
          <span className="lbl">Wrong network</span>
          <p>
            Bithook is on Ethereum mainnet.{' '}
            <button
              type="button"
              className="btn inline"
              onClick={() => switchChain({ chainId: mainnet.id })}
            >
              Switch to mainnet
            </button>
          </p>
        </div>
      )}

      <div className="grid">
        {actions.map((a) => (
          <div className="stat action" key={a.key}>
            <div className="k">{a.title}</div>
            <p className="adesc">{a.desc}</p>
            <button
              type="button"
              className="btn full"
              disabled={!isConnected || wrongChain || !a.ready || busy}
              onClick={() => run(a.key)}
            >
              {busy && active === a.key
                ? signing
                  ? 'Confirm in wallet…'
                  : 'Confirming…'
                : a.blocked
                  ? a.blocked
                  : !isConnected
                    ? 'Connect a wallet'
                    : a.title}
            </button>
          </div>
        ))}
      </div>

      {writeError && (
        <div className="note danger">
          <span className="lbl">Transaction failed</span>
          <p>{writeError.message.split('\n')[0]}</p>
        </div>
      )}
      {confirmed && txHash && (
        <div className="note">
          <span className="lbl">Confirmed</span>
          <p className="addr">{txHash}</p>
        </div>
      )}
    </div>
  );
}
