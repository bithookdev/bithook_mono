// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BithookHarness} from "./Bithook.t.sol";
import {BithookMiningHook} from "../src/Bithook.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {console2} from "forge-std/console2.sol";

/// The v6.0 audit's findings, reproduced as executable PoCs.
///
/// The review was static — it states plainly that no compilation or fork
/// testing was performed — and closes by recommending seven specific tests.
/// These are those tests. Repo convention: an audit finding lands as a PoC
/// first and its assertion is inverted if and when it is fixed, so a
/// regression re-breaks it.
contract AuditV60Test is BithookHarness {
    using StateLibrary for IPoolManager;

    address whale = makeAddr("v60whale");

    function setUp() public override {
        super.setUp();
        vm.deal(whale, 100_000 ether);
        deal(address(token), whale, 5_000_000e18, false);
        vm.startPrank(whale);
        token.approve(address(swapRouter), type(uint256).max);
        token.approve(address(hook), type(uint256).max);
        vm.stopPrank();
    }

    function _swapRaw(address who, bool zeroForOne, int256 amt, uint256 val)
        internal
        returns (bool ok)
    {
        vm.prank(who);
        try swapRouter.swap{value: val}(
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
        ) { return true; } catch { return false; }
    }

    // ============================================================
    // L-01: fee = (absUnspecified * 100) / 10_000 floors to ZERO whenever
    //       the unspecified leg is under 100 wei.
    //
    // Reachability matters here and the shape is specific. On an exact-INPUT
    // buy the unspecified leg is the token OUTPUT, which is enormous at this
    // price — the fee never rounds down. The reachable shape is an
    // exact-OUTPUT buy, where the unspecified leg is the ETH input: ask for a
    // few token-wei and the ETH owed rounds to ~1 wei, so 1% of it is 0.
    // ============================================================
    function test_L01_dustExactOutputSwapsPayNoFee() public {
        vm.warp(block.timestamp + 30);
        _swapRaw(whale, true, -int256(uint256(1 ether)), 20 ether); // open the book

        uint256 ethFeeBefore = hook.pendingEth();
        uint256 tokFeeBefore = hook.pendingToken();

        // exact-output buy of a handful of token wei
        uint256 filled;
        for (uint256 i = 0; i < 25; i++) {
            if (_swapRaw(whale, true, int256(uint256(1_000)), 1 ether)) filled++;
        }

        uint256 ethFee = hook.pendingEth() - ethFeeBefore;
        uint256 tokFee = hook.pendingToken() - tokFeeBefore;
        console2.log("dust exact-output buys filled", filled);
        console2.log("ETH fee collected            ", ethFee);
        console2.log("token fee collected          ", tokFee);

        assertGt(filled, 0, "the dust swaps actually executed");
        assertEq(ethFee + tokFee, 0, "L-01 CONFIRMED: they paid no fee at all");
    }

    /// The same path at ordinary size does pay, so this is a rounding hole and
    /// not a missing fee path.
    function test_L01_normalExactOutputBuysDoPayTheFee() public {
        vm.warp(block.timestamp + 30);
        uint256 before = hook.pendingEth();
        assertTrue(_swapRaw(whale, true, int256(uint256(1_000e18)), 20 ether), "buy filled");
        assertGt(hook.pendingEth() - before, 0, "a normal exact-output buy pays an ETH fee");
    }

    /// The economically load-bearing question is not whether a sub-wei swap is
    /// free, but whether the price can be MOVED for free. Measure it.
    function test_L01_howFarCanAFeeFreeSwapMoveTheTick() public {
        vm.warp(block.timestamp + 30);
        _swapRaw(whale, true, -int256(uint256(1 ether)), 20 ether);

        int24 t0 = _spotTick();
        uint256 ethFee0 = hook.pendingEth();
        uint256 tokFee0 = hook.pendingToken();

        // 200 fee-free dust swaps, as fast as an attacker could send them
        for (uint256 i = 0; i < 200; i++) {
            _swapRaw(whale, true, int256(uint256(1_000)), 1 ether);
        }
        int24 t1 = _spotTick();
        uint256 feeTotal =
            (hook.pendingEth() - ethFee0) + (hook.pendingToken() - tokFee0);

        console2.log("tick before      ", int256(t0));
        console2.log("tick after       ", int256(t1));
        console2.log("ticks moved      ", int256(t0) - int256(t1));
        console2.log("fee paid for that", feeTotal);
        assertEq(feeTotal, 0, "still free");
    }

    /// The decisive case for L-01. A dust swap can only flip the integer tick
    /// if the price already sits adjacent to a boundary — which is exactly the
    /// state an attacker would engineer before nudging. Park it there with a
    /// price-limited swap, then try to cross for free.
    function test_L01_canADustSwapCrossATickBoundaryForFree() public {
        vm.warp(block.timestamp + 30);
        _swapRaw(whale, true, -int256(uint256(1 ether)), 20 ether);

        // Walk to an exact tick boundary using a price limit.
        int24 t = _spotTick();
        int24 boundary = (t / 200) * 200; // a multiple of tickSpacing, below t
        vm.prank(whale);
        swapRouter.swap{value: 50 ether}(
            key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(uint256(50 ether)),
                sqrtPriceLimitX96: TickMath.getSqrtPriceAtTick(boundary)
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        int24 parked = _spotTick();
        console2.log("parked tick    ", int256(parked));
        console2.log("target boundary", int256(boundary));

        uint256 ethFee0 = hook.pendingEth();
        uint256 tokFee0 = hook.pendingToken();

        // now try to cross with fee-free dust
        uint256 crossed;
        for (uint256 i = 0; i < 50; i++) {
            _swapRaw(whale, true, int256(uint256(1_000)), 1 ether);
            if (_spotTick() != parked) { crossed = i + 1; break; }
        }
        uint256 fee = (hook.pendingEth() - ethFee0) + (hook.pendingToken() - tokFee0);

        console2.log("tick after dust", int256(_spotTick()));
        console2.log("dust swaps to cross (0 = never)", crossed);
        console2.log("fee paid       ", fee);

        if (crossed > 0 && fee == 0) {
            emit log("L-01 IMPACT CONFIRMED: the oracle tick moved for zero fee");
        } else {
            emit log("L-01 impact NOT reproduced: dust cannot flip the tick here");
        }
    }

    // ============================================================
    // L-04: buybackAndBurn sizing. maxEthIn is clamped to pendingEth, so an
    //       oversized REQUEST is not itself a revert; the audit's concern is
    //       a partial fill against an exhausted book, which needs the price
    //       at the corridor floor (~4e22 ETH away under v6.0 geometry).
    // ============================================================
    function test_L04_buybackClampsToPendingAndKeepsClaimsOnRevert() public {
        vm.warp(block.timestamp + 30);
        _swapRaw(whale, true, -int256(uint256(2 ether)), 20 ether);
        _swapRaw(whale, false, -int256(token.balanceOf(whale) / 2), 0);

        uint256 pending = hook.pendingEth();
        assertGt(pending, 0, "sells left ETH fee claims");

        hook.buybackAndBurn(pending / 4);
        uint256 left = hook.pendingEth();
        assertLt(left, pending, "the sized chunk was spent");

        uint256 supplyBefore = token.totalSupply();
        hook.buybackAndBurn(left * 1000); // absurd request, clamped
        assertEq(hook.pendingEth(), 0, "clamped to pending rather than reverting");
        assertLt(token.totalSupply(), supplyBefore, "and burned what it bought");
    }

    // ============================================================
    // L-05: donations are unrecoverable -- the hook has no fee-collection
    //       path and every external liquidity call reverts.
    // ============================================================
    function test_L05_noFeeCollectionPathExists() public {
        vm.warp(block.timestamp + 30);
        _swapRaw(whale, true, -int256(uint256(1 ether)), 20 ether);

        uint256 hookBalBefore = token.balanceOf(address(hook));
        vm.prank(owner);
        vm.expectRevert(); // zero-delta "poke" to collect fees is frozen too
        lpRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: PRODUCTION_GRAD_TICK,
                tickUpper: PRODUCTION_START_TICK,
                liquidityDelta: 0,
                salt: 0
            }),
            ""
        );
        assertEq(token.balanceOf(address(hook)), hookBalBefore, "hook collected nothing");
    }

    // ============================================================
    // L-03 / G-01: >5.33h of total silence permanently orphans the skipped
    //              boundaries, but cannot brick a block that had a reveal.
    // ============================================================
    function test_L03_longIdleOrphansBoundariesButBricksNothing() public {
        vm.warp(block.timestamp + 30);
        _swapRaw(whale, true, -int256(uint256(1 ether)), 20 ether);

        uint256 n0 = hook.currentBlock();
        vm.warp(block.timestamp + 8 hours); // > 32 boundaries of silence

        uint256 g = gasleft();
        hook.poke();
        console2.log("catch-up poke gas", g - gasleft());

        assertFalse(hook.targetAvailable(n0 + 1), "L-03 CONFIRMED: orphaned for good");

        // Mining from here is unaffected. Only warp FORWARD -- _accumulate
        // underflows on a backward warp, which is a test hazard, not a
        // contract one (block.timestamp never decreases on chain).
        uint256 n = hook.currentBlock() + 1;
        vm.warp(hook.blockStart(n) + 5);
        int24 guess = _spotTick();
        _commit(whale, guess, "L03");

        vm.warp(hook.blockStart(n + 2) + 5);
        _reveal(whale, n, guess, "L03");

        vm.warp(hook.blockStart(n + 3) + 5);
        assertEq(_winnerOf(n), whale, "a fresh block still settles after the gap");
        vm.prank(whale);
        hook.claimBlock(n);
        assertGt(_rewardOf(n), 0, "and pays a real reward");
    }
}
