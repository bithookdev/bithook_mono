import 'server-only';

import {
  ADDRESSES,
  INITIAL_SUPPLY,
  MAX_SUPPLY,
  POOL_ID,
  SEED_START_TICK,
  bithookHookAbi,
  bithookTokenAbi,
  decodeSlot0,
  extsloadAbi,
  fdvEth,
  multipleFromOpen,
  poolStateSlot,
  scheduleCap,
  tickToBithookPerEth,
  tickToEthPerBithook,
} from '@bithook/core';
import { createPublicClient, http } from 'viem';
import { mainnet } from 'viem/chains';

/**
 * The RPC URL stays server-side. Every chain read happens in a server
 * component, so the browser never sees it and never talks to a node directly —
 * which also means no third party learns a visitor's IP from this page.
 */
const RPC_URL = process.env.BITHOOK_RPC_URL ?? 'https://ethereum-rpc.publicnode.com';

const client = createPublicClient({
  chain: mainnet,
  transport: http(RPC_URL, { batch: true }),
});

/**
 * Chainlink ETH/USD. Read through the same RPC as everything else, so the page
 * still makes no third-party requests — an off-chain price API would be the one
 * outbound call on the whole site, and would learn every visitor's IP.
 */
const ETH_USD_FEED = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419' as const;
const chainlinkAbi = [
  {
    type: 'function',
    name: 'latestRoundData',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
  },
] as const;

const token = { address: ADDRESSES.token, abi: bithookTokenAbi } as const;
const hook = { address: ADDRESSES.hook, abi: bithookHookAbi } as const;

export interface ProtocolState {
  /** Live pool tick. Higher tick = cheaper token. */
  tick: number;
  ethPerBithook: number;
  bithookPerEth: number;
  fdvEth: number;
  multipleFromOpen: number;

  totalSupply: bigint;
  /** Supply actually destroyed — fee burns, buyback burns, forfeited stakes. */
  destroyed: bigint;
  feeBurned: bigint;
  buybackBurned: bigint;
  stakesBurned: bigint;
  /** Emission that was never issued. Net-zero on supply; NOT a burn. */
  slashed: bigint;
  lockedStakes: bigint;
  /** BITHOOK minted by mining so far. */
  minedSoFar: bigint;

  pendingEth: bigint;
  pendingToken: bigint;

  /** 0 while the pool is in its trading-only window. */
  miningStart: bigint;
  miningArmed: boolean;
  /** Emission released by now, once mining is armed. */
  releasedByNow: bigint;

  /** ETH/USD from Chainlink. Null if the feed is stale or unreadable. */
  ethUsd: number | null;
  usdPerBithook: number | null;
  fdvUsd: number | null;

  blockNumber: bigint;
  /** Chain timestamp, in seconds. The contract measures blocks against this. */
  chainTime: bigint;
  /** Server wall clock when chainTime was read, so the client can correct drift. */
  fetchedAt: number;
}

export async function getProtocolState(): Promise<ProtocolState> {
  const [slot0Raw, reads, latestBlock, ethUsdRound] = await Promise.all([
    client.readContract({
      address: ADDRESSES.poolManager,
      abi: extsloadAbi,
      functionName: 'extsload',
      args: [poolStateSlot(POOL_ID)],
    }),
    client.multicall({
      allowFailure: false,
      contracts: [
        { ...token, functionName: 'totalSupply' },
        { ...hook, functionName: 'totalFeeBurned' },
        { ...hook, functionName: 'totalBuybackBurned' },
        { ...hook, functionName: 'totalBurnedStakes' },
        { ...hook, functionName: 'totalSlashed' },
        { ...hook, functionName: 'totalLockedStakes' },
        { ...hook, functionName: 'pendingEth' },
        { ...hook, functionName: 'pendingToken' },
        { ...hook, functionName: 'miningStart' },
      ],
    }),
    client.getBlock(),
    client
      .readContract({ address: ETH_USD_FEED, abi: chainlinkAbi, functionName: 'latestRoundData' })
      .catch(() => null),
  ]);

  const [
    totalSupply,
    feeBurned,
    buybackBurned,
    stakesBurned,
    slashed,
    lockedStakes,
    pendingEth,
    pendingToken,
    miningStart,
  ] = reads as readonly bigint[];

  const { tick } = decodeSlot0(slot0Raw as `0x${string}`);

  // Reject a stale feed rather than showing a confidently wrong dollar value.
  // Chainlink's ETH/USD heartbeat is ~1 hour; 6 hours is generous but still
  // catches a feed that has actually stopped.
  let ethUsd: number | null = null;
  if (ethUsdRound) {
    const answer = (ethUsdRound as readonly bigint[])[1]!;
    const updatedAt = Number((ethUsdRound as readonly bigint[])[3]!);
    const ageSec = Number(latestBlock.timestamp) - updatedAt;
    if (answer > 0n && ageSec < 21_600) ethUsd = Number(answer) / 1e8;
  }

  // Only these three actually reduce totalSupply. The no-winner and slash paths
  // mint and burn in the same transaction, so they are emission that was never
  // issued rather than supply destroyed — summing all of them would overstate
  // the burn, which is the easy mistake on a dashboard like this.
  const destroyed = feeBurned! + buybackBurned! + stakesBurned!;

  // Supply opened at INITIAL_SUPPLY, falls with real burns, rises only when a
  // winner unlocks vested reward.
  const minedSoFar = totalSupply! - INITIAL_SUPPLY + destroyed;

  const releasedByNow =
    miningStart === 0n
      ? 0n
      : scheduleCap(BigInt(Math.floor(Date.now() / 1000)) - miningStart!);

  return {
    tick,
    ethPerBithook: tickToEthPerBithook(tick),
    bithookPerEth: tickToBithookPerEth(tick),
    fdvEth: fdvEth(tick),
    multipleFromOpen: multipleFromOpen(tick),

    totalSupply: totalSupply!,
    destroyed,
    feeBurned: feeBurned!,
    buybackBurned: buybackBurned!,
    stakesBurned: stakesBurned!,
    slashed: slashed!,
    lockedStakes: lockedStakes!,
    minedSoFar,

    pendingEth: pendingEth!,
    pendingToken: pendingToken!,

    miningStart: miningStart!,
    miningArmed: miningStart! !== 0n,
    releasedByNow,

    ethUsd,
    usdPerBithook: ethUsd === null ? null : tickToEthPerBithook(tick) * ethUsd,
    fdvUsd: ethUsd === null ? null : fdvEth(tick) * ethUsd,

    blockNumber: latestBlock.number ?? 0n,
    chainTime: latestBlock.timestamp,
    fetchedAt: Date.now(),
  };
}

export const CONSTANTS = { MAX_SUPPLY, INITIAL_SUPPLY, SEED_START_TICK, ADDRESSES };
