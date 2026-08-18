import { ADDRESSES, commitmentHash } from '@bithook/core';
import { keccak256 } from 'viem';
import type { Address, Hex, WalletClient } from 'viem';

/**
 * Salts are DERIVED from a wallet signature, never stored as the source of truth.
 *
 * The alternative — a random salt kept in localStorage — loses the deposit the
 * moment someone clears site data, switches device or opens a private window.
 * Deriving it means a commitment can always be reopened from the wallet alone.
 *
 * Ethereum wallets sign deterministically (RFC 6979), so signing the same typed
 * data twice yields the same signature and therefore the same salt.
 *
 * The signature must stay private: the tick space is only 24 bits, so anyone
 * holding your salt can brute-force your prediction before you reveal it.
 */

export const SALT_DOMAIN = {
  name: 'Bithook',
  version: '1',
  chainId: 1,
  verifyingContract: ADDRESSES.hook as Address,
} as const;

export const SALT_TYPES = {
  MiningCommitment: [
    { name: 'blockId', type: 'uint256' },
    { name: 'purpose', type: 'string' },
  ],
} as const;

/** Deterministic salt for (wallet, mining block). */
export async function deriveSalt(
  wallet: WalletClient,
  account: Address,
  blockId: bigint,
): Promise<Hex> {
  const signature = await wallet.signTypedData({
    account,
    domain: SALT_DOMAIN,
    types: SALT_TYPES,
    primaryType: 'MiningCommitment',
    message: {
      blockId,
      // Domain-separated so this signature can never be replayed as anything
      // else, and so a wallet prompt says what it is for.
      purpose: 'Bithook mining commitment salt',
    },
  });
  return keccak256(signature);
}

// ---------------------------------------------------------------------------
// Local tick cache — a convenience, never the only copy
// ---------------------------------------------------------------------------

const tickKey = (account: Address, blockId: bigint) =>
  `bithook.tick.${account.toLowerCase()}.${blockId}`;

export function rememberTick(account: Address, blockId: bigint, tick: number): void {
  try {
    window.localStorage.setItem(tickKey(account, blockId), String(tick));
  } catch {
    /* private mode, quota — recovery by search still works */
  }
}

export function recallTick(account: Address, blockId: bigint): number | null {
  try {
    const v = window.localStorage.getItem(tickKey(account, blockId));
    return v === null ? null : Number(v);
  } catch {
    return null;
  }
}

export function forgetTick(account: Address, blockId: bigint): void {
  try {
    window.localStorage.removeItem(tickKey(account, blockId));
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

export interface RecoverResult {
  tick: number | null;
  searched: number;
}

/**
 * Recover a forgotten prediction by searching ticks against the on-chain
 * commitment.
 *
 * Searches outward from a starting point rather than scanning the whole int24
 * range: a prediction is a price, so it sits near the market. ±60,000 ticks is
 * a ~400x price range in both directions and completes in about a second, where
 * the full 16.7M range would take minutes.
 */
export function recoverTick(
  commitment: Hex,
  salt: Hex,
  sender: Address,
  centreTick: number,
  radius = 60_000,
): RecoverResult {
  const target = commitment.toLowerCase();
  let searched = 0;

  for (let d = 0; d <= radius; d++) {
    for (const tick of d === 0 ? [centreTick] : [centreTick - d, centreTick + d]) {
      if (tick < -8_388_608 || tick > 8_388_607) continue;
      searched++;
      if (commitmentHash(tick, salt, sender).toLowerCase() === target) {
        return { tick, searched };
      }
    }
  }
  return { tick: null, searched };
}
