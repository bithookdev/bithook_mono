// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BithookHarness} from "./Bithook.t.sol";
import {Bithook, BithookMiningHook} from "../src/Bithook.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";

/// Findings raised against v5.4, kept structurally intact from the auditor's
/// own PoCs. The former T-06 target lattice was removed in v5.9: these F-1
/// tests again assert the silent-window extraction succeeds, now as an explicit
/// design choice. With no swaps there is no price discovery to forecast.
contract AuditV54Test is BithookHarness {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    // ============================================================
    // F-1: the last swap of block N sets the block-N target EXACTLY,
    //      for the cost of a dust trade.
    //
    // The TWAP for block N+1 is boundaryCum[N+2] - boundaryCum[N+1], and both
    // boundaries are EXTRAPOLATED from the last observation at `lastTick`. If
    // no swap lands inside block N+1, both are extrapolated at the same tick,
    // so the difference is exactly tick*BLOCK_TIME and the target is exactly
    // the tick left behind by the final swap of block N.
    //
    // M-04's "push spot by s and hold it for fraction f, the average moves
    // s*f" is therefore the wrong model for the quiet regime. The attacker
    // does not need a big s. Everyone predicting for free predicts the SAME
    // number (the resting tick), so ONE TICK of movement beats the entire
    // field, and one tick is one basis point of price.
    // ============================================================
    function test_F1_dustNudgeAtEndOfCommitBlockWinsOutright() public {
        _fund();
        _toBlock(B);

        int24 natural = _spotTick();

        // The whole field predicts the resting tick -- in a quiet block that is
        // the correct, free, and exactly-right forecast.
        _commit(alice, natural, "honest1");
        _commit(bob, natural, "honest2");
        _commit(carol, natural, "honest3");

        // The attacker simulates their own nudge off-chain to learn the tick it
        // will leave behind. (Here: snapshot, swap, read, roll back.)
        uint256 snap = vm.snapshotState();
        _swap(attacker, true, -0.02 ether);
        int24 nudged = _spotTick();
        vm.revertToState(snap);

        assertTrue(nudged != natural, "the nudge has to move the integer tick at all");

        // Commit to the post-nudge tick, THEN nudge. Both inside block B.
        _commit(attacker, nudged, "atk");
        uint256 ethBefore = attacker.balance;
        uint256 tokBefore = token.balanceOf(attacker);
        vm.warp(hook.blockStart(B) + BLOCK_TIME - 1); // last second of block B
        _swap(attacker, true, -0.02 ether);
        assertEq(_spotTick(), nudged, "nudge reproduces the simulated tick");

        // Nobody trades during block B+1 -- that is what "quiet" means.
        _toBlock(B + 2);
        hook.poke();

        // Exact-tick scoring deliberately exposes the silent-window answer.
        // With no trade inside B+1, both the raw and scored target are exactly
        // the tick the attacker left behind.
        assertEq(hook.targetTickRaw(B), nudged, "raw TWAP is the attacker's tick");
        assertEq(hook.targetTick(B), nudged, "the exact tick is scored without a lattice");

        _reveal(alice, B, natural, "honest1");
        _reveal(bob, B, natural, "honest2");
        _reveal(carol, B, natural, "honest3");
        _reveal(attacker, B, nudged, "atk");

        assertEq(_winnerOf(B), attacker, "the exact silent-window tick takes the block");

        _toBlock(B + 3);
        vm.prank(attacker);
        hook.claimBlock(B);

        uint256 reward = _rewardOf(B);
        // What the certainty cost: the round trip is still open, so value the
        // position at the pool's own price by selling the BITHOOK straight back.
        uint256 bought = token.balanceOf(attacker) - tokBefore;
        _swap(attacker, false, -int256(bought));
        uint256 ethSpent = ethBefore - attacker.balance;

        emit log_named_int("natural tick         ", natural);
        emit log_named_int("attacker tick        ", nudged);
        emit log_named_uint("ticks moved          ", _absDiff(natural, nudged));
        emit log_named_uint("round-trip cost, wei ", ethSpent);
        emit log_named_uint("block reward, BITHOOK", reward / 1e18);

        assertGt(reward, 0, "and it is the whole block reward");
    }

    /// The same capture with the field ALSO holding a spread of guesses around
    /// the resting tick: the attacker still lands distance 0 because they chose
    /// the target after everyone had committed.
    function test_F1_beatsASpreadOfHonestForecasts() public {
        _fund();
        _toBlock(B);
        int24 natural = _spotTick();

        for (uint256 i = 0; i < 20; i++) {
            address g = address(uint160(0x1000 + i));
            _commit(g, natural + int24(int256(i)) * 60 - 600, bytes32(i + 1));
        }

        uint256 snap = vm.snapshotState();
        _swap(attacker, true, -0.02 ether);
        int24 nudged = _spotTick();
        vm.revertToState(snap);

        _commit(attacker, nudged, "atk");
        vm.warp(hook.blockStart(B) + BLOCK_TIME - 1);
        _swap(attacker, true, -0.02 ether);

        _toBlock(B + 2);
        hook.poke();
        int24 target = hook.targetTick(B);
        assertEq(target, nudged, "the silent-window target is the exact final tick");

        // Against a spread field, only an independently exact prediction can
        // tie. Nearby guesses retain their real distance instead of collapsing
        // into the same bucket.
        for (uint256 i = 0; i < 20; i++) {
            address g = address(uint160(0x1000 + i));
            int24 pred = natural + int24(int256(i)) * 60 - 600;
            _reveal(g, B, pred, bytes32(i + 1));
        }
        _reveal(attacker, B, nudged, "atk");

        assertEq(_winnerOf(B), attacker, "only the exact silent-window prediction has distance 0");
    }

    // ============================================================
    // F-3 / M-5 -- CLOSED in v5.8 by infinite halvings.
    //
    // The cliff existed because the schedule ended: past the last era
    // scheduledBlockReward(n) was 0, the claim ceiling 2*0 was 0, and anything
    // released-but-unallocated at that moment could never be paid. With eras
    // continuing forever there is no last era, so no cliff and nothing to
    // strand. These tests assert the cliff is gone rather than that it bites.
    // ============================================================
    function test_M5_thereIsNoScheduleEndToFallOffOf() public view {
        // the old cliff was at block 16,128 (day 112)
        assertGt(hook.scheduledBlockReward(16_128), 0, "the old cliff block still pays");
        assertGt(hook.scheduledBlockReward(100_000), 0, "and so does one years later");
        assertGt(hook.scheduledBlockReward(1_000_000), 0, "and one decades later");
        assertGt(hook.stakeFor(1_000_000), 0, "entry still costs a real stake, too");
    }

    /// A winner far past the old schedule end can still actually be paid.
    function test_M5_aBlockLongAfterTheOldCliffStillPays() public {
        uint256 n = 40_000; // ~day 278, well past the old 112-day schedule
        _toBlock(n);
        int24 t = _spotTick();
        _commit(alice, t, "a");
        _toBlock(n + 2);
        hook.poke();
        _reveal(alice, n, t, "a");

        _toBlock(n + 3);
        vm.prank(alice);
        hook.claimBlock(n);
        assertGt(_rewardOf(n), 0, "paid, where the old schedule paid nothing");
    }

    /// The part v5.7 DID fix: with emission on the clock, a miner who wins can
    /// always claim. Under the volume gate this reverted NothingToClaim until
    /// somebody happened to trade, which is what pushed miners to wash-buy.
    function test_M6_winnerCanClaimWithoutAnyoneTrading() public {
        _toBlock(6); // no swaps at all, ever
        int24 t = _spotTick();
        _commit(alice, t, "a");
        _toBlock(8);
        hook.poke();
        _reveal(alice, 6, t, "a");

        _toBlock(9);
        vm.prank(alice);
        hook.claimBlock(6); // would have reverted before v5.7
        assertGt(_rewardOf(6), 0, "paid from the schedule alone");
    }

    // ============================================================
    // F-4 -- the returned-stake recycling hole, remeasured for v5.8.
    //
    // The audit's point was that a revealed stake comes BACK and funds later
    // bets, so "outside capital" is far smaller than cumulative stakes. That
    // is now MORE true, not less: the lock is a fixed 10-20% of the halving
    // period by design, so a grid recycles roughly five times WITHIN a single
    // era rather than waiting for the era to end.
    //
    // This test measures the barrier honestly rather than asserting a fix.
    // ============================================================
    function test_F4_theLockIsAFractionOfTheEraSoStakesRecycleWithinIt() public {
        uint256 slices = hook.LOCK_SLICES_PER_ERA();
        uint256 eraOne = hook.ERA_ONE();
        uint256 w = eraOne / slices;

        // a stake placed in the first slice of era 1 is back before the era ends
        uint256 unlock = hook.stakeUnlockTime(0) - hook.miningStart();
        assertLt(unlock, eraOne, "era 1 stakes return DURING era 1");
        assertEq(unlock, 2 * w, "after exactly two slices");

        // so a sustained grid only ever has ~2 slices of stakes outstanding,
        // not the era's whole run of them
        uint256 blocksPerEra = eraOne / hook.BLOCK_TIME();
        uint256 stake = hook.stakeFor(0);
        uint256 wholeEra = 100 * stake * blocksPerEra;
        uint256 outstanding = wholeEra * 2 / slices;

        emit log_named_uint("100-wide grid, era 1 total staked   ", wholeEra / 1e18);
        emit log_named_uint("...but peak outside capital needed  ", outstanding / 1e18);
        emit log_named_uint("...as a % of the 21M supply         ", outstanding * 100 / 21_000_000e18);

        assertLt(outstanding, wholeEra / 4, "the lock recovers 4/5 of it inside the era");
    }
}


/// F-2 needs its own fixture: a pool that is initialised but NOT seeded when
/// startMining() is called.
contract StartMiningWithoutSeedTest is BithookHarness {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    function setUp() public override {
        _deployCore();
        vm.prank(owner);
        manager.initialize(key, TickMath.getSqrtPriceAtTick(PRODUCTION_START_TICK));
        vm.deal(owner, 100 ether);
        _fundActors();
    }

    // ============================================================
    // F-2: startMining() before the seed is in place bricks the protocol
    //      permanently, with no recovery path.
    //
    //   - seed() is one-shot, so the owner can never seed afterwards;
    //   - nothing else can add liquidity, at any time;
    //   - every swap reverts on the T-05 corridor guard, so no fee ever
    //     accrues either.
    //
    // The check that prevents it validates the hook's own seed position.
    // ============================================================
    function _trySeed() internal returns (bool ok) {
        vm.prank(owner);
        try hook.seed() {
            return true;
        } catch {
            return false;
        }
    }

    function _trySwap(address who, bool zeroForOne, int256 amt) internal returns (bool ok) {
        vm.prank(who);
        try swapRouter.swap{value: zeroForOne ? 20 ether : 0}(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: amt,
                sqrtPriceLimitX96: zeroForOne
                    ? TickMath.MIN_SQRT_PRICE + 1
                    : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        ) returns (BalanceDelta) {
            return true;
        } catch {
            return false;
        }
    }

    /// L-01: while the deployer is the temporary minter it must not be able to
    /// create supply. Minting becomes live only after the one-way handoff, at
    /// which point only the finalized hook address can call it.
    function test_L01_deployerCannotMintBeforeFinalization() public {
        Bithook fresh = new Bithook(owner); // this test contract is the temporary minter

        vm.expectRevert(Bithook.MinterNotFinalized.selector);
        fresh.mint(owner, 1);
        assertEq(fresh.totalSupply(), fresh.INITIAL_SUPPLY(), "pre-mint changed no supply");

        fresh.finalizeMinter(address(hook));
        vm.prank(address(hook));
        fresh.mint(owner, 1);
        assertEq(fresh.totalSupply(), fresh.INITIAL_SUPPLY() + 1, "final hook can mint");
    }

    /// Defence in depth for L-01. This state is unreachable through Bithook after
    /// the pre-finalization mint guard above, but startMining() independently
    /// refuses an anomalous supply increase before making launch irreversible.
    function test_L01_startMiningRefusesSupplyAboveInitial() public {
        vm.prank(owner);
        token.approve(address(hook), type(uint256).max);
        assertTrue(_trySeed(), "seed installed");

        deal(address(token), attacker, 1, true); // model a legacy/pre-fix over-mint
        assertGt(token.totalSupply(), token.INITIAL_SUPPLY());

        vm.prank(owner);
        vm.expectRevert(BithookMiningHook.InitialSupplyExceeded.selector);
        hook.startMining();
        assertEq(hook.miningStart(), 0, "mining stayed disarmed");
    }

    function test_F2_startMiningBeforeSeedIsAnUnrecoverableBrick() public {
        assertEq(IPoolManager(address(manager)).getLiquidity(key.toId()), 0, "pool is empty");

        vm.prank(owner);
        token.approve(address(hook), type(uint256).max);

        // T-07 FIX: the brick is now unreachable -- startMining() refuses to
        // arm a pool whose seed position is not actually there. Before this
        // guard the call succeeded and killed the protocol permanently: seed()
        // is one-shot so the owner could never seed; nothing else can add;
        // and every swap reverted on the T-05 corridor guard; and there is no
        // admin surface to undo any of it.
        vm.prank(owner);
        vm.expectRevert(BithookMiningHook.PoolNotSeeded.selector);
        hook.startMining();
        assertEq(hook.miningStart(), 0, "and mining did not start");

        // seed, and the very same call now works
        assertTrue(_trySeed(), "seeding is possible before startMining");
        vm.prank(owner);
        hook.startMining();
        assertTrue(hook.miningStart() != 0, "armed only once the pool is real");

        // and the seal behaves exactly as before from that moment
        assertFalse(_trySeed(), "liquidity is frozen post-start");
        assertTrue(_trySwap(alice, true, -1 ether), "but the pool actually trades");
    }

    /// T-08 (L-4): finalizeMinter() is one-shot and unvalidated, so a typo in
    /// the deploy script would silently point minting at a dead address and
    /// every future reward -- including already-created vests -- would revert.
    /// startMining() is the last moment that is still fixable, so it checks.
    function test_T08_startMiningRefusesIfTheHookIsNotTheFinalMinter() public {
        Bithook fresh = new Bithook(owner); // minter is this test contract
        fresh.finalizeMinter(address(0xdead)); // the typo

        address hookAddr = address(HOOK_FLAGS | (0x5555 << 20));
        deployCodeTo(
            "Bithook.sol:BithookMiningHook",
            abi.encode(IPoolManager(address(manager)), fresh, owner),
            hookAddr
        );
        BithookMiningHook h2 = BithookMiningHook(payable(hookAddr));

        PoolKey memory k2 = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(fresh)),
            fee: 0,
            tickSpacing: 200,
            hooks: IHooks(hookAddr)
        });
        vm.prank(owner);
        manager.initialize(k2, TickMath.getSqrtPriceAtTick(PRODUCTION_START_TICK));

        vm.startPrank(owner);
        _seedProduction(h2, fresh);
        // seeded, but minting was finalised to the wrong address
        vm.expectRevert(BithookMiningHook.MinterNotFinalizedToHook.selector);
        h2.startMining();
        vm.stopPrank();
    }

}

/// F-5 needs the PRODUCTION launch geometry: single-sided seed, pool opened
/// exactly on the seed's tickUpper, and -- the load-bearing part -- a
/// PoolManager holding ZERO ETH.
contract ExactOutputAtLaunchTest is BithookHarness {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    int24 startTick;
    int24 seedLower;

    function setUp() public override {
        super.setUp();
        startTick = PRODUCTION_START_TICK;
        seedLower = PRODUCTION_SEED_LOWER;
    }

    function _tryBuy(address who, int256 amt) internal returns (bool ok) {
        vm.prank(who);
        try swapRouter.swap{value: 20 ether}(
            key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: amt,
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        ) returns (BalanceDelta) {
            return true;
        } catch {
            return false;
        }
    }

    // ============================================================
    // F-5: in the opening window, every EXACT-OUTPUT buy reverted.
    //
    // On an exact-output zeroForOne swap the "unspecified" currency is the
    // INPUT, i.e. native ETH. _afterSwap called poolManager.take(ETH, hook,
    // fee) -- but the swapper has not settled yet, and under the single-sided
    // seed the manager holds NO ETH at all at launch. The take did a real
    // native transfer out of an empty manager and reverted. It healed as soon
    // as ordinary exact-input buys had left ETH in the manager, so it was an
    // opening-window liveness bug -- but the opening window is exactly the
    // contested moment.
    //
    // Fixed by collecting the ETH side as an ERC-6909 claim (mint) instead of
    // ETH (take): same delta, no transfer, so nothing has to be in the manager
    // yet. Assertions inverted, PoC otherwise unchanged.
    // ============================================================
    function test_F5_exactOutputBuysWorkWhileTheManagerHoldsNoEth() public {
        assertEq(address(manager).balance, 0, "single-sided launch: manager holds zero ETH");

        // exact-INPUT buy: fee is taken in BITHOOK, which the manager has. Fine.
        uint256 snap = vm.snapshotState();
        assertTrue(_tryBuy(alice, -0.1 ether), "exact-input buy works at launch");
        vm.revertToState(snap);

        // exact-OUTPUT buy for the same order of magnitude: fee is in ETH, and
        // the manager still holds none. This is the swap that used to revert.
        assertTrue(_tryBuy(alice, int256(1_000e18)), "exact-output buy works at launch");
        // The manager is no longer empty -- alice settled her ETH -- but none
        // of it ever left: the fee is a claim against it, not a transfer.
        assertGt(hook.pendingEth(), 0, "the fee accrued as a claim, not as ETH");
        assertEq(address(hook).balance, 0, "the hook received no ETH");
        assertEq(manager.balanceOf(address(hook), 0), hook.pendingEth(), "backed 1:1 by 6909");
        assertGe(address(manager).balance, hook.pendingEth(), "and the claim is covered");

        // and it keeps working once ETH is in the manager, too.
        assertTrue(_tryBuy(bob, -1 ether), "an ordinary buy puts ETH in the manager");
        assertGt(address(manager).balance, 0);
        assertTrue(_tryBuy(alice, int256(1_000e18)), "exact-output still works");
    }

    /// The other half of the fix: a claim is not just collectable, it is
    /// SPENDABLE. Fee ETH accrued at launch as 6909 and nothing else -- the
    /// hook never holds a wei -- so buybackAndBurn(maxEthIn) has to pay for its swap
    /// by burning the claim. If the two halves disagreed this is where it
    /// would show, as an unpayable delta at the end of the unlock.
    function test_F5_buybackSpendsClaimsItNeverHeldAsEth() public {
        assertTrue(_tryBuy(alice, int256(1_000e18)), "exact-output buy at launch");
        uint256 claims = hook.pendingEth();
        assertGt(claims, 0);
        assertEq(manager.balanceOf(address(hook), 0), claims);
        assertEq(address(hook).balance, 0, "no ETH anywhere in the hook");

        uint256 supply = token.totalSupply();
        uint256 managerEth = address(manager).balance;
        hook.buybackAndBurn(0);

        assertEq(hook.pendingEth(), 0, "the claim was spent");
        assertEq(manager.balanceOf(address(hook), 0), 0, "and burned");
        assertGt(hook.totalBuybackBurned(), 0, "it bought BITHOOK");
        assertEq(token.totalSupply(), supply - hook.totalBuybackBurned(), "and destroyed it");
        assertEq(address(manager).balance, managerEth, "no ETH crossed the manager");
    }

    // ============================================================
    // The MIRROR of F-5, and why the claims cover BOTH currencies.
    //
    // An exact-output SELL pays its fee in BITHOOK, and take() needed the
    // manager to physically hold that before the seller settled. Under the
    // pre-v6.0 bounded corridor that failed at a real lifecycle point: a
    // buy-out to the corridor floor left the seed inventory at ~2 wei of
    // dust, and every exact-output sell reverted at the one moment sells
    // were the only trade the pool could serve. v6.0's tail reaches the
    // minimum usable tick, so the dust state now sits ~4e22 ETH away --
    // unreachable -- but the claim symmetry it forced is still the live
    // mechanism on every exact-output sell, exercised here deep in the
    // curve after a large buy.
    // ============================================================
    function test_F5mirror_exactOutputSellFeeIsAClaimNotATake() public {
        vm.warp(block.timestamp + 10);

        // buy deep into the curve so the sell below has real ETH to draw on
        vm.deal(attacker, 2_000 ether);
        vm.prank(attacker);
        swapRouter.swap{value: 1_500 ether}(
            key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(uint256(1_500 ether)),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );

        uint256 id = uint256(uint160(address(token)));

        // exact-output sell: the direction whose fee is BITHOOK.
        uint256 ethBefore = attacker.balance;
        vm.prank(attacker);
        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: false,
                amountSpecified: int256(0.001 ether),
                sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        assertEq(attacker.balance - ethBefore, 0.001 ether, "exact output delivered");
        assertGt(hook.pendingToken(), 0, "the fee accrued as a claim");
        assertEq(manager.balanceOf(address(hook), id), hook.pendingToken(), "backed 1:1 by 6909");

        // And the claim is spendable right here: burnFees() takes the
        // physical BITHOOK the claim was minted against -- the seller's own
        // settlement -- and destroys it.
        uint256 supply = token.totalSupply();
        uint256 pending = hook.pendingToken();
        hook.burnFees();
        assertEq(token.totalSupply(), supply - pending, "the fee was destroyed");
        assertEq(hook.pendingToken(), 0);
        assertEq(manager.balanceOf(address(hook), id), 0, "the claim was burned to pay for it");
    }
}

/// How cheap does F-1 get? The attacker only needs to move the integer tick by
/// ONE, because in a quiet block the entire honest field predicts the same
/// resting tick. This searches for the smallest buy that shifts the tick at all
/// and runs the capture with it.
contract MinimalNudgeTest is BithookHarness {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    function test_F1_minimalNudgeThatStillWinsTheWholeBlock() public {
        _fund();
        _toBlock(B);
        int24 natural = _spotTick();

        _commit(alice, natural, "honest1");
        _commit(bob, natural, "honest2");

        // smallest buy (by binary search over powers of ten) that moves the tick
        int256 amt;
        int24 nudged;
        for (uint256 e = 18; e >= 6; e--) {
            uint256 snap = vm.snapshotState();
            _swap(attacker, true, -int256(10 ** e));
            int24 t = _spotTick();
            vm.revertToState(snap);
            if (t != natural) {
                amt = -int256(10 ** e);
                nudged = t;
            } else {
                break; // too small to register; the previous size is the floor
            }
        }
        assertTrue(amt != 0, "found a tick-moving buy");

        _commit(attacker, nudged, "atk");
        uint256 ethBefore = attacker.balance;
        uint256 tokBefore = token.balanceOf(attacker);

        vm.warp(hook.blockStart(B) + BLOCK_TIME - 1);
        _swap(attacker, true, amt);

        _toBlock(B + 2);
        hook.poke();
        assertEq(hook.targetTick(B), nudged, "exact scoring preserves the moved tick");

        _reveal(alice, B, natural, "honest1");
        _reveal(bob, B, natural, "honest2");
        _reveal(attacker, B, nudged, "atk");
        address w = _winnerOf(B);
        assertEq(w, attacker, "the accepted silent-window nudge takes the block");

        _toBlock(B + 3);
        vm.prank(w);
        hook.claimBlock(B);

        // close the round trip so the cost is a realised number, not a position
        uint256 bought = token.balanceOf(attacker) - tokBefore;
        _swap(attacker, false, -int256(bought));

        emit log_named_uint("nudge size, wei ETH  ", uint256(-amt));
        emit log_named_uint("ticks moved          ", _absDiff(natural, nudged));
        emit log_named_uint("round-trip cost, wei ", ethBefore - attacker.balance);
        emit log_named_uint("block reward, BITHOOK", _rewardOf(B) / 1e18);
    }
}
