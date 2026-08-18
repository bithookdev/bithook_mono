/**
 * Generates real mining activity on a fork so the indexer's mining handlers can
 * be tested against something. Mining is not armed on mainnet, so without this
 * there are no Committed/Revealed events in existence anywhere.
 *
 * Includes a deliberate exact tie, because the tie rule is the part of the
 * winner replay most likely to be wrong and least likely to occur by accident.
 */
import { createPublicClient, createWalletClient, http, keccak256, encodePacked, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';

const RPC = 'http://127.0.0.1:8545';
const HOOK = '0x65DeBe0205E7c5395FBD31c894eb96AD1c92da44';
const TOKEN = '0x386c4CB30d2861AdB02eCBdFEA76f6a67eD2cddC';

// Anvil default accounts — publicly known test keys, local fork only.
const KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
];
const miners = KEYS.map((k) => privateKeyToAccount(k));

const pub = createPublicClient({ chain: mainnet, transport: http(RPC) });
const w = (acct) => createWalletClient({ account: acct, chain: mainnet, transport: http(RPC) });

const hookAbi = parseAbi([
  'function currentBlock() view returns (uint256)',
  'function commit(bytes32 h)',
  'function reveal(uint256 n, int24 tick, bytes32 salt)',
  'function claimBlock(uint256 n)',
  'function blocks(uint256) view returns (uint128,uint128,uint128,address winner,uint32 bestDist,bytes32,bool,bool,bool)',
  'function targetTick(uint256) view returns (int24)',
]);
const tokenAbi = parseAbi(['function approve(address,uint256) returns (bool)']);

const rpc = (method, params = []) =>
  fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then((r) => r.json());

const saltFor = (i, n) => keccak256(encodePacked(['uint256', 'uint256'], [BigInt(i), n]));
const hashFor = (tick, salt, who) =>
  keccak256(encodePacked(['int24', 'bytes32', 'address'], [tick, salt, who]));

async function advance(seconds) {
  await rpc('evm_increaseTime', [seconds]);
  await rpc('evm_mine');
}

console.log('approving deposits for 3 miners');
for (const m of miners) {
  const h = await w(m).writeContract({ address: TOKEN, abi: tokenAbi, functionName: 'approve', args: [HOOK, 2n ** 255n] });
  await pub.waitForTransactionReceipt({ hash: h });
}

const played = [];

/** One full lifecycle: everyone commits, two blocks pass, everyone reveals. */
async function playBlock(ticks, label) {
  const n = await pub.readContract({ address: HOOK, abi: hookAbi, functionName: 'currentBlock' });
  console.log(`\nblock ${n} — ${label}`);
  for (let i = 0; i < ticks.length; i++) {
    const salt = saltFor(i, n);
    const h = await w(miners[i]).writeContract({
      address: HOOK, abi: hookAbi, functionName: 'commit',
      args: [hashFor(ticks[i], salt, miners[i].address)],
    });
    await pub.waitForTransactionReceipt({ hash: h });
    console.log(`  miner ${i} committed tick ${ticks[i]}`);
  }
  await advance(1200);
  for (let i = 0; i < ticks.length; i++) {
    const h = await w(miners[i]).writeContract({
      address: HOOK, abi: hookAbi, functionName: 'reveal',
      args: [n, ticks[i], saltFor(i, n)],
    });
    await pub.waitForTransactionReceipt({ hash: h });
  }
  const target = await pub.readContract({ address: HOOK, abi: hookAbi, functionName: 'targetTick', args: [n] });
  const blk = await pub.readContract({ address: HOOK, abi: hookAbi, functionName: 'blocks', args: [n] });
  console.log(`  target ${target}, contract winner ${blk[3]}, bestDist ${blk[4]}`);
  played.push({ n: n.toString(), target, winner: blk[3], bestDist: Number(blk[4]), ticks });
  await advance(600);
  return n;
}

const spot = Number(await pub.readContract({ address: HOOK, abi: hookAbi, functionName: 'targetTick', args: [0n] }).catch(() => 124000));

// 1. distinct predictions — nearest wins outright
await playBlock([spot + 40, spot - 900, spot + 2500], 'distinct predictions');
// 2. EXACT TIE between miners 0 and 1 — decided by keccak(sender, n, target)
await playBlock([spot + 300, spot + 300, spot - 4000], 'exact tie between miner 0 and 1');
// 3. one participant only
await playBlock([spot - 120], 'single participant');

// A claim, so BlockWon and VestCreated are exercised too.
const first = played[0];
const winnerIdx = miners.findIndex((m) => m.address.toLowerCase() === first.winner.toLowerCase());
if (winnerIdx >= 0) {
  const h = await w(miners[winnerIdx]).writeContract({
    address: HOOK, abi: hookAbi, functionName: 'claimBlock', args: [BigInt(first.n)],
  });
  await pub.waitForTransactionReceipt({ hash: h });
  console.log(`\nclaimed block ${first.n} as miner ${winnerIdx}`);
}

await advance(600);
const head = await pub.getBlockNumber();
console.log('\n=== EXPECTED (from the contract) ===');
console.log(JSON.stringify({ head: head.toString(), played }, null, 1));
