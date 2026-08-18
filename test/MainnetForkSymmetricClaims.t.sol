// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BithookHarness} from "./Bithook.t.sol";
import {Bithook, BithookMiningHook} from "../src/Bithook.sol";

import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";

/// Optional mainnet-fork regression for the symmetric ERC-6909 fee fix (F-5
/// and its mirror). Everything except the PoolManager is fork-local: a fresh
/// Bithook, a fresh hook, a local router and a brand-new pool. The test exercises
/// the deployed v4 PoolManager's runtime and accounting on a disposable fork;
/// the local suite separately covers a PoolManager compiled from pinned source.
///
///   forge test --fork-url "$MAINNET_RPC_URL" \
///     --fork-block-number 25739861 \
///     --match-contract MainnetForkSymmetricClaimsTest -vvv
///
/// Without a fork every test SKIPS rather than fails, so it is inert in the
/// default `forge test` run.
contract MainnetForkSymmetricClaimsTest is BithookHarness {
    using StateLibrary for IPoolManager;

    address constant MAINNET_MANAGER = 0x000000000004444c5dc75cB358380D2e3dE08A90;

    bool forked;

    modifier onlyFork() {
        if (!forked) {
            vm.skip(true);
            return;
        }
        _;
    }

    /// makeAddr() labels are NOT safe on a mainnet fork. makeAddr("attacker")
    /// is 0x9dF0...6B4e, which on mainnet is a live sweeper contract: it
    /// accepts ETH, scans the caller's WETH/USDT/USDC/stETH/... balances and
    /// forwards the whole value to 0xa619...e8a. An exact-output sell paid it
    /// correctly and its balance still read zero afterwards. These low
    /// literals are expected to be empty, and setUp verifies that assumption.
    function _useForkSafeActors() internal {
        owner = address(0x0FF1CE);
        alice = address(0xA11CE);
        bob = address(0xB0B);
        carol = address(0xCA401);
        attacker = address(0xBAD);
        address[5] memory all = [owner, alice, bob, carol, attacker];
        for (uint256 i = 0; i < all.length; i++) {
            assertEq(all[i].code.length, 0, "fork actor collides with mainnet code");
        }
    }

    function setUp() public override {
        if (block.chainid != 1 || MAINNET_MANAGER.code.length == 0) return;
        forked = true;
        _useForkSafeActors();

        // The one piece of existing mainnet state.
        manager = PoolManager(payable(MAINNET_MANAGER));
        swapRouter = new PoolSwapTest(IPoolManager(MAINNET_MANAGER));
        lpRouter = new PoolModifyLiquidityTest(IPoolManager(MAINNET_MANAGER));

        // Everything else is fresh, so the pool id is new and cannot collide
        // with anything already live on the manager.
        token = new Bithook(owner);
        address hookAddr = address(HOOK_FLAGS | (0x4444 << 20));
        assertEq(hookAddr.code.length, 0, "fork hook address already has code");
        deployCodeTo("Bithook.sol:BithookMiningHook", abi.encode(IPoolManager(MAINNET_MANAGER), token, owner), hookAddr);
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

        vm.prank(owner);
        manager.initialize(key, TickMath.getSqrtPriceAtTick(PRODUCTION_START_TICK));

        vm.startPrank(owner);
        _seedProduction(hook, token);
        hook.startMining();
        vm.stopPrank();

        _fundActors();
        vm.warp(block.timestamp + 10);
    }

    /// Strip the live manager of every wei it holds for unrelated pools. This
    /// is what makes the reproduction honest: with mainnet's real ETH balance
    /// in place the OLD take()-based code would have silently succeeded by
    /// borrowing other pools' ETH, which is exactly the coupling the fix
    /// removes. Only the disposable fork is touched.
    function _stripManagerEth() internal {
        vm.deal(MAINNET_MANAGER, 0);
        assertEq(MAINNET_MANAGER.balance, 0, "live manager stripped of incidental ETH");
    }

    // ============================================================
    // F-5: native exact-output buy, against the live manager
    // ============================================================
    function test_nativeExactOutputBuyMintsAClaimOnTheLiveManager() public onlyFork {
        _stripManagerEth();

        vm.prank(alice);
        swapRouter.swap{value: 20 ether}(
            key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: int256(1_000e18),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );

        assertEq(token.balanceOf(alice), 1_000e18, "exact output delivered in full");
        assertGt(hook.pendingEth(), 0, "the ETH fee accrued");
        assertEq(manager.balanceOf(address(hook), 0), hook.pendingEth(), "as a 6909 claim");
        assertEq(address(hook).balance, 0, "and the hook holds no ETH at all");
        assertGe(MAINNET_MANAGER.balance, hook.pendingEth(), "the claim is fully covered");
    }

    /// The claim is not merely collectable, it is spendable: buybackAndBurn(maxEthIn)
    /// pays for its swap by burning the claim, on the live manager.
    function test_buybackSpendsTheNativeClaimOnTheLiveManager() public onlyFork {
        _stripManagerEth();

        vm.prank(alice);
        swapRouter.swap{value: 20 ether}(
            key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: int256(1_000e18),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );

        uint256 supply = token.totalSupply();
        uint256 managerEth = MAINNET_MANAGER.balance;
        hook.buybackAndBurn(0);

        assertEq(hook.pendingEth(), 0, "the claim was spent");
        assertEq(manager.balanceOf(address(hook), 0), 0, "and burned");
        assertGt(hook.totalBuybackBurned(), 0, "it bought BITHOOK");
        assertEq(token.totalSupply(), supply - hook.totalBuybackBurned(), "and destroyed it");
        assertEq(MAINNET_MANAGER.balance, managerEth, "no ETH crossed the manager");
    }

    // ============================================================
    // The MIRROR: BITHOOK exact-output sell fee, claim not take
    // ============================================================
    // Pre-v6.0 this drove the pool to the corridor floor, where seed
    // inventory really was dust and take() had nothing to pay from. The
    // v6.0 tail reaches the minimum usable tick, so that state is ~4e22 ETH
    // away; the claim mechanism it forced is still the live path on every
    // exact-output sell and is what this exercises on the real manager.
    function test_tokenExactOutputSellMintsAClaimOnTheLiveManager() public onlyFork {
        _stripManagerEth();

        // Buy deep into the curve so the sell has a real book to trade into.
        vm.deal(attacker, 2_000 ether);
        vm.prank(attacker);
        swapRouter.swap{value: 1_500 ether}(
            key,
            SwapParams({zeroForOne: true, amountSpecified: -int256(uint256(1_500 ether)), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );

        uint256 id = uint256(uint160(address(token)));

        // The exact-output sell that reverted before the fix.
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

        assertEq(attacker.balance - ethBefore, 0.001 ether, "exact output delivered in full");
        assertGt(hook.pendingToken(), 0, "the BITHOOK fee accrued");
        assertEq(manager.balanceOf(address(hook), id), hook.pendingToken(), "as a 6909 claim");

        // And it is spendable right away.
        uint256 supply = token.totalSupply();
        uint256 pending = hook.pendingToken();
        hook.burnFees();
        assertEq(token.totalSupply(), supply - pending, "the fee was destroyed");
        assertEq(hook.pendingToken(), 0);
        assertEq(manager.balanceOf(address(hook), id), 0, "the claim was consumed");
    }
}
