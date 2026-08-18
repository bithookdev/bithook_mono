// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BithookHarness} from "./Bithook.t.sol";
import {BithookMiningHook} from "../src/Bithook.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";

/// Findings from the v5.8 review. Written in the house style: where we fixed
/// something the assertion is inverted into a regression, and where we accepted
/// something the test MEASURES it so the number cannot drift unnoticed.
contract AuditV58Test is BithookHarness {
    using StateLibrary for IPoolManager;

    // ============================================================
    // M-1 / T-06 — the lattice was removed in v5.9
    //
    // The lattice created coarse price buckets and systematic ties. Exact-tick
    // scoring deliberately restores the v5.4 silent-window behavior: if no
    // price-changing swap lands in the target window, its last tick is public
    // and the reward is freely mineable. No volume means no price discovery.
    // ============================================================
    /// In a silent window the
    /// answer is publicly computable from the last swap of the commit block, so
    /// anyone can commit the exact tick for nothing. Honest early forecasting
    /// is dominated by last-second copy-the-tick bots. Accepted by design --
    /// this test exists so the property is visible rather than folklore.
    function test_M1_inASilentWindowTheAnswerIsPubliclyKnowableForFree() public {
        _fund();
        _toBlock(B);
        _swap(alice, true, -0.05 ether); // the last swap of the commit block

        // anyone reading the chain now knows the target exactly
        int24 predicted = _spotTick();
        _commit(carol, predicted, "copycat"); // no position, no fee

        _toBlock(B + 2); // block B+1 passes in silence
        hook.poke();

        assertEq(hook.targetTick(B), predicted, "the copycat's free guess is exact");
        _reveal(carol, B, predicted, "copycat");
        assertEq(_winnerOf(B), carol, "and it wins outright");
    }

    /// L-02: the tie hash contains no secret or future entropy. Once a silent
    /// window's target is known, a miner can evaluate many addresses off-chain,
    /// fund only the best one, and obtain the best-of-G tie hash for one stake.
    function test_L02_addressGrinderCommitsOnlyItsBestOf256Addresses() public {
        _fund();
        _toBlock(B);
        int24 target = _spotTick();

        bytes32 honestHash = keccak256(abi.encodePacked(alice, B, target));
        address best;
        bytes32 bestHash = bytes32(type(uint256).max);
        for (uint256 i = 1; i <= 256; i++) {
            address candidate = address(uint160(0xBEEF_0000 + i));
            bytes32 candidateHash = keccak256(abi.encodePacked(candidate, B, target));
            if (candidateHash < bestHash) {
                best = candidate;
                bestHash = candidateHash;
            }
        }
        assertLt(uint256(bestHash), uint256(honestHash), "best-of-256 beats this honest address");

        uint256 stake = hook.stakeFor(B);
        deal(address(token), best, stake, false);
        vm.prank(best);
        token.approve(address(hook), stake);

        _commit(alice, target, "honest");
        _commit(best, target, "ground");
        assertEq(_stakedOf(B), 2 * stake, "256 candidates cost the grinder one stake");

        _toBlock(B + 2);
        hook.poke();
        _reveal(alice, B, target, "honest");
        _reveal(best, B, target, "ground");
        assertEq(_winnerOf(B), best, "precomputed best address wins the exact tie");
    }

    // ============================================================
    // L-1 / T-11 — the buyback used to bypass the T-05 void guard
    //
    // v4's Hooks.afterSwap short-circuits on self-calls, so _afterSwap (where
    // T-05 lives) never ran for buybackAndBurn(maxEthIn). Once pendingEth exceeded the
    // ETH cost of the remaining BITHOOK below the tick, the swap drained the
    // corridor, coasted through empty space and parked the pool at MIN_TICK --
    // and the oracle adopted it. Now re-checked inside unlockCallback.
    // ============================================================
    function test_T11_buybackRefusesToParkThePoolInAVoid() public {
        vm.warp(block.timestamp + 10);

        // v6.0: the tail reaches the minimum usable tick, so "almost nothing
        // left below the tick" now sits ~4e22 ETH away and this setup can no
        // longer reach it. The guard stays as defensive depth (the void above
        // the open still exists, and the floor bound costs nothing to keep);
        // this drives the pool as deep as a large buy can and proves the
        // buyback still behaves at depth: fills inside the book or refuses,
        // never parks.
        vm.deal(attacker, 5_000 ether);
        uint160 corridorFloor = hook.seedSqrtLower();
        vm.prank(attacker);
        swapRouter.swap{value: 4_000 ether}(
            key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(uint256(4_000 ether)),
                // Stop on the real corridor boundary, as before v6.0.
                sqrtPriceLimitX96: corridorFloor
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );

        // a sell puts ETH in pendingEth
        _swap(alice, false, -int256(token.balanceOf(alice) / 2));
        assertGt(hook.pendingEth(), 0, "there is fee ETH to spend");

        int24 before = _spotTick();
        uint128 liqBefore = IPoolManager(address(manager)).getLiquidity(key.toId());

        // either it fills inside the book, or it refuses -- it must never park
        try hook.buybackAndBurn(0) {
            assertGt(
                IPoolManager(address(manager)).getLiquidity(key.toId()), 0,
                "if it filled, it left the price somewhere real"
            );
        } catch {
            assertEq(_spotTick(), before, "and if it refused, nothing moved");
            assertEq(IPoolManager(address(manager)).getLiquidity(key.toId()), liqBefore);
        }

        // the oracle never saw MIN_TICK either way
        assertGt(_spotTick(), TickMath.MIN_TICK + 1_000, "no void price was ever adopted");
    }

    /// The guard must not break the ordinary case it shares a path with.
    function test_T11_normalBuybackIsUnaffected() public {
        vm.warp(block.timestamp + 10);
        _swap(alice, true, -0.2 ether);
        _swap(alice, false, -int256(token.balanceOf(alice) / 4));

        uint256 supply = token.totalSupply();
        hook.buybackAndBurn(0);
        assertEq(hook.pendingEth(), 0, "spent");
        assertLt(token.totalSupply(), supply, "and burned what it bought");
    }

    // ============================================================
    // L-2 — the capital chain, recomputed for the v5.8 lock
    //
    // The header claimed 8.3% / 4.2% / zero-from-era-3. Neither lock model
    // produces those. Under the 10% slice lock it is 5.0% peak in era 1 and
    // ZERO from era TWO -- one era earlier, i.e. worse than we claimed.
    // ============================================================
    function test_L2_outsideCapitalIsZeroFromEraTwoNotEraThree() public {
        uint256 GRID = 100;
        uint256 slices = hook.LOCK_SLICES_PER_ERA();

        uint256 blocksEra1 = hook.ERA_ONE() / hook.BLOCK_TIME();
        uint256 era1Staked = GRID * hook.stakeFor(0) * blocksEra1;

        // peak outstanding is two slices' worth: the lock is (10%, 20%] of the era
        uint256 peak = era1Staked * 2 / slices;
        assertApproxEqRel(peak, 1_050_000e18, 0.01e18, "~1.05M peak, 5% of supply");

        // by the time era 2 opens, slices 0..8 of era 1 have already unlocked
        uint256 liquidAtEra2 = era1Staked * (slices - 1) / slices;

        uint256 blocksEra2 = (2 * hook.ERA_ONE()) / hook.BLOCK_TIME();
        uint256 era2Staked = GRID * hook.stakeFor(blocksEra1 + 10) * blocksEra2;

        assertGt(liquidAtEra2, era2Staked, "era 1's returns alone cover ALL of era 2");

        emit log_named_uint("era 1 staked, BITHOOK        ", era1Staked / 1e18);
        emit log_named_uint("era 1 peak outside capital   ", peak / 1e18);
        emit log_named_uint("...as % of 21M supply        ", peak * 100 / 21_000_000e18);
        emit log_named_uint("liquid when era 2 opens      ", liquidAtEra2 / 1e18);
        emit log_named_uint("era 2 total need             ", era2Staked / 1e18);
    }

    // ============================================================
    // I-1 — V-03's "zero margin under MAX_SUPPLY" is obsolete
    //
    // It was true while the schedule terminated at exactly 10.5M. Infinite
    // halvings make scheduled issuance strictly less than that at every finite
    // time, so the peak is at least a wei short of the cap.
    // ============================================================
    function test_I1_maxSupplyMarginIsRestoredByTheInfiniteSchedule() public view {
        uint256 M = hook.TOTAL_MINING_SUPPLY();
        assertLt(hook.scheduleCap(112 days), M);
        assertLt(hook.scheduleCap(36500 days), M, "a century in, still short");
        assertLt(
            token.INITIAL_SUPPLY() + hook.scheduleCap(36500 days), token.MAX_SUPPLY(),
            "so peak supply never touches the cap"
        );
    }
}
