import {
  ADDRESSES,
  DEPLOY_BLOCK,
  POOL_ID,
  bithookHookAbi,
  bithookTokenAbi,
  poolManagerAbi,
} from '@bithook/core';
import { createConfig } from 'ponder';
import { http } from 'viem';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

const RPC_URL = process.env.PONDER_RPC_URL_1;
if (!RPC_URL) throw new Error('PONDER_RPC_URL_1 is required');

// Overridable so the indexer can be pointed at a short fork window for testing
// without backfilling from the real deploy block.
const startBlock = process.env.PONDER_START_BLOCK
  ? Number(process.env.PONDER_START_BLOCK)
  : Number(DEPLOY_BLOCK);

export default createConfig({
  networks: {
    mainnet: {
      chainId: 1,
      transport: http(RPC_URL),
      // The pool is busy; batching keeps the provider's request count sane.
      maxRequestsPerSecond: 25,
    },
  },
  contracts: {
    /**
     * All trading data lives on the PoolManager, not on the hook — the hook
     * emits nothing per swap except its fee.
     *
     * The filter is load-bearing: the PoolManager is one of the busiest
     * contracts on mainnet, and without scoping to our PoolId this would index
     * every Uniswap v4 swap in existence.
     */
    PoolManager: {
      abi: poolManagerAbi,
      address: ADDRESSES.poolManager,
      network: 'mainnet',
      startBlock,
      filter: { event: 'Swap', args: { id: POOL_ID } },
    },
    BithookHook: {
      abi: bithookHookAbi,
      address: ADDRESSES.hook,
      network: 'mainnet',
      startBlock,
    },
    BithookToken: {
      abi: bithookTokenAbi,
      address: ADDRESSES.token,
      network: 'mainnet',
      startBlock,
    },

    /**
     * Mints and burns, as two separately filtered sources over the same token.
     *
     * Every destruction path ends in a burn — fee burns, buybacks, forfeited
     * deposits, early-exit slashing, and the mint-and-burn a block with no
     * winner performs — so one cumulative burn total covers all of them with no
     * double counting, and `minted - burned` must equal `totalSupply`.
     *
     * Filtering on the zero address at the source is load-bearing. Indexing
     * every Transfer would pull in every trade against the pool; filtering on an
     * indexed topic means the node returns only the handful actually wanted.
     */
    BithookMint: {
      abi: bithookTokenAbi,
      address: ADDRESSES.token,
      network: 'mainnet',
      startBlock,
      filter: { event: 'Transfer', args: { from: ZERO_ADDRESS } },
    },
    BithookBurn: {
      abi: bithookTokenAbi,
      address: ADDRESSES.token,
      network: 'mainnet',
      startBlock,
      filter: { event: 'Transfer', args: { to: ZERO_ADDRESS } },
    },
  },
});
