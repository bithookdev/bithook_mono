// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BithookHarness} from "./Bithook.t.sol";
import {BithookMiningHook} from "../src/Bithook.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {Position} from "@uniswap/v4-core/src/libraries/Position.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";

/// v5.9's two liquidity findings, kept in the shape that demonstrated them and
/// with their assertions inverted -- the convention this repo uses for the
/// audit PoCs. A regression re-breaks these first.
///
///   1. T-05 assumed the region outside the seed corridor was empty forever,
///      but the guard it used (getLiquidity() != 0) only asked whether the
///      CURRENT tick had liquidity behind it. A dust position parked in the
///      void before mining started made that true anywhere, permanently:
///      649,289 wei of ETH to install, 0.0001 BITHOOK to move the oracle 84,000
///      ticks, and the TWAP adopted it for a whole target window.
///
///   2. T-07 tested a `liquidityEverAdded` bool, set by any positive add and
///      never cleared. add -> remove left it true, so startMining() would arm
///      a pool holding nothing -- the exact unrecoverable brick T-07 exists to
///      prevent.
///
/// Both are closed by the same change: the hook installs its two band
/// positions itself (E-01), the guard is the corridor rather than active
/// liquidity (T-05), and startMining() validates both exact positions (T-07).
///
/// v6.0 note: seed() takes no arguments and is non-payable, so the old
/// wrong-corridor / wrong-liquidity / ETH-funding rejections became
/// impossible states rather than runtime checks. What is still reachable --
/// authorization, one-shot, full funding -- keeps its test.
///
/// setUp stops one step short of the launch: core and pool init are done,
/// nothing is seeded, mining is not started. Each test drives it from there.
contract PreStartLiquidityPoC is BithookHarness {
    using StateLibrary for IPoolManager;

    int24 startTick;

    function setUp() public override {
        _deployCore();
        startTick = PRODUCTION_START_TICK;

        vm.prank(owner);
        manager.initialize(key, TickMath.getSqrtPriceAtTick(startTick));
        vm.deal(owner, 100 ether);
    }

    /// The production seed: two single-sided BITHOOK bands, no ETH.
    function _seedAsInProduction() internal {
        vm.startPrank(owner);
        token.approve(address(hook), type(uint256).max);
        hook.seed();
        vm.stopPrank();
        deal(address(token), alice, 2_000e18, false);
        deal(address(token), attacker, 4_000e18, false);
        _fundActors();
    }

    /// The attacker's dust position in the void. A range entirely ABOVE the
    /// opening tick is pure currency0, so this needs no BITHOOK at all -- which is
    /// what made the original attack free.
    function _tryVoidPosition() internal returns (bool ok) {
        vm.prank(attacker);
        try lpRouter.modifyLiquidity{value: 1 ether}(
            key,
            ModifyLiquidityParams({
                tickLower: startTick + 200,
                tickUpper: 887_200,
                liquidityDelta: int256(uint256(1e9)),
                salt: 0
            }),
            ""
        ) {
            return true;
        } catch {
            return false;
        }
    }

    // ============================================================
    // 1. no third party can put liquidity in the void, ever
    // ============================================================

    function test_externalLiquidityIsRejectedBeforeSeeding() public {
        assertFalse(_tryVoidPosition(), "rejected on an empty pool");
    }

    function test_externalLiquidityIsRejectedBetweenSeedAndStart() public {
        _seedAsInProduction();
        assertFalse(_tryVoidPosition(), "rejected in the old M-2 window");
    }

    function test_externalLiquidityIsRejectedAfterStart() public {
        _seedAsInProduction();
        vm.prank(owner);
        hook.startMining();
        assertFalse(_tryVoidPosition(), "rejected once mining runs");
    }

    /// The whole attack, start to finish, now stopped at its first step.
    function test_T05_voidLpAttackIsClosed() public {
        _seedAsInProduction();
        assertFalse(_tryVoidPosition(), "the void cannot be seeded by anyone");

        vm.prank(owner);
        hook.startMining();
        vm.warp(block.timestamp + 30);

        // ...so the sell that used to park the oracle tens of thousands of
        // ticks up reverts, exactly as it does with only the seed in the pool.
        int24 before = _spotTick();
        vm.expectRevert(); // PriceOutsideCorridor, wrapped by the PoolManager
        _swap(attacker, false, -int256(uint256(1e14)));
        assertEq(_spotTick(), before, "the oracle never saw a fictitious price");
    }

    /// The two seed bands are the ONLY positions, and the hook owns both.
    function test_theSeedBandsAreTheOnlyPositionsAndTheHookOwnsThem() public {
        _seedAsInProduction();

        bytes32 curveKey = Position.calculatePositionKey(
            address(hook), hook.SEED_GRAD_TICK(), hook.SEED_START_TICK(), bytes32(0)
        );
        bytes32 tailKey = Position.calculatePositionKey(
            address(hook), hook.SEED_FLOOR_TICK(), hook.SEED_GRAD_TICK(), bytes32(0)
        );
        assertEq(
            IPoolManager(address(manager)).getPositionLiquidity(key.toId(), curveKey),
            hook.curveLiquidity(),
            "the recorded curve band is the position actually in the pool"
        );
        assertEq(
            IPoolManager(address(manager)).getPositionLiquidity(key.toId(), tailKey),
            hook.tailLiquidity(),
            "the recorded tail band is the position actually in the pool"
        );
        assertGt(hook.curveLiquidity(), 0);
        assertGt(hook.tailLiquidity(), 0);
        assertEq(hook.seedLower(), PRODUCTION_SEED_LOWER, "outer bottom = min usable tick");
        assertEq(hook.seedUpper(), startTick);
        uint256 pooled = token.balanceOf(address(manager));
        assertLe(token.INITIAL_SUPPLY() - pooled, hook.MAX_SEED_TOKEN_DUST());
    }

    function test_seedIsOneShot() public {
        _seedAsInProduction();
        vm.prank(owner);
        token.approve(address(hook), type(uint256).max);
        vm.prank(owner);
        vm.expectRevert(BithookMiningHook.AlreadySeeded.selector);
        hook.seed();
    }

    function test_onlyTheOwnerCanSeed() public {
        vm.prank(attacker);
        vm.expectRevert(BithookMiningHook.NotOwner.selector);
        hook.seed();
    }

    /// seed() pulls the full INITIAL_SUPPLY; an owner who no longer holds all
    /// of it cannot seed at all. (The amount is not a parameter any more.)
    function test_seedRequiresTheFullInitialAllocation() public {
        vm.startPrank(owner);
        token.transfer(alice, 1); // one wei short
        token.approve(address(hook), type(uint256).max);
        vm.expectRevert(); // solmate transferFrom balance underflow
        hook.seed();
        vm.stopPrank();
    }

    // ============================================================
    // 2. add -> remove no longer satisfies T-07
    // ============================================================

    function test_T07_addThenRemoveCannotArmAnEmptyPool() public {
        // the add that used to set liquidityEverAdded is refused outright
        assertFalse(_tryVoidPosition(), "no external add to remember");
        assertEq(hook.curveLiquidity(), 0, "and nothing was recorded as a seed");

        vm.prank(owner);
        vm.expectRevert(BithookMiningHook.PoolNotSeeded.selector);
        hook.startMining();
        assertEq(hook.miningStart(), 0, "mining did not start");
    }

    /// T-07 now validates the positions rather than a memory of them. No
    /// caller can make the seed vanish any more, so this reaches into the
    /// PoolManager's storage to prove the check is a real read and not a
    /// tautology: zero one band, and startMining() refuses even though
    /// seed() ran and recorded everything.
    function test_T07_readsTheLivePositionNotItsOwnBookkeeping() public {
        _seedAsInProduction();

        bytes32 positionKey = Position.calculatePositionKey(
            address(hook), hook.SEED_GRAD_TICK(), hook.SEED_START_TICK(), bytes32(0)
        );
        // StateLibrary._getPositionInfoSlot: pools[poolId].positions[positionId]
        bytes32 stateSlot =
            keccak256(abi.encodePacked(PoolId.unwrap(key.toId()), bytes32(uint256(6))));
        bytes32 slot =
            keccak256(abi.encodePacked(positionKey, bytes32(uint256(stateSlot) + 6)));

        assertGt(hook.curveLiquidity(), 0, "seed() recorded the curve band");
        vm.store(address(manager), slot, bytes32(0));
        assertEq(
            IPoolManager(address(manager)).getPositionLiquidity(key.toId(), positionKey),
            0,
            "the position really is gone from the pool"
        );

        vm.prank(owner);
        vm.expectRevert(BithookMiningHook.PoolNotSeeded.selector);
        hook.startMining();
    }

    // ============================================================
    // the brick T-07 exists to prevent
    // ============================================================

    function test_anUnseededPoolCannotTradeAtAll() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(); // PriceOutsideCorridor: seedSqrt* are still zero
        swapRouter.swap{value: 1 ether}(
            key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(uint256(0.1 ether)),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }
}
