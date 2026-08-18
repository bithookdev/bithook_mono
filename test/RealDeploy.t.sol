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
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";

/// The launch, deployed FOR REAL — CREATE2 with a mined salt, exactly as
/// script/Deploy.s.sol does it, instead of the `deployCodeTo` cheatcode every
/// other suite uses.
///
/// This is the only test in the repo where the hook's bytecode goes through an
/// actual EVM code deposit, so it is the only one subject to EIP-170. It is
/// also the only one that proves the mined salt genuinely yields an address
/// carrying the permission flags v4 requires — `deployCodeTo` is handed that
/// address, so it assumes what the real launch must derive.
///
/// Kept in its own file because HookMiner brute-forces ~16k salts (14 flag
/// bits), hashing the full ~23KB creation code each time. That is far too slow
/// for the shared fixture, which re-runs per test.
contract RealDeployTest is Test {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    uint160 constant HOOK_FLAGS = uint160(
        Hooks.AFTER_INITIALIZE_FLAG | Hooks.AFTER_SWAP_FLAG
            | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
            | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
    );

    function test_theRealLaunchPathDeploysAndSeeds() public {
        vm.warp(1_000_000);
        address owner = address(this);

        PoolManager manager = new PoolManager(owner);
        Bithook token = new Bithook(owner);

        // 1. mine a salt whose address carries the flag bits, then CREATE2.
        bytes memory ctorArgs = abi.encode(IPoolManager(address(manager)), token, owner);
        (address predicted, bytes32 salt) = HookMiner.find(
            address(this), HOOK_FLAGS, type(BithookMiningHook).creationCode, ctorArgs
        );
        BithookMiningHook hook =
            new BithookMiningHook{salt: salt}(IPoolManager(address(manager)), token, owner);

        assertEq(address(hook), predicted, "CREATE2 landed on the mined address");
        assertGt(address(hook).code.length, 0, "code was actually deposited");
        assertLe(address(hook).code.length, 24_576, "and it fits EIP-170");
        assertEq(
            uint160(address(hook)) & Hooks.ALL_HOOK_MASK,
            HOOK_FLAGS & Hooks.ALL_HOOK_MASK,
            "address carries exactly the declared permissions"
        );
        console2.log("mined hook address", address(hook));
        console2.log("deposited code    ", address(hook).code.length);

        // 2. the rest of the launch, in script order.
        token.finalizeMinter(address(hook));

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(token)),
            fee: 0,
            tickSpacing: 200,
            hooks: IHooks(address(hook))
        });
        manager.initialize(key, TickMath.getSqrtPriceAtTick(hook.SEED_START_TICK()));

        token.approve(address(hook), token.INITIAL_SUPPLY());
        hook.seed();

        // 3. the post-deploy checks the script tells the operator to run.
        assertGt(hook.curveLiquidity(), 0, "curve band installed");
        assertGt(hook.tailLiquidity(), 0, "tail band installed");
        assertEq(address(manager).balance, 0, "the seed posted zero ETH");
        assertLe(
            token.INITIAL_SUPPLY() - token.balanceOf(address(manager)),
            hook.MAX_SEED_TOKEN_DUST(),
            "dust within the enforced bound"
        );
        assertTrue(token.minterFinalized() && token.minter() == address(hook), "minter handed over");
        assertEq(hook.miningStart(), 0, "mining NOT started, per the launch plan");

        // 4. and it trades, on a genuinely deployed hook.
        (, int24 tick,,) = IPoolManager(address(manager)).getSlot0(key.toId());
        assertEq(tick, hook.SEED_START_TICK(), "pool opened on the declared tick");

        // 5. arming it later still works.
        vm.warp(block.timestamp + 24 hours);
        hook.startMining();
        assertEq(hook.miningStart(), block.timestamp, "armed 24h after deploy");
    }
}
