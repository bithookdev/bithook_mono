# Bithook (BITHOOK)

A block-mined ERC-20 on Ethereum mainnet, implemented as a Uniswap v4 hook.

Supply is capped at 21,000,000. Half is seeded as two single-sided concentrated
liquidity bands and permanently sealed. The other half is mined in ten-minute
blocks on a halving schedule: each block, participants predict the token's own
time-weighted average price, and the closest prediction takes the entire block
reward.

## Deployment

| | Address |
|---|---|
| Token | [`0x386c4CB30d2861AdB02eCBdFEA76f6a67eD2cddC`](https://etherscan.io/address/0x386c4CB30d2861AdB02eCBdFEA76f6a67eD2cddC) |
| Mining hook | [`0x65DeBe0205E7c5395FBD31c894eb96AD1c92da44`](https://etherscan.io/address/0x65DeBe0205E7c5395FBD31c894eb96AD1c92da44) |
| Uniswap v4 PoolManager | `0x000000000004444c5dc75cB358380D2e3dE08A90` |
| Pool ID | `0x8a3d7e939d3eaa59811e90fb671519500fe30b227c95da6fca8f4c56859fc874` |

Chain ID 1. Compiled with solc 0.8.26.

## Mechanism

A mining block lasts `BLOCK_TIME` (10 minutes) and resolves over three of them:

1. **Commit** during block `n`: submit `keccak256(tick, salt, sender)` with a
   deposit. The prediction itself stays hidden.
2. **Reveal** during block `n+2`: submit the tick and salt. The contract checks
   the hash and scores the distance to the target.
3. **Settle**: once `currentBlock() > n + 2` the winner is final and the reward
   can be claimed.

The target tick for block `n` is the average of the pool's tick over the block,
derived from cumulative tick checkpoints written at block boundaries:

```
targetTick(n) = (boundaryCum[n+2] - boundaryCum[n+1]) / BLOCK_TIME
```

A deposit that is committed but never revealed is forfeited. If no one reveals,
the block's reward is minted and burned in the same transaction — the schedule
does not carry it forward, because `scheduledBlockReward(n)` is a pure function
of the block index.

Claimed rewards vest linearly over the halving period they were mined in.
Exiting a vest early releases the vested portion and burns half of the
remainder (`EXIT_SLASH_BPS = 5000`).

A 1% fee (`FEE_BPS = 100`) is charged on every swap and burned.

## Layout

```
src/            Solidity contracts
script/         Foundry deploy script
test/           Foundry tests
packages/core/  TypeScript port of the on-chain math, plus ABIs and constants
apps/web/       Next.js frontend
apps/indexer/   Ponder indexer and JSON API
apps/notifier/  Discord notifications
```

`packages/core` is differential-tested against fixtures produced by the
contracts themselves, so the TypeScript and Solidity implementations of the
emission schedule, tick math and winner selection cannot drift apart.

## Build and test

```bash
forge build --sizes
forge test
```

`via_ir = true` is required, not stylistic: the legacy pipeline compiles the
hook to 24,846 bytes, which is 270 over the EIP-170 limit and cannot be
deployed. `forge build --sizes` verifies this.

For the TypeScript workspace:

```bash
pnpm install
pnpm test
```

## Pinned dependencies

Submodules are pinned by commit rather than tag.

| Repo | Commit |
|---|---|
| uniswap/v4-periphery | `3245c3cb99c48fa1dc2459c3b60abc37d4294aba` |
| uniswap/v4-hooks-public | `ffd7f8a8d1f5df5deb6f41c8d2ba99d118244ed6` |
| uniswap/v4-core (via periphery) | `59d3ecf53afa9264a16bba0e38f4c5d2231f80bc` |

## Deploy

The script asserts `block.chainid == 1` and checks the PoolManager's codehash
before any irreversible call. It takes no environment variables; the signer is
supplied on the command line.

Dry-run against a mainnet fork first — this exercises the real CREATE2 and
HookMiner path, which the tests do not:

```bash
forge script script/Deploy.s.sol:DeployBithook \
  --account <keystore-name> --sender <deployer-address> \
  --fork-url https://ethereum-rpc.publicnode.com
```

Broadcast through an MEV-protected endpoint. The launch seeds a pool where the
earliest buyers get the best price, so a public mempool exposes all six
transactions to snipers:

```bash
forge script script/Deploy.s.sol:DeployBithook \
  --account <keystore-name> --sender <deployer-address> \
  --rpc-url https://rpc.mevblocker.io/fullprivacy --broadcast --slow
```

Use the `/fullprivacy` path: the default MEV Blocker endpoint permits
backrunning, and a backrun on `seed()` is the exact case this guards against.
Send-optimised relays cannot serve the fork simulation that `--broadcast`
performs first.

The signing key is never passed through the environment. `--account` reads an
encrypted keystore from `~/.foundry/keystores` (create one with
`cast wallet import <name> --interactive`); `--ledger` signs on hardware
instead. With neither flag, forge falls back to its default sender, so the
script asserts the sender is not that address.

After deploying, verify:

1. the seed position matches the printed range and the pool holds 0 ETH
2. `token.minter() == hook` and `minterFinalized() == true`
3. `hook.miningStart() != 0`

`startMining()` is a separate call made after the pool has traded for a while,
so a price exists before mining arms. Emission runs from `startMining()`, not
from deployment. It refuses to arm an unseeded pool, or one whose minter was
finalised to the wrong address.

Uniswap v4 addresses come from the
[official deployments page](https://docs.uniswap.org/contracts/v4/deployments).
