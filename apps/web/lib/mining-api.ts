import 'server-only';

/**
 * Server-side reads of the indexer. Kept out of the browser so the indexer's
 * address is never shipped to visitors and the pages render with data already
 * present rather than flashing empty.
 */
const INDEXER_URL = process.env.BITHOOK_INDEXER_URL ?? 'http://127.0.0.1:42069';

async function get<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${INDEXER_URL}/mining/${path}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export interface MiningBlock {
  n: string;
  startTs: number;
  era: number;
  reward: string;
  deposit: string;
  commits: number;
  reveals: number;
  targetTick: number | null;
  targetResolvable: boolean;
  winner: string | null;
  bestDist: string | null;
  claimed: boolean;
  depositsBurned: boolean;
}

export interface RevealRow {
  who: string;
  tick: number;
  dist: string;
  ts: number;
  hash: string;
}

export interface LeaderRow {
  address: string;
  wins: number;
  totalWon: string;
  commits: number;
  reveals: number;
  meanDist: number | null;
  revealRate: number | null;
}

export const getBlocks = (limit = 50) =>
  get<{ blocks: MiningBlock[] }>(`blocks?limit=${limit}`);
export const getBlock = (n: string) =>
  get<{
    block: MiningBlock;
    /** The vest this block's claim minted, once claimed. Null before that. */
    vest: {
      total: string; released: string; slashed: string;
      exited: boolean; startTs: number; duration: number | null;
    } | null;
    reveals: RevealRow[];
  }>(`blocks/${n}`);
export const getLeaderboard = (limit = 50) =>
  get<{ miners: LeaderRow[] }>(`leaderboard?limit=${limit}`);
export const getMiner = (address: string) =>
  get<{
    miner: LeaderRow | null;
    wins: MiningBlock[];
    unclaimed: MiningBlock[];
    locks: { slice: string; amount: string; unlockAt: number; unlocked: boolean }[];
    vests: {
      vestId: string; blockN: string | null; total: string; released: string;
      startTs: number; duration: number | null; exited: boolean;
      /** BITHOOK destroyed by exiting this vest early. Zero unless `exited`. */
      slashed: string;
    }[];
  }>(`miner/${address}`);
