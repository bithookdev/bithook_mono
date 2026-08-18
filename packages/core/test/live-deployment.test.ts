/**
 * Asserts the constants in src/constants.ts against the live mainnet contracts.
 *
 * This is the check that would have caught the wrong address on day one. It is
 * opt-in because it needs network, and it needs an archive-free plain RPC:
 *
 *   BITHOOK_RPC_URL=https://... pnpm vitest run live-deployment
 *
 * Note the local broadcast record is NOT a source of truth here — it is missing
 * receipts for the last two launch transactions even though they landed.
 */

import { createPublicClient, http, keccak256, encodeAbiParameters } from 'viem';
import { mainnet } from 'viem/chains';
import { describe, expect, it } from 'vitest';

import {
  ADDRESSES,
  CHAIN_ID,
  CREATE2_DEPLOYER,
  CREATION_TX,
  CURVE_TOKENS,
  DEPLOY_BLOCK,
  ERA_ONE,
  HOOK_FLAGS,
  HOOK_FLAG_MASK,
  INITIAL_SUPPLY,
  MAX_SUPPLY,
  POOL_ID,
  POOL_KEY,
  SEED_FLOOR_TICK,
  SEED_GRAD_TICK,
  SEED_START_TICK,
} from '../src/constants.js';

const RPC = process.env.BITHOOK_RPC_URL;
const maybe = RPC ? describe : describe.skip;

const tokenAbi = [
  { type: 'function', name: 'name', inputs: [], outputs: [{ type: 'string' }], stateMutability: 'view' },
  { type: 'function', name: 'symbol', inputs: [], outputs: [{ type: 'string' }], stateMutability: 'view' },
  { type: 'function', name: 'decimals', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view' },
  { type: 'function', name: 'totalSupply', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'minter', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'minterFinalized', inputs: [], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'MAX_SUPPLY', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'INITIAL_SUPPLY', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
] as const;

const hookAbi = [
  { type: 'function', name: 'token', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'owner', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'poolId', inputs: [], outputs: [{ type: 'bytes32' }], stateMutability: 'view' },
  { type: 'function', name: 'poolInitialized', inputs: [], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'miningStart', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'curveLiquidity', inputs: [], outputs: [{ type: 'uint128' }], stateMutability: 'view' },
  { type: 'function', name: 'tailLiquidity', inputs: [], outputs: [{ type: 'uint128' }], stateMutability: 'view' },
  { type: 'function', name: 'ERA_ONE', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'CURVE_TOKENS', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'SEED_START_TICK', inputs: [], outputs: [{ type: 'int24' }], stateMutability: 'view' },
  { type: 'function', name: 'SEED_GRAD_TICK', inputs: [], outputs: [{ type: 'int24' }], stateMutability: 'view' },
  { type: 'function', name: 'SEED_FLOOR_TICK', inputs: [], outputs: [{ type: 'int24' }], stateMutability: 'view' },
] as const;

maybe('live mainnet deployment', () => {
  const client = createPublicClient({ chain: mainnet, transport: http(RPC) });
  const token = { address: ADDRESSES.token, abi: tokenAbi } as const;
  const hook = { address: ADDRESSES.hook, abi: hookAbi } as const;

  it('is on mainnet', async () => {
    expect(await client.getChainId()).toBe(CHAIN_ID);
  });

  it('token is the Bithook ERC-20 with minting handed to the hook', async () => {
    expect(await client.readContract({ ...token, functionName: 'name' })).toBe('Bithook');
    expect(await client.readContract({ ...token, functionName: 'symbol' })).toBe('BITHOOK');
    expect(await client.readContract({ ...token, functionName: 'decimals' })).toBe(18);
    expect(await client.readContract({ ...token, functionName: 'MAX_SUPPLY' })).toBe(MAX_SUPPLY);
    expect(await client.readContract({ ...token, functionName: 'INITIAL_SUPPLY' })).toBe(INITIAL_SUPPLY);

    // Minting authority is immutable once finalized. If either of these is
    // wrong, mining can never pay out and the whole app is pointed at a dud.
    expect(await client.readContract({ ...token, functionName: 'minterFinalized' })).toBe(true);
    expect(
      (await client.readContract({ ...token, functionName: 'minter' })).toLowerCase(),
    ).toBe(ADDRESSES.hook.toLowerCase());
  });

  it('hook points back at the token and holds the seed', async () => {
    expect(
      (await client.readContract({ ...hook, functionName: 'token' })).toLowerCase(),
    ).toBe(ADDRESSES.token.toLowerCase());
    expect(
      (await client.readContract({ ...hook, functionName: 'owner' })).toLowerCase(),
    ).toBe(ADDRESSES.owner.toLowerCase());
    expect(await client.readContract({ ...hook, functionName: 'poolInitialized' })).toBe(true);

    // Both bands, not just active liquidity: at the opening tick the active
    // liquidity is zero, so a getLiquidity() check would pass on an unseeded pool.
    expect(await client.readContract({ ...hook, functionName: 'curveLiquidity' })).toBeGreaterThan(0n);
    expect(await client.readContract({ ...hook, functionName: 'tailLiquidity' })).toBeGreaterThan(0n);
  });

  it('hook constants match the local port', async () => {
    expect(await client.readContract({ ...hook, functionName: 'ERA_ONE' })).toBe(ERA_ONE);
    expect(await client.readContract({ ...hook, functionName: 'CURVE_TOKENS' })).toBe(CURVE_TOKENS);
    expect(await client.readContract({ ...hook, functionName: 'SEED_START_TICK' })).toBe(SEED_START_TICK);
    expect(await client.readContract({ ...hook, functionName: 'SEED_GRAD_TICK' })).toBe(SEED_GRAD_TICK);
    expect(await client.readContract({ ...hook, functionName: 'SEED_FLOOR_TICK' })).toBe(SEED_FLOOR_TICK);
  });

  it('poolId is the hash of our pool key', async () => {
    // Recomputing it locally proves POOL_KEY is right, not just POOL_ID.
    const computed = keccak256(
      encodeAbiParameters(
        [
          { type: 'address' }, { type: 'address' }, { type: 'uint24' },
          { type: 'int24' }, { type: 'address' },
        ],
        [
          POOL_KEY.currency0, POOL_KEY.currency1, POOL_KEY.fee,
          POOL_KEY.tickSpacing, POOL_KEY.hooks,
        ],
      ),
    );
    expect(computed).toBe(POOL_ID);
    expect(await client.readContract({ ...hook, functionName: 'poolId' })).toBe(POOL_ID);
  });

  it('hook address encodes the required v4 permission bits', async () => {
    const low = Number(BigInt(ADDRESSES.hook) & BigInt(HOOK_FLAG_MASK));
    expect(low).toBe(HOOK_FLAGS);
  });

  it('DEPLOY_BLOCK is the token creation block', async () => {
    // By receipt rather than a historical getCode, so this works against an
    // ordinary node instead of requiring archive access.
    const receipt = await client.getTransactionReceipt({ hash: CREATION_TX.token });
    expect(receipt.status).toBe('success');
    expect(receipt.contractAddress?.toLowerCase()).toBe(ADDRESSES.token.toLowerCase());
    expect(receipt.blockNumber).toBe(DEPLOY_BLOCK);
  });

  it('hook was CREATE2-deployed through the standard proxy', async () => {
    const receipt = await client.getTransactionReceipt({ hash: CREATION_TX.hook });
    expect(receipt.status).toBe('success');
    // A CALL to the deployer proxy, so no contractAddress on the receipt — the
    // address had to be mined for its permission bits, which CREATE cannot do.
    expect(receipt.to?.toLowerCase()).toBe(CREATE2_DEPLOYER.toLowerCase());
    expect(receipt.blockNumber).toBeGreaterThanOrEqual(DEPLOY_BLOCK);
  });

  it('reports whether mining is armed', async () => {
    const miningStart = await client.readContract({ ...hook, functionName: 'miningStart' });
    // Not an assertion on the value — it is 0 during the trading-only window and
    // nonzero afterwards. Both are valid; the app must handle each.
    console.log(
      miningStart === 0n
        ? 'miningStart = 0 — trading-only window, mining not armed'
        : `miningStart = ${miningStart}`,
    );
    expect(typeof miningStart).toBe('bigint');
  });
});
