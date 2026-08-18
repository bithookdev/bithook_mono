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
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

/// The pump.fun launch shape (v6.0): the pool opens at a DECLARED valuation
/// — ~1.49 ETH FDV, pump.fun's ~$4.5k start — with two single-sided BITHOOK
/// bands and zero ETH: a bonding-curve band rising 14.58x to the graduation
/// tick, then an unbounded tail reaching the minimum usable tick.
///
/// The point of these tests is that the opening valuation is a price, not
/// capital. A two-sided full-range seed pins the opening FDV to 2x the ETH
/// deposited; declaring the price makes early supply cost exactly what the
/// declared curve says — pump.fun-cheap here, BY CHOICE — while the deployer
/// posts nothing.
///
/// The shared production constants and seed helper keep these tests on the
/// same exact curve enforced by the hook and used by Deploy.s.sol.
contract LaunchCurveTest is BithookHarness {
    using StateLibrary for IPoolManager;

    /// ~1.49 ETH FDV ~= $4.5k at $3,000/ETH -- pump.fun's opening market cap
    int24 startTick;
    int24 seedLower;

    function setUp() public override {
        super.setUp();
        startTick = PRODUCTION_START_TICK;
        seedLower = PRODUCTION_SEED_LOWER;
    }

    // ============================================================
    // The seed costs no ETH
    // ============================================================
    function test_poolOpensWithZeroEth() public view {
        assertEq(address(manager).balance, 0, "the pool holds no ETH at launch");
        assertGt(token.balanceOf(address(manager)), 10_000_000e18, "but holds the whole seed");
    }

    function test_openingTickMatchesTheDeclaredValuation() public view {
        assertEq(startTick, 164_600, "pump.fun's ~$4.5k start, snapped to spacing 200");
        assertEq(startTick % 200, 0, "aligned, so the seed is exactly single-sided");
        (, int24 tick,,) = IPoolManager(address(manager)).getSlot0(key.toId());
        assertEq(tick, startTick, "pool opened exactly on the boundary");
    }

    // ============================================================
    // The declared curve prices the early supply: pump.fun-cheap
    // ============================================================
    /// On pump.fun ~18 SOL takes ~40% of supply off a fresh curve; 1 ETH
    /// lands the same ballpark here. This is a PRICE choice — the v5.2 $27k
    /// open handed ~9% for the same 1 ETH — and v6.0 deliberately reverses
    /// it: only the earliest buyers eat cheap, and the 14.58x curve plus the
    /// unbounded tail make everyone after them pay up.
    function test_oneEthBuysThePumpFunShare() public {
        vm.warp(block.timestamp + 30); // advance the clock
        uint256 b0 = token.balanceOf(alice);
        _swap(alice, true, -int256(uint256(1 ether)));
        uint256 got = token.balanceOf(alice) - b0;

        uint256 bps = (got * 10_000) / 21_000_000e18;
        // measured at v6.0 geometry: 2,965 bps of the 21M cap (~59% of seed)
        assertLt(bps, 3_100, "1 ETH takes under 31% of the 21M cap");
        assertGt(bps, 2_800, "and over 28% -- the declared pump.fun share");
    }

    function test_buyingIsMonotonicallyMoreExpensivePerToken() public {
        vm.warp(block.timestamp + 30);
        uint256 snap = vm.snapshotState();
        uint256 b0 = token.balanceOf(alice);
        _swap(alice, true, -int256(uint256(1 ether)));
        uint256 first = token.balanceOf(alice) - b0;
        vm.revertToState(snap);

        b0 = token.balanceOf(alice);
        _swap(alice, true, -int256(uint256(2 ether)));
        uint256 both = token.balanceOf(alice) - b0;

        assertLt(both, first * 2, "the second ETH buys strictly fewer tokens than the first");
    }

    // ============================================================
    // Single-sided consequences, pinned deliberately
    // ============================================================
    function test_thereIsNoBidUntilSomeoneBuys() public {
        vm.warp(block.timestamp + 30);
        // alice holds BITHOOK from setUp but the pool has no ETH to pay her
        vm.expectRevert();
        _swap(alice, false, -int256(uint256(1_000e18)));
    }

    /// T-05. Above the seed range there is no liquidity, and Uniswap will let
    /// a swap traverse an empty region for FREE -- zero in, zero out. Before
    /// the guard this moved the pool tick from the open to 887,271 at no cost,
    /// handing a manipulator the TWAP with no capital and no holding time.
    function test_T05_cannotMoveThePriceIntoTheVoidForFree() public {
        vm.warp(block.timestamp + 30);
        int24 before = _spotTick();
        // she can well afford the sell -- it is the empty book that stops it,
        // not her balance
        assertGe(token.balanceOf(alice), 2_000e18);

        vm.expectRevert(); // PriceOutsideCorridor, wrapped by the PoolManager
        _swap(alice, false, -int256(uint256(2_000e18)));

        assertEq(_spotTick(), before, "the oracle never saw a fictitious price");
    }

    function test_normalSellingStillWorks() public {
        vm.warp(block.timestamp + 30);
        _swap(bob, true, -int256(uint256(1 ether)));
        uint256 e0 = bob.balance;
        _swap(bob, false, -int256(token.balanceOf(bob) / 2));
        assertGt(bob.balance, e0, "a seller with a real book is unaffected");

        // one buy converts part of the position to ETH and the bid exists
        _swap(bob, true, -int256(uint256(1 ether)));
        _swap(alice, false, -int256(uint256(1_000e18)));
        assertGt(alice.balance, 0);
    }

    function test_openingPriceIsAFloor() public {
        vm.warp(block.timestamp + 30);
        _swap(bob, true, -int256(uint256(1 ether)));
        // sell everything back: price cannot fall below where the range starts
        uint256 bal = token.balanceOf(bob);
        _swap(bob, false, -int256(bal));
        (, int24 tick,,) = IPoolManager(address(manager)).getSlot0(key.toId());
        assertLe(tick, startTick, "cannot trade above the opening valuation's tick");
    }

    // ============================================================
    // The mechanism is unaffected by the seed's shape
    // ============================================================
    function test_miningWorksOnASingleSidedPool() public {
        vm.warp(block.timestamp + 30);
        _swap(alice, true, -int256(uint256(0.5 ether))); // accrue emission
        _toBlock(4);

        int24 guess = _spotTick();
        _commit(alice, guess, "a");
        _commit(bob, guess + 5_000, "b");

        _toBlock(6); // block 4 committed, 5 was the target, 6 is reveal
        _reveal(alice, 4, guess, "a");
        _reveal(bob, 4, guess + 5_000, "b");

        _toBlock(7);
        assertEq(_winnerOf(4), alice, "closest prediction wins, same as always");
        vm.prank(alice);
        hook.claimBlock(4);
        assertGt(_rewardOf(4), 0, "a real reward was paid");
    }

    function test_feesAccrueOnBothSidesAndCanBeBurned() public {
        vm.warp(block.timestamp + 30);
        _swap(alice, true, -int256(uint256(1 ether)));
        _swap(alice, false, -int256(token.balanceOf(alice) / 4));
        assertGt(hook.pendingEth(), 0);
        assertGt(hook.pendingToken(), 0);

        uint256 supply = token.totalSupply();
        hook.burnFees();
        assertLt(token.totalSupply(), supply, "the BITHOOK side is destroyed");
        assertGt(hook.totalFeeBurned(), 0);

        supply = token.totalSupply();
        hook.buybackAndBurn(0);
        assertEq(hook.pendingEth(), 0, "the ETH side was spent buying");
        assertGt(hook.totalBuybackBurned(), 0);
        assertLt(token.totalSupply(), supply, "and what it bought was destroyed too");
    }

    function test_seedIsStillPermanentlySealed() public {
        // target a REAL band (the curve band), not just any range
        vm.prank(owner);
        vm.expectRevert();
        lpRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: PRODUCTION_GRAD_TICK,
                tickUpper: startTick,
                liquidityDelta: -int256(1e18),
                salt: 0
            }),
            ""
        );
    }
}
