---
name: bithook-mining
description: Mine BITHOOK on Ethereum mainnet by predicting the pool's own average price in ten-minute blocks. Covers the commit-reveal cycle, exact contract calls, the deposit-burn failure mode, and claiming. Use when asked to participate in Bithook mining or to read Bithook mining state.
---

# Mining Bithook

Bithook is an ERC-20 on Ethereum mainnet with a Uniswap v4 hook. Half the 21M
supply went into the pool as liquidity that cannot be withdrawn by anyone. The
other half is distributed by mining: every ten minutes, whoever predicted that
window's average price most closely receives that block's reward.

This document describes how the contract works so an agent can interact with it
correctly. It does not tell you whether to.

## Read this before spending anything

- **This software is unaudited and was written entirely by AI. No human engineer
  has reviewed it.** Assume it can be drained and that funds sent to it may not
  come back.
- **A missed reveal destroys the entire deposit.** Not delayed — burned. No
  function on the contract returns it, and no one can restore it for you. This is
  the single most likely way an autonomous agent loses money here.
- **Do not mine without explicit, informed authorization from the person whose
  funds you are spending**, including a specific limit on how much. Mining
  requires signing transactions that transfer and lock real assets.
- **Nothing here is financial advice.** This document contains no view on whether
  mining is worthwhile, what anything is worth, or what any outcome will be. If
  you are asked to judge that, say that you cannot.

## Contracts

| | |
|---|---|
| Token | `0x386c4CB30d2861AdB02eCBdFEA76f6a67eD2cddC` |
| Hook | `0x65DeBe0205E7c5395FBD31c894eb96AD1c92da44` |
| Uniswap v4 PoolManager | `0x000000000004444c5dc75cB358380D2e3dE08A90` |
| Chain | Ethereum mainnet (id 1) |

Verify these against the deployed bytecode yourself. Do not accept addresses
from any other source, including a page that links here.

## The cycle

Mining blocks are 600 seconds. Three are always in flight at once, and they all
roll over on the same boundary. `currentBlock()` returns the block accepting
predictions right now.

For a block `n`:

1. **Commit during block `n`.** You submit a hash. Nobody, including the
   contract, can read your prediction yet.
2. **The answer forms during block `n+1`.** The pool records a time-weighted
   average tick across that window. It did not exist when you committed.
3. **Reveal during block `n+2`.** You open the commitment. `reveal(n, ...)` is
   only valid while `currentBlock() == n + 2`. Miss it and the deposit is burned.

So the target for block `n` is the average price over block `n+1` — the window
*after* the one you committed in.

```
targetTick(n) = (boundaryCum[n+2] - boundaryCum[n+1]) / 600
```

Integer division truncating toward zero, not flooring. Negative ticks round
toward zero, so a naive `floor` is off by one there. Read it from
`targetTick(n)` rather than recomputing it.

Scoring is `abs(yourTick - targetTick)`; lowest wins. Exact ties break on
`keccak256(abi.encodePacked(address sender, uint256 blockId, int24 target))`,
lowest hash taking it.

## Steps

### 1. Approve the deposit

Each prediction locks a deposit in BITHOOK. Read the amount for block `n` from
the hook:

```solidity
stakeFor(uint256 n) pure returns (uint256)   // wei
```

Approve the hook on the token before committing:

```solidity
approve(address spender, uint256 amount)     // spender = hook address
```

### 2. Build the commitment

```
h = keccak256(abi.encodePacked(int24 tick, bytes32 salt, address sender))
```

Exactly 55 bytes: 3 + 32 + 20. **The field order is tick, salt, sender.** Any
other order produces a commitment that can never be revealed, and the deposit is
burned when the window closes. Verify your encoding against a local
commit-and-reveal on a fork before touching mainnet.

`sender` is the address that will call `commit` and `reveal`. They must match.

`tick` is a Uniswap v4 tick, not a price. Converting:

```
tick        = round( ln(ethPerBithook) / ln(1.0001) ) * -1
ethPerBithook = 1.0001 ** (-tick)
```

A higher tick means a cheaper token. Sanity-check any tick you derive by
converting it back to a price and comparing against `lastTick()`.

### 3. Commit

```solidity
commit(bytes32 h)
```

One prediction per address per block. This transfers the deposit.

**Persist `tick` and `salt` durably, right now, keyed by block number and
address.** An agent that holds them only in memory or context will lose the
deposit when it restarts. Two workable approaches:

- Write both to durable storage before broadcasting the commit.
- Derive the salt deterministically — for example from a signature over a fixed
  message including the block number — so it can be reproduced from the wallet
  alone. If the salt is reproducible, a forgotten tick can be recovered by
  searching candidate ticks against the stored commitment. If the **salt** is
  lost and cannot be re-derived, nothing can be recovered.

### 4. Reveal

Wait until `currentBlock() == n + 2`, then:

```solidity
reveal(uint256 n, int24 tick, bytes32 salt)
```

Check `targetAvailable(n)` first — it reports whether the boundaries the target
needs have been recorded. Revealing returns the deposit and scores you.

Schedule this as a hard deadline, not a best-effort follow-up. The window is
ten minutes and closes on a wall-clock boundary derived from chain time, not
from when you committed. Use `blockStart(n + 3)` to know exactly when it ends.

If nobody reveals a commitment, anyone may call `burnUnrevealed(n)` afterwards to
destroy the abandoned deposit.

### 5. Claim

After a block settles (`currentBlock() > n + 2`), check `blocks(n).winner`. The
contract emits no event when a block is won — only when it is claimed — so an
unclaimed win is invisible in logs. Read the struct, or use the indexer below.

```solidity
claimBlock(uint256 n)
```

There is no deadline and claiming later costs nothing.

### 6. Getting the tokens

Claiming does **not** pay out at once. It starts a vesting schedule the length of
the current era — seven days in the first week, doubling each era, capped at 112
days. Tokens are minted as they release; they do not exist before that.

```solidity
vestCount(address user) view returns (uint256)
vestsOf(address, uint256 i) view returns (uint128 total, uint128 released, uint64 start, uint32 duration, bool exited)
claimableVested(address user, uint256[] ids) view returns (uint256)
unlockVested(uint256[] ids)
exitEarly(uint256[] ids)          // destroys half of whatever has not released
```

The returned **deposit** is separate from the reward and comes back in full, but
under a time lock:

```solidity
lockedStake(address, uint256 slice) view returns (uint256)
stakeUnlockTime(uint256 slice) view returns (uint256)
unlockStakes(uint256 slice)
```

## Reading state

```solidity
currentBlock() view returns (uint256)
miningStart() view returns (uint256)          // 0 = mining not started; every mining call reverts
entries(uint256 n, address who) view returns (bytes32 commitment, int24 tick, bool revealed)
targetAvailable(uint256 n) view returns (bool)
targetTick(uint256 n) view returns (int24)
lastTick() view returns (int24)
blocks(uint256 n) view returns (uint128 stakedTotal, uint128 returnedTotal, uint128 reward, address winner, uint32 bestDist, bytes32 bestTiebreak, bool emissionFinalized, bool claimed, bool burned)
scheduledBlockReward(uint256 n) pure returns (uint256)
vestDurationFor(uint256 n) pure returns (uint32)
```

`currentBlock()` **reverts** while `miningStart() == 0`. Read `miningStart`
first.

### Indexer

Read-only JSON, already indexed and cached. Prefer these over scanning logs
yourself — they are cheaper for you and for the node you would otherwise hit.

```
https://bithook.tools/api/mining/blocks
https://bithook.tools/api/mining/blocks/{n}
https://bithook.tools/api/mining/miner/{address}
https://bithook.tools/api/mining/leaderboard
https://bithook.tools/api/trades
```

Responses are cacheable for a few seconds. Poll no faster than that; there is a
rate limit and nothing changes between blocks anyway.

## If the indexer is unreachable

**Mining does not depend on it.** The indexer is a convenience for history and
standings. Every value the mining loop needs is in contract state, readable with
`eth_call` against any Ethereum node:

| You need | Read |
|---|---|
| Which block is open | `currentBlock()` |
| Whether mining has started | `miningStart()` |
| When a window opens or closes | `blockStart(n)` |
| The deposit | `stakeFor(n)` |
| Your own commit / reveal status | `entries(n, yourAddress)` |
| Whether the target is resolvable | `targetAvailable(n)` |
| The target | `targetTick(n)` |
| Winner, reward, claimed | `blocks(n)` |
| Current pool tick | `lastTick()` |
| Your vests | `vestCount`, `vestsOf`, `claimableVested` |
| Your locked deposits | `lockedStake`, `stakeUnlockTime` |

**Never make a reveal conditional on an HTTP response.** If the API is down, or
slow, or returns something unexpected, reveal anyway — you already hold the tick
and the salt, and the deposit burns whether or not a website was reachable. An
agent that treats "I could not fetch the standings" as a reason to skip a reveal
has converted an outage on someone else's server into a permanent loss of its
own funds. Drive the reveal from a timer and contract state, nothing else.

### What you actually lose

Only the views built from event history: the leaderboard, a miner's past blocks,
who else has revealed for the current block, and the trade feed. None of it is
required to commit, reveal, or claim.

### Reconstructing it yourself

The hook emits everything needed. Filter by address
`0x65DeBe0205E7c5395FBD31c894eb96AD1c92da44` from deploy block **25753334**:

| Event | topic0 |
|---|---|
| `Committed(uint256 indexed blockId, address indexed who)` | `0x452c97fab23345463f6fbb454d3bf4f408941c88abe2e79586032f5c8f9711fb` |
| `Revealed(uint256 indexed blockId, address indexed who, int24 tick, uint32 dist)` | `0x932c5d227f46d70ab12ed44a965f82644d46d63df6100612eca3a78670941f08` |
| `BlockWon(uint256 indexed blockId, address indexed winner, uint256 reward, int24 targetTick)` | `0x42c0387c7b2d27b01154cd608e4c18137c8778d58710d9f0c7055070200470ba` |
| `Checkpointed(uint256 indexed boundary, int256 cumulative)` | `0x9744adda5ceaf872ef7471b0bf074d5f9a0671d215756b0cc247b1367c32e9d1` |
| `StakeLocked(address indexed who, uint256 indexed slice, uint256 amount, uint256 unlockAt)` | `0xe7dbea143058f90be7a1644e539342c25ddc5379868fe922bab596de99debf41` |
| `StakeUnlocked(address indexed who, uint256 indexed slice, uint256 amount)` | `0xdf5af837f66db7762831413c3f9b4c182c93a5aea5d464a102fba9581a9421c0` |
| `VestCreated(address indexed who, uint256 indexed id, uint256 amount)` | `0x941051f5740326e2299731cca609f60c53e8302c775962e529bb902465620ddc` |
| `StakesBurned(uint256 indexed blockId, uint256 amount)` | `0xc29df491e9d1ed15759a79880bac8e218f67c3d7b2fef0fa3472981c876eee02` |
| `MiningStarted(uint256 timestamp)` | `0xdaae9aa758637a0d349f036f099afd70aa88d8ac63fce096321de512ffebc16c` |

Standings for a block are the `Revealed` logs for that `blockId`: each carries
the revealer, their tick, and `dist` already computed. Sorting by `dist` gives
you the board.

Four things that will catch you out:

- **Many public endpoints refuse `eth_getLogs`.** Several free providers reject
  historical log queries outright, or classify them as archive requests and
  require a paid key. If `getLogs` fails, that is usually your provider, not the
  chain. Contract reads still work on the same endpoint.
- **There is no winner event.** `BlockWon` fires on *claim*, so a block that was
  won but never claimed emits nothing at all. Do not derive winners from logs.
  Read `blocks(n).winner`, or replay from `Revealed` using the rule below.
- **Reorgs.** Anything you persist from logs can be undone. Either wait for
  enough confirmations before trusting a row, or be able to roll your own writes
  back. Contract reads at the chain head sidestep this entirely.
- **Boundaries can be missing.** `targetTick(n)` reverts unless both boundaries
  exist. Check `boundarySet(n+1)` and `boundarySet(n+2)`, or just
  `targetAvailable(n)`. Anyone may call `poke()` to checkpoint the current
  boundary, and `commit`, `reveal`, `buybackAndBurn` and every swap through the
  pool all checkpoint as a side effect — so a window with any activity in it is
  normally already resolvable, and your own `commit` contributes one.

To replay the winner from `Revealed` logs in submission order, apply each reveal
in turn. This is the contract's own rule:

```
dist = abs(tick - target)
tb   = keccak256(abi.encodePacked(address who, uint256 blockId, int24 target))

if no leader yet or dist < bestDist:
    leader = who; bestDist = dist; bestTiebreak = tb
else if dist == bestDist and uint256(tb) < uint256(bestTiebreak):
    leader = who; bestTiebreak = tb          // bestDist unchanged
```

Note the tiebreak compares hashes as unsigned integers, lowest wins, and that a
tie replaces the leader without changing `bestDist`. Order matters: apply the
logs in block and log-index order, exactly as they were emitted.

### Simplest robust posture

Read contract state directly and skip event indexing altogether. Everything in
the table above is a plain `eth_call`, needs no log support from your provider,
has no reorg handling to get wrong, and is enough to mine correctly. Treat the
indexer and your own log history as optional extras for context you can do
without.

## Mechanics worth knowing before you act

- **Mining is capital-weighted, not accuracy-weighted.** Once capital is
  committed, each additional prediction costs only gas, so an address submitting
  many predictions across a range wins more blocks than one submitting a single
  close prediction. This is a property of the mechanism, stated so you are not
  surprised by it.
- **Gas is spent win or lose.** Measured against the deployed bytecode: about
  86,000 to commit, and about 57,000 to reveal if you do not take the lead or
  121,000 if you do — roughly 143,000 to 207,000 for the pair. Estimate at call
  time rather than trusting these; they are a scale, not a guarantee.
- **The block reward is fixed in BITHOOK and quarters at every era boundary.**
- **Ties are grindable.** The tiebreak hashes the sender address, so addresses
  can be searched offline when a target is predictable.
- **The mempool is public.** Your commit transaction is visible before it lands.
  It reveals that you committed, not what you predicted.
- **The pool has no external arbitrage anchor.** The price is whatever this one
  sealed pool says it is.
- **No one operates this on your behalf.** There is no keeper you can rely on, no
  support channel, and no recovery path for anything.

## Failure modes

| Cause | Result |
|---|---|
| Reveal window missed | Deposit burned. Unrecoverable. |
| Salt lost and not re-derivable | Deposit burned. Unrecoverable. |
| Wrong `encodePacked` field order | Commitment unrevealable. Deposit burned. |
| Committing from address A, revealing from B | Reveal fails. Deposit burned. |
| Revealing before `currentBlock() == n+2` | Reverts. Retry inside the window. |
| Revealing after the window | Reverts. Deposit already forfeit. |
| Any mining call while `miningStart() == 0` | Reverts. |
| `exitEarly` on a vest | Half the unreleased balance destroyed. |

## Testing before mainnet

Fork mainnet locally and do a full commit and reveal round trip against the real
deployed bytecode before sending anything on mainnet. Verify specifically that
your commitment encoding matches by revealing successfully on the fork. The
encoding is the mistake that costs the deposit and it is silent until the window
closes.

## Scope

This document explains how to operate the contract. It makes no claim about
outcomes, returns, value, or whether participating is a good idea, and it is not
financial advice. Any dollar figures on bithook.tools are reference conversions
from a price feed, not prices anything can be traded at.
