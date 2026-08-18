// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {LaunchCurveTest} from "./LaunchCurve.t.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";

/// How far the launch curve reaches, and what happens at its ends (v6.0).
///
/// The curve band runs 164,600 -> 137,800 (a 14.58x rise, pump.fun's
/// start-to-graduation multiple) and the tail band continues to the minimum
/// usable tick, so THERE IS NO PRICE CEILING: the pre-v6.0 corridor floor at
/// tick 36,400 (~$1.65B FDV) used to hard-revert every further buy after
/// 1,127 ETH of buying; reaching the v6.0 floor would cost ~4e22 ETH, more
/// ETH than will ever exist. Only two boundary behaviours remain, both
/// deliberate: the void ABOVE the open (T-05) and the zero-ETH launch state
/// in which there is no bid yet.
contract CorridorReachTest is LaunchCurveTest {
    using StateLibrary for IPoolManager;

    /// pre-v6.0 hard ceiling: tick 36,400 <=> ~$1.65B FDV in ANY geometry
    /// (the FDV of a tick does not depend on where the pool opened)
    int24 constant OLD_CEILING_TICK = 36_400;

    /// the inherited _swap caps msg.value at 20 ETH; these buys are larger
    function _bigBuy(address who, uint256 ethIn) internal {
        vm.deal(who, ethIn + 1 ether);
        vm.prank(who);
        // casting to 'int256' is safe: test amounts are far below 2^255
        // forge-lint: disable-next-line(unsafe-typecast)
        swapRouter.swap{value: ethIn}(
            key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(ethIn),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    /// exact-output buy of `tokensOut`, returning the ETH actually spent
    /// (including the 1% hook fee, which lands on the ETH side here)
    function _buyExact(address who, uint256 tokensOut) internal returns (uint256 spent) {
        vm.deal(who, 100_000 ether);
        uint256 e0 = who.balance;
        vm.prank(who);
        swapRouter.swap{value: 50_000 ether}(
            key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: int256(tokensOut),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        return e0 - who.balance;
    }

    function _assertApprox(uint256 actual, uint256 expected, uint256 tolBps, string memory why)
        internal
        pure
    {
        assertLe(actual, expected * (10_000 + tolBps) / 10_000, why);
        assertGe(actual, expected * (10_000 - tolBps) / 10_000, why);
    }

    // ============================================================
    // The headline: there is no price ceiling any more
    // ============================================================

    /// Pre-v6.0 this exact 1,200 ETH buy REVERTED on PriceOutsideCorridor:
    /// the whole seed cost 1,127 ETH and then the book simply ended. Now it
    /// fills, carries the price past the old ceiling, and the next buy still
    /// fills too.
    function test_theOldHardCeilingIsGone() public {
        vm.warp(block.timestamp + 30);

        _bigBuy(attacker, 1_200 ether);
        int24 t = _spotTick();
        assertLt(t, OLD_CEILING_TICK, "the price ran past the old $1.65B ceiling");
        assertGt(t, seedLower, "and is still on real liquidity");

        // at the old ceiling the NEXT buy was the one that reverted; now:
        _bigBuy(attacker, 100 ether);
        assertLt(_spotTick(), t, "buying continues to move the price up");
    }

    /// Buys and sells interleaved from the open, across graduation, past the
    /// old ceiling and back down: no trade reverts at any reachable price,
    /// and the oracle follows the whole way.
    function test_buySellGauntletNeverReverts() public {
        vm.warp(block.timestamp + 30);

        _bigBuy(attacker, 3 ether); // through the whole curve band
        assertLt(_spotTick(), PRODUCTION_GRAD_TICK, "graduated into the tail");

        _swap(attacker, false, -int256(token.balanceOf(attacker) / 3)); // sell a third
        int24 afterSell = _spotTick();
        assertGt(afterSell, TickMath.MIN_TICK, "sell landed on a real price");

        _bigBuy(attacker, 1_500 ether); // deep into the tail
        assertLt(_spotTick(), OLD_CEILING_TICK, "deep past the old ceiling");

        _swap(attacker, false, -int256(token.balanceOf(attacker) / 2)); // sell back hard
        _bigBuy(bob, 50 ether); // someone else keeps buying
        _swap(bob, false, -int256(token.balanceOf(bob) / 4));

        // the TWAP tracked all of it: the oracle's live tick is the pool's
        assertEq(hook.lastTick(), _spotTick(), "oracle followed to the end");
    }

    /// $170k / $900k / $4.5M of buying (at $3k/ETH) all land on real
    /// liquidity, far from both ends of the seed.
    function test_realisticValuationsAreAllOnTheCurve() public {
        vm.warp(block.timestamp + 30);
        _bigBuy(attacker, 2 ether);
        int24 t = _spotTick();
        assertLt(t, startTick, "price rose from the opening");
        assertGt(t, seedLower, "nowhere near the bottom of the tail");

        _bigBuy(attacker, 300 ether);
        t = _spotTick();
        assertGt(t, seedLower, "still on real liquidity after 302 ETH");
    }

    // ============================================================
    // The curve itself: pump.fun's numbers, on-chain
    // ============================================================

    /// The declared price list, as first-buyer exact-output costs (1% hook
    /// fee included -- on an exact-output buy it lands on the ETH side).
    /// Closed-form: cost(n) = N*p_open*((1/x - 1)/r), x = 1 - (n/N)*r,
    /// r = 1 - 1/sqrt(14.583), N = 8.4M, p_open = 1.4931 ETH / 21M.
    function test_curvePriceTable() public {
        vm.warp(block.timestamp + 30);
        uint256[4] memory tokensOut =
            [uint256(1_000_000e18), 2_000_000e18, 5_000_000e18, 8_400_000e18];
        // fee-inclusive expectations, wei (see plan/README table)
        uint256[4] memory expected =
            [uint256(0.0787 ether), 0.1743 ether, 0.6403 ether, 2.3029 ether];

        for (uint256 i = 0; i < 4; i++) {
            uint256 snap = vm.snapshotState();
            uint256 spent = _buyExact(alice, tokensOut[i]);
            _assertApprox(spent, expected[i], 200, "cost within 2% of the declared table");
            vm.revertToState(snap);
        }
    }

    /// Buying out the whole curve band lands the price at graduation, a
    /// 14.58x rise over the open -- pump.fun's start-to-graduation multiple
    /// (~$65k FDV at $3k/ETH, their ~$69k).
    function test_graduationLandsOnPumpFunsMultiple() public {
        vm.warp(block.timestamp + 30);
        _buyExact(alice, 8_400_000e18);
        int24 t = _spotTick();
        // one tick of slack: the buy dips into the tail by the band's dust
        assertLe(t, PRODUCTION_GRAD_TICK, "reached graduation");
        assertGe(t, PRODUCTION_GRAD_TICK - 2, "and stopped right there");
    }

    /// Crossing the graduation boundary is seamless -- one swap fills across
    /// both bands -- and the density step at the boundary is pump.fun's ~1.4x
    /// (their curve's virtual depth vs the migrated AMM's real depth).
    function test_graduationCrossingIsSeamlessWithPumpFunsDensityStep() public {
        vm.warp(block.timestamp + 30);

        // the recorded bands themselves carry the step
        uint256 stepMilli =
            (uint256(hook.curveLiquidity()) * 1_000) / uint256(hook.tailLiquidity());
        assertGt(stepMilli, 1_380, "density step above 1.38x");
        assertLt(stepMilli, 1_460, "and below 1.46x -- pump.fun's ~1.4x");

        // one swap that must cross the boundary: the curve holds 8.4M, ask
        // for 8.5M in a single fill
        uint256 got0 = token.balanceOf(alice);
        _buyExact(alice, 8_500_000e18);
        assertEq(token.balanceOf(alice) - got0, 8_500_000e18, "filled across the boundary");
        assertLt(_spotTick(), PRODUCTION_GRAD_TICK, "and the price is in the tail");

        // active liquidity in the tail is the tail band's
        assertEq(
            IPoolManager(address(manager)).getLiquidity(key.toId()),
            hook.tailLiquidity(),
            "tail liquidity is live past graduation"
        );
    }

    /// Our curve band IS pump.fun's bonding curve: a constant-product AMM
    /// with virtual reserves (x0 = 30 virtual SOL, y0 = 1,073,000,191 virtual
    /// tokens, k = x0*y0) is mathematically a uniform concentrated position.
    /// Their sellable fraction lambda = 793.1M/y0 = 0.7391 equals our
    /// r = 1 - 1/sqrt(multiple) = 0.7381 (identical if the multiple were
    /// exactly (y0/(y0-793.1M))^2 = 14.70; tick snapping gives 14.58).
    /// Normalized cost curves must therefore match within ~1%.
    function test_curveShapeMatchesPumpFunsFormula() public {
        vm.warp(block.timestamp + 30);

        // pump.fun: cost(f) = k/(y0 - f*sold) - x0, in their SOL units
        uint256 y0 = 1_073_000_191;
        uint256 x0 = 30;
        uint256 sold = 793_100_000;
        uint256 kk = x0 * y0;

        uint256[4] memory fBps = [uint256(1_000), 3_000, 5_000, 7_500]; // f of the curve
        uint256 REF_BPS = 9_500; // normalize at 95% to stay inside the band

        // their normalized costs, in 1e18 fixed point
        uint256 refTheir = (kk * 1e18) / (y0 - (REF_BPS * sold) / 10_000) - x0 * 1e18;
        // ours, measured with real swaps
        uint256 refOurs;
        {
            uint256 snap = vm.snapshotState();
            refOurs = _buyExact(alice, (8_400_000e18 * REF_BPS) / 10_000);
            vm.revertToState(snap);
        }

        for (uint256 i = 0; i < 4; i++) {
            uint256 their = (kk * 1e18) / (y0 - (fBps[i] * sold) / 10_000) - x0 * 1e18;
            uint256 theirRatioBps = (their * 10_000) / refTheir;

            uint256 snap = vm.snapshotState();
            uint256 ours = _buyExact(alice, (8_400_000e18 * fBps[i]) / 10_000);
            vm.revertToState(snap);
            uint256 oursRatioBps = (ours * 10_000) / refOurs;

            // within 1% of each other at every checkpoint
            _assertApprox(oursRatioBps, theirRatioBps, 100, "normalized cost matches pump.fun");
        }
    }

    // ============================================================
    // Seed accounting
    // ============================================================

    /// Two floor-rounded band conversions leave dust strictly under one
    /// granularity each (2,768 + 982 token-wei); the constant must cover it.
    function test_seedDustIsWithinTheDeclaredBound() public view {
        uint256 pooled = token.balanceOf(address(manager));
        uint256 dust = token.INITIAL_SUPPLY() - pooled;
        assertLt(dust, 2_768 + 982, "dust under one granularity per band");
        assertLe(dust, hook.MAX_SEED_TOKEN_DUST(), "and inside the enforced bound");
    }

    // ============================================================
    // The boundaries that remain, both deliberate
    // ============================================================

    /// The pool opens with zero active liquidity (price sits exactly on the
    /// curve band's upper bound), so it is worth knowing the first buy needs
    /// no minimum size to get the market going.
    function test_theFirstBuyCanBeOneWei() public {
        vm.warp(block.timestamp + 30);
        _swap(alice, true, -int256(uint256(1)));
        assertEq(_spotTick(), startTick - 1, "one wei is enough to open the book");
    }

    // NOTE the pre-v6.0 suite pinned a buy stopping EXACTLY on the corridor
    // floor (tick 36,400) -- the boundary case that motivated T-05's
    // inclusive sqrt-price comparison. The v6.0 floor is ~4e22 ETH away and a
    // single swap cannot even carry that input (it exceeds int128), so the
    // state is untestable at production geometry. The comparison logic is
    // unchanged and still guards the reachable upper bound, which
    // LaunchCurve.t.sol::test_openingPriceIsAFloor pins.
}
