// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Bithook, BithookMiningHook} from "../src/Bithook.sol";

import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";

/// Shared fixture: pool, hook, routers and helpers. Carries NO tests, so a
/// suite that opens the pool differently (see LaunchCurve.t.sol) can reuse the
/// helpers without inheriting assertions written for another seed shape.
abstract contract BithookHarness is Test {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    PoolManager manager;
    PoolSwapTest swapRouter;
    PoolModifyLiquidityTest lpRouter;

    Bithook token;
    BithookMiningHook hook;
    PoolKey key;

    address owner = makeAddr("owner");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address attacker = makeAddr("attacker");

    uint160 constant SQRT_PRICE_10M5 = uint160((3_240_370_349 * (uint256(1) << 96)) / 1e6);
    int24 constant FULL_RANGE_LOWER = -887_200;
    int24 constant FULL_RANGE_UPPER = 887_200;
    int24 constant PRODUCTION_START_TICK = 164_600;
    int24 constant PRODUCTION_GRAD_TICK = 137_800;
    int24 constant PRODUCTION_SEED_LOWER = -887_200;

    uint256 BLOCK_TIME;

    uint160 constant HOOK_FLAGS = uint160(
        Hooks.AFTER_INITIALIZE_FLAG | Hooks.AFTER_SWAP_FLAG
            | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
            | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
    );

    /// manager, routers, token, hook and the PoolKey -- everything up to (but
    /// not including) pool initialisation, so a subclass can open the pool at
    /// a different price or seed it in a different shape.
    function _deployCore() internal {
        vm.warp(1_000_000);
        manager = new PoolManager(address(this));
        swapRouter = new PoolSwapTest(manager);
        lpRouter = new PoolModifyLiquidityTest(manager);
        // On a fork a freshly deployed contract can land on an address that
        // already holds mainnet ETH, and PoolSwapTest refunds its whole
        // balance to the caller after every swap -- so the first swapper would
        // silently pocket it. Harmless locally (always zero), load-bearing on
        // a fork. See test/sim/BithookSim.t.sol for the measured case.
        vm.deal(address(swapRouter), 0);
        vm.deal(address(lpRouter), 0);

        token = new Bithook(owner);

        address hookAddr = address(HOOK_FLAGS | (0x4444 << 20));
        deployCodeTo(
            "Bithook.sol:BithookMiningHook",
            abi.encode(IPoolManager(address(manager)), token, owner),
            hookAddr
        );
        hook = BithookMiningHook(payable(hookAddr));
        token.finalizeMinter(address(hook));
        BLOCK_TIME = hook.BLOCK_TIME();

        key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(token)),
            fee: 0,
            tickSpacing: 200,
            hooks: IHooks(address(hook))
        });
    }

    function setUp() public virtual {
        _deployCore();

        vm.prank(owner);
        manager.initialize(key, TickMath.getSqrtPriceAtTick(PRODUCTION_START_TICK));

        vm.startPrank(owner);
        _seedProduction(hook, token);
        hook.startMining();
        vm.stopPrank();

        // Production seeds the entire initial allocation. Test participants
        // still need stake balances, so give them synthetic balances without
        // changing totalSupply; the mechanism tests are otherwise run against
        // the exact production pool geometry and reserves.
        deal(address(token), alice, 2_000e18, false);
        deal(address(token), bob, 2_000e18, false);
        deal(address(token), carol, 2_000e18, false);
        deal(address(token), attacker, 2_000e18, false);
        for (uint256 i = 0; i < 30; i++) {
            deal(address(token), address(uint160(0x1000 + i)), 250e18, false);
        }

        _fundActors();
    }

    function _seedProduction(BithookMiningHook targetHook, Bithook targetToken) internal {
        // v6.0: the hook owns the whole geometry; callers only fund it.
        targetToken.approve(address(targetHook), targetToken.INITIAL_SUPPLY());
        targetHook.seed();
    }

    /// ETH and approvals for every participant the suites use
    function _fundActors() internal {
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(carol, 100 ether);
        vm.deal(attacker, 1000 ether);
        address[4] memory who = [alice, bob, carol, attacker];
        for (uint256 i = 0; i < 4; i++) {
            vm.startPrank(who[i]);
            token.approve(address(swapRouter), type(uint256).max);
            token.approve(address(hook), type(uint256).max);
            vm.stopPrank();
        }
        for (uint256 i = 0; i < 30; i++) {
            address a = address(uint160(0x1000 + i));
            vm.deal(a, 10 ether);
            vm.prank(a);
            token.approve(address(hook), type(uint256).max);
        }
    }

    // ---------- helpers ----------

    function _swap(address who, bool zeroForOne, int256 amountSpecified)
        internal
        returns (int128 a0, int128 a1)
    {
        uint256 v = zeroForOne ? 20 ether : 0;
        vm.prank(who);
        try swapRouter.swap{value: v}(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: amountSpecified,
                sqrtPriceLimitX96: zeroForOne
                    ? TickMath.MIN_SQRT_PRICE + 1
                    : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        ) returns (BalanceDelta d) {
            return (d.amount0(), d.amount1());
        } catch (bytes memory reason) {
            assembly {
                revert(add(reason, 0x20), mload(reason))
            }
        }
    }

    function _hash(int24 tick, bytes32 salt, address who) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(tick, salt, who));
    }

    function _commit(address who, int24 tick, bytes32 salt) internal {
        vm.prank(who);
        hook.commit(_hash(tick, salt, who));
    }

    function _reveal(address who, uint256 n, int24 tick, bytes32 salt) internal {
        vm.prank(who);
        hook.reveal(n, tick, salt);
    }

    function _toBlock(uint256 n) internal {
        vm.warp(hook.blockStart(n));
    }

    function _absDiff(int24 a, int24 b) internal pure returns (uint256) {
        int256 d = int256(a) - int256(b);
        return uint256(d < 0 ? -d : d);
    }

    function _spotTick() internal view returns (int24 t) {
        (, t,,) = IPoolManager(address(manager)).getSlot0(key.toId());
    }

    uint256 B; // first usable block after funding

    /// Accrue emission so blocks have something to pay out, and set B.
    /// Warps an hour in so scheduleCap() is non-zero -- at elapsed 0 the
    /// ceiling is 0, so nothing can accrue no matter how much volume arrives.
    function _fund() internal {
        vm.warp(hook.blockStart(6));
        _swap(alice, true, -0.05 ether);
        B = 7;
    }

    function _winnerOf(uint256 n) internal view returns (address w) {
        (,,, w,,,,,) = hook.blocks(n);
    }

    function _rewardOf(uint256 n) internal view returns (uint256 r) {
        (,, uint128 rw,,,,,,) = hook.blocks(n);
        r = rw;
    }

    function _stakedOf(uint256 n) internal view returns (uint256 s) {
        (uint128 st,,,,,,,,) = hook.blocks(n);
        s = st;
    }

    function _emissionFinalizedOf(uint256 n) internal view returns (bool finalized) {
        (,,,,,, finalized,,) = hook.blocks(n);
    }

    /// full lifecycle: commit in block n, target in n+1, reveal in n+2
    function _playBlock(uint256 n, address who, int24 tick, bytes32 salt) internal {
        _toBlock(n);
        _commit(who, tick, salt);
        _toBlock(n + 2);
        hook.poke(); // ensure boundaries n+1 and n+2 are checkpointed
        _reveal(who, n, tick, salt);
    }

}

/// The mechanism suite, run against the exact production launch seed.
contract BithookTest is BithookHarness {
    event Transfer(address indexed from, address indexed to, uint256 amount);

    // ============================================================
    // C-01 / basics
    // ============================================================

    function test_secondInitReverts() public {
        PoolKey memory evil = key;
        evil.fee = 500;
        evil.tickSpacing = 10;
        vm.prank(attacker);
        vm.expectRevert();
        manager.initialize(evil, SQRT_PRICE_10M5);
    }

    function test_attackerCannotFrontrunInit() public {
        Bithook t2 = new Bithook(owner);
        address h2 = address(HOOK_FLAGS | (0x5555 << 20));
        deployCodeTo(
            "Bithook.sol:BithookMiningHook",
            abi.encode(IPoolManager(address(manager)), t2, owner),
            h2
        );
        PoolKey memory k2 = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(t2)),
            fee: 0,
            tickSpacing: 200,
            hooks: IHooks(h2)
        });
        vm.prank(attacker);
        vm.expectRevert();
        manager.initialize(k2, SQRT_PRICE_10M5);
    }

    function test_wrongProductionOpeningPriceRejected() public {
        Bithook t2 = new Bithook(owner);
        address h2 = address(HOOK_FLAGS | (0x6666 << 20));
        deployCodeTo(
            "Bithook.sol:BithookMiningHook",
            abi.encode(IPoolManager(address(manager)), t2, owner),
            h2
        );
        PoolKey memory k2 = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(t2)),
            fee: 0,
            tickSpacing: 200,
            hooks: IHooks(h2)
        });

        vm.prank(owner);
        // PoolManager wraps hook callback errors in WrappedError.
        vm.expectRevert();
        manager.initialize(k2, TickMath.getSqrtPriceAtTick(PRODUCTION_START_TICK - 200));
    }

    function test_onlyOwnerStartsMining() public {
        vm.prank(attacker);
        vm.expectRevert(BithookMiningHook.NotOwner.selector);
        hook.startMining();
    }

    /// Infinite halvings: the schedule APPROACHES the mining supply and never
    /// reaches it, the same way Bitcoin approaches 21M. That is the property
    /// that removes the day-112 cliff -- there is no last era to fall off.
    function test_capApproachesButNeverReachesTheMiningSupply() public view {
        uint256 M = hook.TOTAL_MINING_SUPPLY();
        assertLe(token.INITIAL_SUPPLY() + M, token.MAX_SUPPLY());

        assertEq(hook.scheduleCap(0), 0);
        assertEq(hook.scheduleCap(7 days), M / 2, "era 1 emits half of everything");
        assertEq(hook.scheduleCap(21 days), M * 3 / 4, "era 2 emits half the rest");
        assertEq(hook.scheduleCap(49 days), M * 7 / 8, "era 3, half again");
        assertEq(hook.scheduleCap(105 days), M * 15 / 16, "era 4");

        // strictly below, at every horizon, forever
        assertLt(hook.scheduleCap(112 days), M);
        assertLt(hook.scheduleCap(3650 days), M, "ten years in, still short");
        assertLt(hook.scheduleCap(36500 days), M, "a century in, still short");
        assertGt(hook.scheduleCap(3650 days), M * 997 / 1000, "ten years in, within 0.3%");
    }

    /// It is also monotonic, which claimBlock's ceiling depends on.
    function test_capIsMonotonic() public view {
        uint256 prev;
        for (uint256 d = 0; d <= 400; d += 7) {
            uint256 c = hook.scheduleCap(d * 1 days);
            assertGe(c, prev);
            prev = c;
        }
    }

    function test_strayEthRejected() public {
        vm.prank(alice);
        (bool ok,) = address(hook).call{value: 1 ether}("");
        assertFalse(ok);
    }

    // ============================================================
    // E-01: sealed liquidity
    // ============================================================

    function test_addLiquidityFrozenAfterStart() public {
        vm.deal(owner, 0.1 ether);
        vm.prank(owner);
        vm.expectRevert();
        lpRouter.modifyLiquidity{value: 0.1 ether}(
            key,
            ModifyLiquidityParams({
                tickLower: FULL_RANGE_LOWER, tickUpper: FULL_RANGE_UPPER,
                liquidityDelta: int256(1e18), salt: 0
            }),
            ""
        );
    }

    function test_removeLiquidityFrozenAfterStart() public {
        vm.prank(owner);
        vm.expectRevert();
        lpRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: FULL_RANGE_LOWER, tickUpper: FULL_RANGE_UPPER,
                liquidityDelta: -int256(1e18), salt: 0
            }),
            ""
        );
    }

    // ============================================================
    // M-02: time-indexed blocks
    // ============================================================

    function test_blockIndexingIsPureTime() public {
        assertEq(hook.currentBlock(), 0);
        vm.warp(hook.miningStart() + BLOCK_TIME - 1);
        assertEq(hook.currentBlock(), 0);
        vm.warp(hook.miningStart() + BLOCK_TIME);
        assertEq(hook.currentBlock(), 1);
        vm.warp(hook.miningStart() + 500 * BLOCK_TIME + 5);
        assertEq(hook.currentBlock(), 500, "no crank needed, ever");
        assertEq(hook.blockStart(500), hook.miningStart() + 500 * BLOCK_TIME);
    }

    function test_scheduledBlockRewardAndStake() public view {
        // era 1: 5.25M over 7 days = 1,008 blocks
        assertApproxEqRel(hook.scheduledBlockReward(0), uint256(5_250_000e18) / 1008, 0.001e18);
        assertEq(hook.stakeFor(0), hook.scheduledBlockReward(0) / 100, "stake is 1%");

        // the per-block reward QUARTERS each era: the era total halves while
        // the era's length doubles
        uint256 era1 = hook.scheduledBlockReward(0);
        uint256 era2 = hook.scheduledBlockReward(1008 + 10);
        uint256 era3 = hook.scheduledBlockReward(3024 + 10);
        assertApproxEqRel(era2, era1 / 4, 0.01e18, "era 2 pays a quarter of era 1");
        assertApproxEqRel(era3, era2 / 4, 0.01e18, "and so on");
    }

    // ============================================================
    // M-04: the TWAP oracle
    // ============================================================

    function test_quietBlockTwapEqualsConstantTick() public {
        int24 t0 = _spotTick();
        _toBlock(3);
        hook.poke();
        // no swaps at all across block 1 -> its TWAP is exactly the resting tick
        assertEq(hook.targetTickRaw(0), t0, "quiet block averages to the standing tick");
        // Scoring uses the exact int24 tick; there is no protocol price bucket.
        assertEq(hook.targetTick(0), t0, "the exact standing tick is scored");
    }

    function test_pokeCheckpointsWithoutSwaps() public {
        assertFalse(hook.targetAvailable(0));
        _toBlock(2);
        hook.poke(); // permissionless, no swap needed
        assertTrue(hook.targetAvailable(0), "poke alone makes the target resolvable");
    }

    function test_twapIsBetweenObservedTicks() public {
        _toBlock(1);
        int24 before = _spotTick();
        _swap(alice, true, -0.2 ether); // a BUY consumes BITHOOK and LOWERS the tick
        int24 after_ = _spotTick();
        assertLt(after_, before, "buying BITHOOK lowers the tick");
        _toBlock(3);
        hook.poke();
        // the arithmetic-mean tick is bounded by its endpoints and the exact
        // same tick is used for scoring
        int24 twap = hook.targetTickRaw(0);
        assertLe(twap, before, "an average cannot exceed its endpoints");
        assertGe(twap, after_, "an average cannot exceed its endpoints");
        assertEq(hook.targetTick(0), twap, "scoring does not quantise the TWAP");
    }

    function test_targetUnavailableWithoutCheckpoints() public {
        // jump far past the checkpoint bound with no pokes and no swaps
        _toBlock(50);
        vm.expectRevert(BithookMiningHook.TargetUnavailable.selector);
        hook.targetTick(40);
    }

    // ============================================================
    // M-04: manipulation resistance — the load-bearing property
    // ============================================================

    function test_manipulatorCannotLandTwapOnOwnPrediction() public {
        _fund();
        _toBlock(B);
        int24 natural = _spotTick();

        // A buy lowers the tick, so the attacker commits well BELOW the resting
        // price, intending to shove the market down to their own number.
        int24 committed = natural - 8_000;
        _commit(attacker, committed, "atk");
        _commit(alice, natural, "honest"); // honest predicts the undisturbed price

        // During the TARGET block the attacker pushes hard -- but a TWAP is an
        // average, and they can only hold the push for the tail of the window.
        _toBlock(B + 1);
        vm.warp(hook.blockStart(B + 1) + (BLOCK_TIME * 9) / 10);
        _swap(attacker, true, -2 ether);
        assertLt(_spotTick(), natural - 5_000, "spot really did move a long way");

        _toBlock(B + 2);
        hook.poke();
        int24 realised = hook.targetTick(B);
        emit log_named_int("natural tick   ", natural);
        emit log_named_int("attacker commit", committed);
        emit log_named_int("realised TWAP  ", realised);
        emit log_named_uint("attacker error ", _absDiff(committed, realised));
        emit log_named_uint("honest error   ", _absDiff(natural, realised));

        // the average barely moved: the push occupied only the last 10%
        assertLt(
            _absDiff(natural, realised), _absDiff(committed, realised),
            "manipulating the TWAP ruins your own forecast"
        );

        _reveal(attacker, B, committed, "atk");
        _reveal(alice, B, natural, "honest");
        assertEq(_winnerOf(B), alice, "the honest predictor wins anyway");
    }

    // ============================================================
    // M-03: lifecycle
    // ============================================================

    function test_fullBlockLifecycle() public {
        _fund();
        int24 t = _spotTick();
        _toBlock(B);
        _commit(alice, t, "a");
        assertEq(_stakedOf(B), hook.stakeFor(B));

        _toBlock(B + 2);
        hook.poke();
        uint256 balBefore = token.balanceOf(alice);
        _reveal(alice, B, t, "a");
        uint256 st = hook.stakeFor(B);
        assertEq(token.balanceOf(alice), balBefore, "nothing comes back yet -- the stake is locked");
        assertEq(hook.lockedStake(alice, 0), st, "the full stake is locked, none burned");
        assertEq(_winnerOf(B), alice);

        _toBlock(B + 3);
        vm.prank(alice);
        hook.claimBlock(B);
        (uint128 vest,,,,) = hook.vestsOf(alice, 0);
        assertGt(uint256(vest), 0, "reward vests");
        assertEq(_rewardOf(B), uint256(vest));
    }

    function test_doubleCommitRejected() public {
        _toBlock(1);
        _commit(alice, 100, "a");
        vm.prank(alice);
        vm.expectRevert(BithookMiningHook.AlreadyCommitted.selector);
        hook.commit(_hash(100, "a", alice));
    }

    function test_revealOnlyInBlockNPlus2() public {
        _toBlock(1);
        _commit(alice, 100, "a");
        _toBlock(2);
        vm.prank(alice);
        vm.expectRevert(BithookMiningHook.RevealNotOpen.selector);
        hook.reveal(1, 100, "a");
        _toBlock(4);
        vm.prank(alice);
        vm.expectRevert(BithookMiningHook.RevealNotOpen.selector);
        hook.reveal(1, 100, "a");
    }

    function test_badRevealRejected() public {
        _toBlock(1);
        _commit(alice, 100, "a");
        _toBlock(3);
        hook.poke();
        vm.prank(alice);
        vm.expectRevert(BithookMiningHook.BadReveal.selector);
        hook.reveal(1, 101, "a");
        vm.prank(alice);
        vm.expectRevert(BithookMiningHook.BadReveal.selector);
        hook.reveal(1, 100, "wrong");
    }

    function test_commitmentIsAddressBound() public {
        _toBlock(1);
        _commit(alice, 100, "shared");
        _commit(bob, 999, "bobs");
        _toBlock(3);
        hook.poke();
        // bob knows alice's tick and salt but cannot use them
        vm.prank(bob);
        vm.expectRevert(BithookMiningHook.BadReveal.selector);
        hook.reveal(1, 100, "shared");
    }

    function test_doubleRevealRejected() public {
        _fund();
        int24 t = _spotTick();
        _toBlock(B);
        _commit(alice, t, "a");
        _toBlock(B + 2);
        hook.poke();
        _reveal(alice, B, t, "a");
        vm.prank(alice);
        vm.expectRevert(BithookMiningHook.AlreadyRevealed.selector);
        hook.reveal(B, t, "a");
    }

    function test_claimBeforeSettlementReverts() public {
        _fund();
        int24 t = _spotTick();
        _toBlock(B);
        _commit(alice, t, "a");
        _toBlock(B + 2);
        hook.poke();
        _reveal(alice, B, t, "a");
        vm.prank(alice);
        vm.expectRevert(BithookMiningHook.BlockNotSettled.selector);
        hook.claimBlock(B);
    }

    function test_nonWinnerCannotClaim() public {
        _fund();
        int24 t = _spotTick();
        _toBlock(B);
        _commit(alice, t, "a");
        _toBlock(B + 2);
        hook.poke();
        _reveal(alice, B, t, "a");
        _toBlock(B + 3);
        vm.prank(bob);
        vm.expectRevert(BithookMiningHook.NotWinner.selector);
        hook.claimBlock(B);
    }

    function test_doubleClaimRejected() public {
        _fund();
        int24 t = _spotTick();
        _playBlock(B, alice, t, "a");
        _toBlock(B + 3);
        vm.prank(alice);
        hook.claimBlock(B);
        vm.prank(alice);
        vm.expectRevert(BithookMiningHook.AlreadyClaimed.selector);
        hook.claimBlock(B);
    }

    function test_threeBlocksInFlight() public {
        _fund();
        int24 t = _spotTick();
        _toBlock(B);     _commit(alice, t, "b1");
        _toBlock(B + 1); _commit(alice, t, "b2");
        _toBlock(B + 2); _commit(alice, t, "b3");
        hook.poke();     _reveal(alice, B, t, "b1");
        _toBlock(B + 3); hook.poke(); _reveal(alice, B + 1, t, "b2");
        _toBlock(B + 4); hook.poke(); _reveal(alice, B + 2, t, "b3");
        assertEq(_winnerOf(B), alice);
        assertEq(_winnerOf(B + 1), alice);
        assertEq(_winnerOf(B + 2), alice);
    }

    // ============================================================
    // M-01: winner selection
    // ============================================================

    function test_closestTickWins() public {
        _fund();
        int24 t = _spotTick();
        _toBlock(B);
        _commit(alice, t + 500, "a");
        _commit(bob, t + 10, "b");     // much closer
        _commit(carol, t - 900, "c");
        _toBlock(B + 2);
        hook.poke();
        _reveal(alice, B, t + 500, "a");
        _reveal(bob, B, t + 10, "b");
        _reveal(carol, B, t - 900, "c");
        assertEq(_winnerOf(B), bob, "closest prediction wins");
    }

    function test_tieBrokenByAddressHashNotRevealOrder() public {
        _fund();
        int24 t = _spotTick();
        _toBlock(B);
        // symmetric straddle: both are exactly `d` from the target, so they tie
        // without having picked the same number
        _commit(alice, t + 100, "a");
        _commit(bob, t - 100, "b");
        _toBlock(B + 2);
        hook.poke();

        // reveal in one order, note the winner
        uint256 snap = vm.snapshotState();
        _reveal(alice, B, t + 100, "a");
        _reveal(bob, B, t - 100, "b");
        address winnerOrderA = _winnerOf(B);
        vm.revertToState(snap);

        // reveal in the opposite order -- the winner must not change
        _reveal(bob, B, t - 100, "b");
        _reveal(alice, B, t + 100, "a");
        assertEq(_winnerOf(B), winnerOrderA, "tie outcome is independent of reveal order");
    }


    function test_loneRevealerWinsRegardless() public {
        _fund();
        _toBlock(B);
        _commit(alice, 123_456, "a"); // wildly wrong
        _commit(bob, _spotTick(), "b");
        _toBlock(B + 2);
        hook.poke();
        _reveal(alice, B, 123_456, "a"); // bob never reveals
        assertEq(_winnerOf(B), alice, "closest among those who revealed");
    }

    function test_headcountSpamLosesToOneAccuratePredictor() public {
        _fund();
        int24 t = _spotTick();
        _toBlock(B);
        // 20 sybils blanket a wide range; one honest entry nails the price
        for (uint256 i = 0; i < 20; i++) {
            _commit(address(uint160(0x1000 + i)), int24(int256(t) + 2000 + int256(i) * 700), bytes32(i));
        }
        _commit(alice, t, "honest");
        _toBlock(B + 2);
        hook.poke();
        for (uint256 i = 0; i < 20; i++) {
            _reveal(address(uint160(0x1000 + i)), B, int24(int256(t) + 2000 + int256(i) * 700), bytes32(i));
        }
        _reveal(alice, B, t, "honest");
        assertEq(_winnerOf(B), alice, "one accurate entry beats 20 scattered ones");
    }

    // ============================================================
    // M-05: stake return and forfeiture
    // ============================================================

    function test_unrevealedStakeIsBurned() public {
        _fund();
        _toBlock(B);
        _commit(alice, _spotTick(), "a");
        _commit(bob, 555, "b"); // bob will never reveal
        uint256 staked = _stakedOf(B);
        assertEq(staked, 2 * hook.stakeFor(B));

        _toBlock(B + 2);
        hook.poke();
        _reveal(alice, B, _spotTick(), "a");

        _toBlock(B + 3);
        uint256 supplyBefore = token.totalSupply();
        hook.burnUnrevealed(B); // permissionless
        assertEq(token.totalSupply(), supplyBefore - hook.stakeFor(B), "exactly bob's stake burned");
        // a successful reveal burns nothing, so only the no-show is counted
        assertEq(hook.totalBurnedStakes(), hook.stakeFor(B));

        vm.expectRevert(BithookMiningHook.AlreadyBurned.selector);
        hook.burnUnrevealed(B);
    }

    function test_burnUnrevealedRevertsWhenAllRevealed() public {
        _fund();
        int24 t = _spotTick();
        _playBlock(B, alice, t, "a");
        _toBlock(B + 3);
        vm.expectRevert(BithookMiningHook.NothingToBurn.selector);
        hook.burnUnrevealed(B);
    }

    function test_nonRevealerHasNoRecoveryPath() public {
        _fund();
        _toBlock(B);
        _commit(bob, 555, "b");
        _toBlock(B + 3);
        // bob never revealed: he is not the winner and has nothing to claim
        vm.prank(bob);
        vm.expectRevert(BithookMiningHook.NotWinner.selector);
        hook.claimBlock(B);
    }

    // ============================================================
    // E-10: deterministic per-block emission
    // ============================================================

    /// E-10 (v5.7): emission is purely time-based. Trading does not gate it
    /// in either direction -- the volume gate was removed because it was a
    /// toll, not a demand signal (audit M-6).
    function test_emissionIsPurelyTimeBasedAndNeedsNoTrading() public {
        assertEq(hook.scheduleCap(0), 0, "nothing released at elapsed 0");

        vm.warp(hook.blockStart(6)); // one hour in, with no trades at all
        assertEq(
            hook.scheduleCap(block.timestamp - hook.miningStart()),
            hook.scheduleCap(6 * hook.BLOCK_TIME()),
            "the time-based schedule advanced on its own"
        );

        uint256 supply = token.totalSupply();
        _swap(alice, true, -0.05 ether);
        assertTrue(_emissionFinalizedOf(3), "the latest settled block was finalized");
        assertEq(token.totalSupply(), supply, "its empty reward was minted and burned");
        _swap(alice, false, -1_000e18);
        assertEq(token.totalSupply(), supply, "a second swap cannot finalize twice");
    }

    function test_releaseTracksTheScheduleExactly() public {
        vm.warp(hook.blockStart(0) + 7 days);
        assertApproxEqRel(hook.scheduleCap(7 days), 5_250_000e18, 0.001e18, "era 1 total");
        vm.warp(hook.blockStart(0) + 21 days);
        assertApproxEqRel(hook.scheduleCap(21 days), 7_875_000e18, 0.001e18, "through era 2");
        vm.warp(hook.blockStart(0) + 217 days);
        assertApproxEqRel(hook.scheduleCap(217 days), 10_171_875e18, 0.001e18, "through era 5");
    }

    function test_winnerAlwaysGetsExactlyScheduledRewardAfterLargeBacklog() public {
        // Build a large amount of released-but-unfinalized emission, then win
        // one block. None of the old backlog can enlarge this reward.
        vm.warp(hook.miningStart() + 2 days);
        uint256 n = hook.currentBlock();
        int24 t = _spotTick();
        _commit(alice, t, "a");
        _toBlock(n + 2);
        hook.poke();
        _reveal(alice, n, t, "a");
        _toBlock(n + 3);
        vm.prank(alice);
        hook.claimBlock(n);

        assertEq(_rewardOf(n), hook.scheduledBlockReward(n), "one block receives exactly R");
    }

    function test_fixedBlockRewardsTelescopeToScheduleCap() public view {
        uint256 sum;
        for (uint256 n = 0; n < 100; n++) {
            sum += hook.scheduledBlockReward(n);
        }
        assertEq(sum, hook.scheduleCap(100 * hook.BLOCK_TIME()));
    }

    function test_emptyBlockRewardIsMintedThenBurned() public {
        uint256 n = 10;
        _toBlock(n + 3);
        uint256 reward = hook.scheduledBlockReward(n);
        uint256 supply = token.totalSupply();
        uint256 hookBalance = token.balanceOf(address(hook));

        vm.expectEmit(true, true, false, true, address(token));
        emit Transfer(address(0), address(hook), reward);
        vm.expectEmit(true, true, false, true, address(token));
        emit Transfer(address(hook), address(0), reward);
        hook.finalizeBlock(n);

        assertTrue(_emissionFinalizedOf(n));
        assertEq(token.totalSupply(), supply, "mint then burn leaves supply unchanged");
        assertEq(token.balanceOf(address(hook)), hookBalance, "and leaves no reward balance");
    }

    function test_claimOrderCannotChangeBlockRewards() public {
        _fund();
        int24 t = _spotTick();

        _toBlock(B);
        _commit(alice, t, "a");
        _toBlock(B + 1);
        _commit(bob, t, "b");
        _toBlock(B + 2);
        hook.poke();
        _reveal(alice, B, t, "a");
        _toBlock(B + 3);
        hook.poke();
        _reveal(bob, B + 1, t, "b");
        _toBlock(B + 4);

        // Claim the later block first: both amounts remain their own R.
        vm.prank(bob);
        hook.claimBlock(B + 1);
        vm.prank(alice);
        hook.claimBlock(B);
        assertEq(_rewardOf(B), hook.scheduledBlockReward(B));
        assertEq(_rewardOf(B + 1), hook.scheduledBlockReward(B + 1));
    }

    function test_finalizeBlockRejectsTooEarlyAndDuplicateIsNoOp() public {
        uint256 n = 10;
        _toBlock(n + 2);
        vm.expectRevert(BithookMiningHook.BlockNotSettled.selector);
        hook.finalizeBlock(n);

        _toBlock(n + 3);
        hook.finalizeBlock(n);
        uint256 supply = token.totalSupply();
        hook.finalizeBlock(n);
        assertEq(token.totalSupply(), supply, "duplicate finalization did nothing");
    }

    function test_swapAutomaticallyFinalizesLatestEligibleBlock() public {
        _toBlock(10);
        uint256 supply = token.totalSupply();

        _swap(alice, true, -0.05 ether);

        assertTrue(_emissionFinalizedOf(7), "currentBlock - 3 finalized");
        assertFalse(_emissionFinalizedOf(8), "a newer reveal window is not settled");
        assertEq(token.totalSupply(), supply, "automatic empty burn is supply-neutral");
    }

    function test_swapAutomaticallyReservesWinningBlockReward() public {
        _fund();
        int24 t = _spotTick();
        _playBlock(B, alice, t, "winner");
        _toBlock(B + 3);

        _swap(bob, true, -0.05 ether);

        assertTrue(_emissionFinalizedOf(B));
        assertEq(_rewardOf(B), hook.scheduledBlockReward(B));

        vm.prank(alice);
        hook.claimBlock(B);
        (uint128 vest,,,,) = hook.vestsOf(alice, 0);
        assertEq(uint256(vest), hook.scheduledBlockReward(B));
    }

    function test_swapNoOpsWhenLatestBlockIsAlreadyFinalized() public {
        _toBlock(10);
        hook.finalizeBlock(7);
        uint256 supply = token.totalSupply();

        _swap(alice, true, -0.05 ether);

        assertEq(token.totalSupply(), supply, "nothing was finalized twice");
    }

    function test_swapBeforeBlockThreeHasNoFinalizationWork() public {
        assertEq(hook.currentBlock(), 0);
        _swap(alice, true, -0.05 ether);
        assertFalse(_emissionFinalizedOf(0), "early swap safely did nothing");
    }

    function test_zeroFeeSwapStillAutomaticallyFinalizes() public {
        _toBlock(10);
        uint256 ethFees = hook.pendingEth();
        uint256 tokenFees = hook.pendingToken();

        vm.prank(alice);
        swapRouter.swap{value: 1 ether}(
            key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: int256(1),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );

        assertEq(hook.pendingEth(), ethFees, "one token-wei output rounds the ETH fee to zero");
        assertEq(hook.pendingToken(), tokenFees);
        assertTrue(_emissionFinalizedOf(7), "finalization runs before the zero-fee return");
    }

    // ============================================================
    // F-01: flat fee & routing
    // ============================================================

    /// The anti-snipe decay is gone: a buy in the very first second gets
    /// exactly the same price as a buy a day later. The launch curve prices
    /// entry; being first is neither taxed nor discounted.
    function test_noSnipeFee_firstSecondCostsTheSameAsLater() public {
        assertEq(hook.FEE_BPS(), 100);

        uint256 snap = vm.snapshotState();
        uint256 b0 = token.balanceOf(alice);
        _swap(alice, true, -0.1 ether); // t == miningStart exactly
        uint256 atLaunch = token.balanceOf(alice) - b0;
        vm.revertToState(snap);

        vm.warp(block.timestamp + 1 days);
        b0 = token.balanceOf(alice);
        _swap(alice, true, -0.1 ether);
        uint256 later = token.balanceOf(alice) - b0;

        assertEq(atLaunch, later, "identical output at t=0 and t+1d: no snipe fee");
    }

    function test_buyFeeQueuesTokenForBurn() public {
        vm.warp(block.timestamp + 10);
        _swap(alice, true, -0.1 ether);
        assertGt(hook.pendingToken(), 0, "BITHOOK-side fee queued, not burned");
        assertEq(hook.pendingEth(), 0);
    }

    function test_sellFeeQueuesEthForBuybackAndBurn() public {
        vm.warp(block.timestamp + 10);
        // The single-sided production seed has no ETH bid at launch. An
        // ordinary buy first leaves ETH in the Manager for subsequent sells.
        _swap(bob, true, -0.2 ether);
        uint256 ownerBefore = owner.balance;
        _swap(alice, false, -1_000e18);
        assertGt(hook.pendingEth(), 0, "ETH-side fee queued for buyback and burn");
        assertEq(owner.balance, ownerBefore, "and never routed to the owner");
    }

    // ============================================================
    // V-01: vesting
    // ============================================================

    function _winVest() internal returns (uint256 total) {
        _fund();
        int24 t = _spotTick();
        _playBlock(B, alice, t, "a");
        _toBlock(B + 3);
        vm.prank(alice);
        hook.claimBlock(B);
        (uint128 v,,,,) = hook.vestsOf(alice, 0);
        return uint256(v);
    }

    function _ids(uint256 a) internal pure returns (uint256[] memory arr) {
        arr = new uint256[](1);
        arr[0] = a;
    }

    function test_rewardVestsNotMinted() public {
        _fund();
        int24 t = _spotTick();
        _playBlock(B, alice, t, "a");
        _toBlock(B + 3);
        uint256 supplyBefore = token.totalSupply(); // after the reveal burn
        vm.prank(alice);
        hook.claimBlock(B);
        (uint128 v,,,,) = hook.vestsOf(alice, 0);
        assertGt(uint256(v), 0);
        assertEq(token.totalSupply(), supplyBefore, "claiming mints nothing yet");
    }

    function test_unlockLinearHalfway() public {
        uint256 total = _winVest();
        vm.warp(block.timestamp + 7 days / 2);
        uint256 b = token.balanceOf(alice);
        vm.prank(alice);
        hook.unlockVested(_ids(0));
        assertApproxEqAbs(token.balanceOf(alice) - b, total / 2, 1);
    }

    function test_unlockFullAfterDuration() public {
        uint256 total = _winVest();
        vm.warp(block.timestamp + 7 days + 1);
        uint256 b = token.balanceOf(alice);
        vm.prank(alice);
        hook.unlockVested(_ids(0));
        assertEq(token.balanceOf(alice) - b, total);
        vm.prank(alice);
        vm.expectRevert(BithookMiningHook.NothingToUnlock.selector);
        hook.unlockVested(_ids(0));
    }

    function test_exitEarlySlashesHalf() public {
        uint256 total = _winVest();
        uint256 b = token.balanceOf(alice);
        vm.prank(alice);
        hook.exitEarly(_ids(0));
        uint256 got = token.balanceOf(alice) - b;
        assertApproxEqAbs(got, total / 2, 1);
        assertEq(got + hook.totalSlashed(), total, "minted + slashed == total");
    }

    receive() external payable {}
}
