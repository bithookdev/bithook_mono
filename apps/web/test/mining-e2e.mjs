/**
 * End-to-end proof of the Phase A mining logic, against a forked mainnet with
 * the real deployed contract.
 *
 * This exercises exactly what the UI does, in the same order, using the same
 * functions — including the recovery path where the browser has forgotten which
 * tick was predicted and has to find it from the on-chain commitment alone.
 *
 * Run with an anvil fork on :8545 and mining armed.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  encodePacked,
  parseAbi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';

const RPC = 'http://127.0.0.1:8545';
const HOOK = '0x65DeBe0205E7c5395FBD31c894eb96AD1c92da44';
const TOKEN = '0x386c4CB30d2861AdB02eCBdFEA76f6a67eD2cddC';

// Anvil default account 0 — a publicly known test key, local fork only.
const account = privateKeyToAccount(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
);

const pub = createPublicClient({ chain: mainnet, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: mainnet, transport: http(RPC) });

const hookAbi = parseAbi([
  'function currentBlock() view returns (uint256)',
  'function commit(bytes32 h)',
  'function reveal(uint256 n, int24 tick, bytes32 salt)',
  'function entries(uint256, address) view returns (bytes32 commitment, int24 tick, bool revealed)',
  'function stakeFor(uint256 n) pure returns (uint256)',
  'function lastTick() view returns (int24)',
  'function blocks(uint256) view returns (uint128,uint128,uint128,address winner,uint32,bytes32,bool,bool,bool)',
]);
const tokenAbi = parseAbi([
  'function approve(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
]);

// ---- mirrors of the app's own code -------------------------------------
const SALT_DOMAIN = { name: 'Bithook', version: '1', chainId: 1, verifyingContract: HOOK };
const SALT_TYPES = {
  MiningCommitment: [
    { name: 'blockId', type: 'uint256' },
    { name: 'purpose', type: 'string' },
  ],
};

async function deriveSalt(blockId) {
  const sig = await wallet.signTypedData({
    account,
    domain: SALT_DOMAIN,
    types: SALT_TYPES,
    primaryType: 'MiningCommitment',
    message: { blockId, purpose: 'Bithook mining commitment salt' },
  });
  return keccak256(sig);
}

const commitmentHash = (tick, salt, sender) =>
  keccak256(encodePacked(['int24', 'bytes32', 'address'], [tick, salt, sender]));

function recoverTick(commitment, salt, sender, centre, radius = 60_000) {
  const target = commitment.toLowerCase();
  let searched = 0;
  for (let d = 0; d <= radius; d++) {
    for (const tick of d === 0 ? [centre] : [centre - d, centre + d]) {
      searched++;
      if (commitmentHash(tick, salt, sender).toLowerCase() === target) return { tick, searched };
    }
  }
  return { tick: null, searched };
}

const ok = (c, m) => { if (!c) { console.error('  FAIL:', m); process.exit(1); } console.log('  ok:', m); };

// ---- the run ------------------------------------------------------------
const PREDICT = 121_500;

console.log('1. salt determinism (this is what makes commitments recoverable)');
const n = await pub.readContract({ address: HOOK, abi: hookAbi, functionName: 'currentBlock' });
const saltA = await deriveSalt(n);
const saltB = await deriveSalt(n);
ok(saltA === saltB, `signing twice gives the same salt (${saltA.slice(0, 18)}…)`);
const saltOther = await deriveSalt(n + 1n);
ok(saltOther !== saltA, 'a different block gives a different salt');

console.log('2. approve + commit');
await wallet.writeContract({ address: TOKEN, abi: tokenAbi, functionName: 'approve',
  args: [HOOK, 2n ** 255n] });
const h = commitmentHash(PREDICT, saltA, account.address);
const commitTx = await wallet.writeContract({ address: HOOK, abi: hookAbi, functionName: 'commit', args: [h] });
await pub.waitForTransactionReceipt({ hash: commitTx });
const entry = await pub.readContract({ address: HOOK, abi: hookAbi, functionName: 'entries', args: [n, account.address] });
ok(entry[0] === h, `contract stored our commitment for block ${n}`);
ok(entry[2] === false, 'not yet revealed');

console.log('3. advance two blocks (the reveal window)');
await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'evm_increaseTime', params: [1200] }) });
await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'evm_mine', params: [] }) });
const cur = await pub.readContract({ address: HOOK, abi: hookAbi, functionName: 'currentBlock' });
ok(cur === n + 2n, `currentBlock is ${cur}, reveal window for block ${n}`);

console.log('4. RECOVERY: pretend the browser forgot the tick entirely');
const saltAgain = await deriveSalt(n);           // re-derived from the wallet alone
ok(saltAgain === saltA, 'salt re-derived after "losing" local state');
const spot = await pub.readContract({ address: HOOK, abi: hookAbi, functionName: 'lastTick' });
const t0 = Date.now();
const found = recoverTick(entry[0], saltAgain, account.address, Number(spot));
ok(found.tick === PREDICT,
   `recovered tick ${found.tick} from the on-chain commitment in ${found.searched.toLocaleString()} tries, ${Date.now() - t0}ms`);

console.log('5. reveal using only recovered data');
const revealTx = await wallet.writeContract({ address: HOOK, abi: hookAbi, functionName: 'reveal',
  args: [n, found.tick, saltAgain] });
const rec = await pub.waitForTransactionReceipt({ hash: revealTx });
ok(rec.status === 'success', `reveal succeeded, gas ${rec.gasUsed}`);
const blk = await pub.readContract({ address: HOOK, abi: hookAbi, functionName: 'blocks', args: [n] });
ok(blk[3].toLowerCase() === account.address.toLowerCase(), `we are the winner of block ${n}`);
const after = await pub.readContract({ address: HOOK, abi: hookAbi, functionName: 'entries', args: [n, account.address] });
ok(after[2] === true, 'entry now marked revealed');

console.log('\nALL PASSED — commit and reveal work with nothing but the wallet.');
