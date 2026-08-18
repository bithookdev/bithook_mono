/**
 * Deployment constants for Bithook on Ethereum mainnet.
 *
 * Addresses were read back off-chain from the live contracts, not copied from
 * the broadcast file — the local broadcast record is missing receipts for the
 * final two transactions even though they landed. `pnpm --filter @bithook/core
 * test` re-asserts every value in this file against mainnet.
 */

export const CHAIN_ID = 1 as const;

// ---------------------------------------------------------------------------
// Deployment
// ---------------------------------------------------------------------------

export const ADDRESSES = {
  /** Bithook ERC-20. */
  token: '0x386c4CB30d2861AdB02eCBdFEA76f6a67eD2cddC',
  /** BithookMiningHook. Low 14 address bits encode the v4 hook flags (0x1A44). */
  hook: '0x65DeBe0205E7c5395FBD31c894eb96AD1c92da44',
  /** Owner: the only address that can call startMining(). */
  owner: '0x309BEcEe5CCBc4479b46fd83cfbA0a988b26Ac91',
  /** Canonical Uniswap v4 PoolManager. */
  poolManager: '0x000000000004444c5dc75cB358380D2e3dE08A90',
  /** Multicall3, used for batched reads and the swap max-size probe. */
  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
} as const;

/** Uniswap v4 PoolId for the BITHOOK/ETH pool. */
export const POOL_ID =
  '0x8a3d7e939d3eaa59811e90fb671519500fe30b227c95da6fca8f4c56859fc874' as const;

/** Block the token was created in — the indexer's startBlock. */
export const DEPLOY_BLOCK = 25753334n;

/**
 * Launch transactions, verified by receipt.
 *
 * The hook receipt has no `contractAddress` because it was deployed with CREATE2
 * through the standard deployer proxy, so the tx is a CALL to that proxy rather
 * than a creation — the hook's address had to be mined for its permission bits.
 */
export const CREATION_TX = {
  token: '0xd22c28dea590d5daed5fbc69bd64fd7ea2186367b9a39717f43512922dfaa0fd',
  hook: '0x07d0bb3e21391837530e26ac77f6861f02167224797eafca028fa2ce18621dd6',
} as const;

/** Standard CREATE2 deployer proxy the hook was deployed through. */
export const CREATE2_DEPLOYER = '0x4e59b44847b379578588920cA78FbF26c0B4956C' as const;

/** The pool key, exactly as passed to PoolManager.initialize. */
export const POOL_KEY = {
  /** Native ETH. */
  currency0: '0x0000000000000000000000000000000000000000',
  currency1: ADDRESSES.token,
  fee: 0,
  tickSpacing: 200,
  hooks: ADDRESSES.hook,
} as const;

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

export const MAX_SUPPLY = 21_000_000n * 10n ** 18n;
export const INITIAL_SUPPLY = 10_500_000n * 10n ** 18n;
export const TOTAL_MINING_SUPPLY = 10_500_000n * 10n ** 18n;
export const DECIMALS = 18;

// ---------------------------------------------------------------------------
// Mining schedule
// ---------------------------------------------------------------------------

/** Seconds per mining block. Block n spans [miningStart + 600n, +600). */
export const BLOCK_TIME = 600n;
/** Entry stake as a fraction of the block's scheduled reward (1%). */
export const STAKE_BPS = 100n;
/** Length of era 0; every era after it doubles. */
export const ERA_ONE = 604_800n; // 7 days
/** Each era is cut into this many lock slices. */
export const LOCK_SLICES_PER_ERA = 10n;
/** Reward vesting is capped at this duration. */
export const MAX_VEST = 9_676_800n; // 112 days
/** Boundaries the oracle will backfill in one _accumulate() call. */
export const MAX_CHECKPOINTS = 32n;
/** Unvested reward forfeited by exitEarly (50%). */
export const EXIT_SLASH_BPS = 5_000n;

/**
 * Longest silence the oracle survives without stranding boundaries.
 * Past this, older boundaries are skipped permanently and every block that
 * needed them can never be revealed. Any contract call resets it, so only a
 * total halt in activity for this long is dangerous.
 */
export const MAX_ORACLE_SILENCE = MAX_CHECKPOINTS * BLOCK_TIME; // 19,200s = 5h20m

// ---------------------------------------------------------------------------
// Pool and launch curve
// ---------------------------------------------------------------------------

/** Flat hook fee on the unspecified side of every swap (1%). All burned. */
export const FEE_BPS = 100n;
export const POOL_LP_FEE = 0;
export const POOL_TICK_SPACING = 200;

/** Opening tick: ~14.0M BITHOOK per ETH, ~1.49 ETH FDV. */
export const SEED_START_TICK = 164_600;
/** End of the bonding-curve band: 26,800 ticks down, a 14.58x price rise. */
export const SEED_GRAD_TICK = 137_800;
/** Bottom of the tail band — the minimum usable tick at spacing 200. */
export const SEED_FLOOR_TICK = -887_200;
/** Tokens sold across the curve band; the rest goes to the tail. */
export const CURVE_TOKENS = 8_400_000n * 10n ** 18n;
export const MAX_SEED_TOKEN_DUST = 4_000n;

/**
 * The seed corridor is inclusive. SEED_START_TICK is the *upper* sqrt-price
 * bound, and because tick counts BITHOOK per ETH it is also the cheapest the
 * token can ever be: sells that would push past it revert in full.
 */
export const CORRIDOR_TICK_UPPER = SEED_START_TICK;
export const CORRIDOR_TICK_LOWER = SEED_FLOOR_TICK;

// ---------------------------------------------------------------------------
// v4 hook flags — the hook address must encode exactly these bits.
// ---------------------------------------------------------------------------

export const HOOK_FLAGS =
  (1 << 12) | // AFTER_INITIALIZE
  (1 << 11) | // BEFORE_ADD_LIQUIDITY
  (1 << 9) | //  BEFORE_REMOVE_LIQUIDITY
  (1 << 6) | //  AFTER_SWAP
  (1 << 2); //   AFTER_SWAP_RETURNS_DELTA

/** Mask covering the flag bits v4 reads out of a hook address. */
export const HOOK_FLAG_MASK = (1 << 14) - 1;
