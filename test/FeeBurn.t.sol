// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BithookHarness} from "./Bithook.t.sol";
import {BithookMiningHook} from "../src/Bithook.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

/// F-01 (v5.6): 100% of the fee is DESTROYED, not compounded. The BITHOOK side
/// is burned outright; the ETH side buys BITHOOK on the pool and burns that.
/// Both are permissionless and nobody receives anything.
contract FeeBurnTest is BithookHarness {
    using StateLibrary for IPoolManager;

    /// This helper's exact-input buy pays in BITHOOK; its exact-input sell pays in ETH.
    function _twoWayFlow() internal {
        vm.warp(block.timestamp + 10);
        _swap(alice, true, -0.2 ether);
        _swap(alice, false, -int256(token.balanceOf(alice) / 4));
    }

    // ============================================================
    // The burns are real
    // ============================================================
    function test_burnFeesDestroysTheBithookSide() public {
        _twoWayFlow();
        uint256 pending = hook.pendingToken();
        assertGt(pending, 0);
        // F-5: the pending fee is an ERC-6909 claim on the manager, not a
        // balance the hook holds; pendingToken mirrors it exactly.
        uint256 id = uint256(uint160(address(token)));
        assertEq(manager.balanceOf(address(hook), id), pending, "pendingToken is a 6909 claim");

        uint256 supply = token.totalSupply();
        hook.burnFees(); // permissionless

        assertEq(token.totalSupply(), supply - pending, "exactly the fee was destroyed");
        assertEq(hook.pendingToken(), 0);
        assertEq(manager.balanceOf(address(hook), id), 0, "the claim was consumed");
        assertEq(hook.totalFeeBurned(), pending);
    }

    function test_buybackSpendsEthAndBurnsWhatItBought() public {
        _twoWayFlow();
        uint256 eth = hook.pendingEth();
        assertGt(eth, 0);

        uint256 supply = token.totalSupply();
        uint256 managerEth = address(manager).balance;
        // F-5: the ETH side is held as an ERC-6909 claim on the manager, not as
        // ETH in the hook. pendingEth is the mirror of that claim.
        assertEq(manager.balanceOf(address(hook), 0), eth, "pendingEth is a 6909 claim");
        assertEq(address(hook).balance, 0, "the hook custodies no ETH");

        hook.buybackAndBurn(0); // permissionless, zero means uncapped

        assertEq(hook.pendingEth(), 0, "the whole ETH side was spent");
        assertGt(hook.totalBuybackBurned(), 0, "and it bought something");
        assertEq(
            token.totalSupply(), supply - hook.totalBuybackBurned(), "which was destroyed"
        );
        // The ETH was already inside the manager, so buying with the claim
        // moves nothing across its boundary -- it only converts an
        // outstanding claim into pool liquidity. Old scheme: hook held the
        // ETH and paid it back in, so this balance grew by `eth`.
        assertEq(manager.balanceOf(address(hook), 0), 0, "the claim was burned to pay for it");
        assertEq(address(manager).balance, managerEth, "and no ETH crossed the manager");
    }

    function test_cappedBuybackSpendsOnlyTheSelectedChunkThenUncappedDrainsTheRest() public {
        _twoWayFlow();
        uint256 pendingBefore = hook.pendingEth();
        uint256 cap = pendingBefore / 2;
        assertGt(cap, 0, "fixture has a meaningful partial chunk");

        uint256 supplyBefore = token.totalSupply();
        uint256 burnedBefore = hook.totalBuybackBurned();
        hook.buybackAndBurn(cap);

        uint256 burnedFirst = hook.totalBuybackBurned() - burnedBefore;
        assertEq(hook.pendingEth(), pendingBefore - cap, "unselected claim stays pending");
        assertEq(
            manager.balanceOf(address(hook), 0),
            pendingBefore - cap,
            "the residual claim stays fully backed"
        );
        assertGt(burnedFirst, 0, "the capped chunk bought tokens");
        assertEq(token.totalSupply(), supplyBefore - burnedFirst, "the first chunk was burned");

        uint256 residual = hook.pendingEth();
        hook.buybackAndBurn(0); // zero is the ordinary uncapped/full-drain path
        assertEq(hook.pendingEth(), 0, "uncapped follow-up drained the residual");
        assertEq(manager.balanceOf(address(hook), 0), 0, "all ETH claims were consumed");
        assertEq(pendingBefore - cap, residual, "only the selected first chunk was spent");
    }

    function test_capAbovePendingEthStillPerformsAFullBuyback() public {
        _twoWayFlow();
        uint256 pending = hook.pendingEth();
        hook.buybackAndBurn(pending + 1);
        assertEq(hook.pendingEth(), 0, "a cap above the balance is effectively uncapped");
        assertGt(hook.totalBuybackBurned(), 0);
    }

    function test_bothAreCallableByAnyone() public {
        _twoWayFlow();
        vm.prank(attacker);
        hook.burnFees();
        vm.prank(attacker);
        hook.buybackAndBurn(0);
        assertGt(hook.totalFeeBurned(), 0);
        assertGt(hook.totalBuybackBurned(), 0);
    }

    function test_bothRevertWithNothingPending() public {
        vm.expectRevert(BithookMiningHook.NothingToBurn.selector);
        hook.burnFees();
        vm.expectRevert(BithookMiningHook.NothingToBuyBack.selector);
        hook.buybackAndBurn(0);
    }

    // ============================================================
    // Solvency: burning must never reach stake collateral
    // ============================================================
    function test_burningNeverTouchesStakeCollateral() public {
        _twoWayFlow();

        _toBlock(2);
        _commit(alice, 100, "a");
        _commit(bob, 200, "b");
        uint256 stakeFloat = _stakedOf(2);
        assertGt(stakeFloat, 0);

        hook.burnFees();

        // every open stake is still fully backed
        assertGe(token.balanceOf(address(hook)), stakeFloat, "stake float intact");

        // and still redeemable in full, through the lock
        _toBlock(4);
        _reveal(alice, 2, 100, "a");
        assertEq(hook.lockedStake(alice, 0), hook.stakeFor(2), "locked, not burned");
        vm.warp(hook.stakeUnlockTime(0));
        uint256 before = token.balanceOf(alice);
        vm.prank(alice);
        hook.unlockStakes(0);
        assertEq(token.balanceOf(alice), before + hook.stakeFor(2), "paid in full");
    }

    function test_solvencyHoldsAcrossAFullCycleWithBothBurns() public {
        uint256 id = uint256(uint160(address(token)));
        _twoWayFlow();
        _toBlock(2);
        _commit(alice, 100, "a");

        // F-5 made the two custodies separate asset classes: fee BITHOOK is a
        // 6909 claim on the manager, stake collateral is physical BITHOOK in
        // the hook. Each side must be fully covered on its own.
        assertEq(manager.balanceOf(address(hook), id), hook.pendingToken(), "claims cover fees");
        assertGe(token.balanceOf(address(hook)), _stakedOf(2), "balance covers stakes");

        hook.burnFees();
        hook.buybackAndBurn(0);
        _toBlock(4);
        _reveal(alice, 2, 100, "a");
        _twoWayFlow();
        hook.burnFees();

        assertEq(manager.balanceOf(address(hook), id), hook.pendingToken(), "never over-committed");
        assertGe(token.balanceOf(address(hook)), hook.totalLockedStakes(), "stake float intact");
    }

    // ============================================================
    // The buyback must not become an emission crank or an oracle hole
    // ============================================================

    /// v4's Hooks.afterSwap short-circuits when msg.sender is the hook itself,
    /// so the buyback pays no recursive fee on its own swap. Without that the
    /// burn would feed itself: every buyback would mint new pendingToken.
    function test_buybackDoesNotPayItselfAFee() public {
        _twoWayFlow();
        _toBlock(6);

        uint256 pendingTokenBefore = hook.pendingToken();
        hook.buybackAndBurn(0);
        assertEq(hook.pendingToken(), pendingTokenBefore, "it pays no fee to itself");
    }

    /// The same short-circuit means _accumulate() is not called for us, so
    /// buybackAndBurn(maxEthIn) has to advance the oracle itself -- otherwise a real
    /// price move would be invisible to the TWAP, which is the T-02 class of
    /// hole all over again.
    function test_buybackAdvancesTheOracleItself() public {
        _twoWayFlow();
        _toBlock(6);

        int24 before = _spotTick();
        hook.buybackAndBurn(0);
        int24 after_ = _spotTick();
        assertLt(after_, before, "buying moved the tick");

        // the hook's own view of the price tracks it, with no external swap
        assertEq(hook.lastTick(), after_, "oracle adopted the post-buyback tick");
    }
}
