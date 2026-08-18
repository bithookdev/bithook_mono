// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";

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
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";

/// Does the DEPLOYED mainnet PoolManager price swaps identically to the
/// locally compiled one?
///
/// It matters because every local test and every long-horizon simulation runs
/// against the local build, while the launch will run against the deployed
/// bytecode. The two are not the same bytes — the local build is 17,151 and
/// mainnet is 24,009, which is expected (Uniswap ships with a far higher
/// optimizer-runs setting) but expected-for-a-good-reason is not the same as
/// verified.
///
/// This builds the SAME launch twice inside one forked run — once on a
/// freshly compiled PoolManager, once on mainnet's — and compares outputs
/// wei-for-wei. Skips when not forked.
contract PoolManagerParityTest is Test {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    address constant MAINNET_PM = 0x000000000004444c5dc75cB358380D2e3dE08A90;

    uint160 constant HOOK_FLAGS = uint160(
        Hooks.AFTER_INITIALIZE_FLAG | Hooks.AFTER_SWAP_FLAG
            | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
            | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
    );

    struct Env {
        IPoolManager manager;
        Bithook token;
        BithookMiningHook hook;
        PoolSwapTest router;
        PoolKey key;
    }

    function _launch(IPoolManager manager) internal returns (Env memory e) {
        e.manager = manager;
        e.router = new PoolSwapTest(manager);
        e.token = new Bithook(address(this));

        // The two environments differ in both manager and token, so their
        // initcode differs and the mined salts land on distinct addresses.
        bytes memory ctorArgs = abi.encode(manager, e.token, address(this));
        (address predicted, bytes32 salt) =
            HookMiner.find(address(this), HOOK_FLAGS, type(BithookMiningHook).creationCode, ctorArgs);

        e.hook = new BithookMiningHook{salt: salt}(manager, e.token, address(this));
        require(address(e.hook) == predicted, "hook address mismatch");
        e.token.finalizeMinter(address(e.hook));

        e.key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(e.token)),
            fee: 0,
            tickSpacing: 200,
            hooks: IHooks(address(e.hook))
        });
        manager.initialize(e.key, TickMath.getSqrtPriceAtTick(e.hook.SEED_START_TICK()));
        e.token.approve(address(e.hook), e.token.INITIAL_SUPPLY());
        e.hook.seed();
    }

    function _buy(Env memory e, uint256 ethIn) internal returns (uint256 got) {
        uint256 before = e.token.balanceOf(address(this));
        e.router.swap{value: ethIn}(
            e.key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(ethIn),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        return e.token.balanceOf(address(this)) - before;
    }

    function test_deployedAndLocalPoolManagersPriceIdentically() public {
        if (MAINNET_PM.code.length == 0) {
            console2.log("not forked - skipping parity check");
            vm.skip(true);
            return;
        }
        vm.warp(1_000_000);
        vm.deal(address(this), 10_000 ether);

        Env memory localEnv = _launch(IPoolManager(address(new PoolManager(address(this)))));
        Env memory fork = _launch(IPoolManager(MAINNET_PM));

        console2.log("local PM code   ", address(localEnv.manager).code.length);
        console2.log("mainnet PM code ", MAINNET_PM.code.length);

        // A ladder of buys, each compounding on the previous price.
        uint256[5] memory sizes =
            [uint256(0.001 ether), 0.01 ether, 0.1 ether, 1 ether, 10 ether];
        for (uint256 i = 0; i < sizes.length; i++) {
            uint256 a = _buy(localEnv, sizes[i]);
            uint256 b = _buy(fork, sizes[i]);
            console2.log("buy", sizes[i]);
            console2.log("   local  out", a);
            console2.log("   mainnet out", b);
            assertEq(a, b, "swap output differs between local and deployed PoolManager");
        }

        (, int24 tl,,) = IPoolManager(address(localEnv.manager)).getSlot0(localEnv.key.toId());
        (, int24 tf,,) = IPoolManager(MAINNET_PM).getSlot0(fork.key.toId());
        console2.log("final tick local  ", vm.toString(int256(tl)));
        console2.log("final tick mainnet", vm.toString(int256(tf)));
        assertEq(tl, tf, "final tick differs");
    }

    receive() external payable {}
}
