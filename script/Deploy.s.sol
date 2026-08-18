// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {Bithook, BithookMiningHook} from "../src/Bithook.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
// HookMiner is off-chain tooling; importing from test/shared is fine here
// because it never lands on-chain.
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";

/// THE WHOLE LAUNCH, in one script and one broadcast:
///   1. deploy Bithook (10.5M to the deployer — all of it for the seed)
///   2. mine a hook address with the correct flag bits + deploy via CREATE2
///   3. finalizeMinter(hook)  — permanent!
///   4. initialize the pool (only the deployer can, C-01)
///   5. seed the two launch bands (the whole 10.5M, no ETH)
///   6. startMining()
///
/// Audit M-2 is CLOSED IN THE CONTRACT as of v5.9, not mitigated here. The
/// hook owns the seed and every external liquidity add reverts at all times,
/// so there is no window — not even a sub-second one — in which a third party
/// can put a position into this pool. That matters less for the LP who would
/// have been sealed in than for the oracle: T-05 assumes nothing exists
/// outside the seed corridor, and pre-v5.9 a dust position parked in the void
/// bought that assumption for 0.00000065 ETH (test/PreStartLiquidity.t.sol).
///
/// Steps 4-6 stay in one broadcast anyway: it is still the only ordering that
/// leaves no half-launched pool sitting on-chain between transactions.
///
/// Required env: none. The signer is supplied on the command line (`--account`
/// or `--ledger`) and never through the environment. v5 needs no oracle at all
/// — the mining target is the pool's own TWAP, measured inside the hook.
contract DeployBithook is Script {
    // Ethereum mainnet.
    uint256 constant CHAIN_ID = 1;

    // The canonical Uniswap v4 PoolManager on mainnet. Verified on-chain:
    // 24KB of code, answers the ERC-6909 surface (balanceOf/isOperator), and
    // extsload(slot 0) reads back the Uniswap governance Timelock as owner.
    address constant POOL_MANAGER = 0x000000000004444c5dc75cB358380D2e3dE08A90;

    // Pinned so a wrong or upgraded target aborts BEFORE finalizeMinter() and
    // seed(), both of which are one-shot and unrecoverable.
    bytes32 constant POOL_MANAGER_CODEHASH =
        0x785f1014552b7ce7d5fb7d0c970ca60edee94fd00425d7ca21609acac7ce1293;

    // CREATE2 deployer proxy (standard across EVM chains)
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    // ---------------------------------------------------------------
    // Launch curve (pump.fun shape, v6.0)
    // ---------------------------------------------------------------
    // The geometry is FIXED IN THE HOOK; this script supplies nothing but the
    // tokens. Two hook-owned bands, both pure BITHOOK and zero ETH:
    //
    //   curve: CURVE_TOKENS (8.4M) from SEED_START_TICK (164,600 — ~1.49 ETH
    //          FDV, pump.fun's ~$4.5k start) down 26,800 ticks to
    //          SEED_GRAD_TICK, a 14.58x rise — pump.fun's start-to-graduation
    //          multiple ($69k at their scale, ~21.8 ETH FDV here).
    //   tail:  the remaining 2.1M from SEED_GRAD_TICK to the minimum usable
    //          tick, so the price has NO ceiling. The 80/20 split reproduces
    //          pump.fun's ~1.4x density drop at graduation.
    //
    // A constant-product bonding curve with virtual reserves (pump.fun's) IS a
    // uniform concentrated position, so this is their entire two-phase system
    // — curve, then graduated AMM — in one pool with no migration event.
    // The opening valuation is a *price* we declare, not capital we post, so
    // the deployer needs no ETH at all. See README "Launch curve".

    /// Step 5: approve and call seed(). The hook derives both bands' liquidity
    /// from its constants and installs the positions itself (E-01, v5.9): no
    /// PositionManager, no Permit2, and no third party can add liquidity at
    /// any point — before this call or after it.
    function _seed(Bithook token, BithookMiningHook hook, address deployer) internal {
        uint256 balance = token.balanceOf(deployer);
        require(balance == token.INITIAL_SUPPLY(), "deployer must hold the whole supply");

        token.approve(address(hook), balance);
        hook.seed();

        // seed() refunds the handful of token wei that uint128 liquidity
        // cannot represent (two floor roundings, one per band).
        uint256 dust = token.balanceOf(deployer);
        require(dust <= hook.MAX_SEED_TOKEN_DUST(), "excess seed dust");
        console.log("Seeded BITHOOK:", balance - dust);
        console.log("Seed rounding dust:", dust);
    }

    function run() external {
        require(block.chainid == CHAIN_ID, "wrong chain: expected Ethereum mainnet (1)");
        require(POOL_MANAGER.code.length > 0, "PoolManager has no code");
        require(POOL_MANAGER.codehash == POOL_MANAGER_CODEHASH, "PoolManager codehash mismatch");

        // The signer comes from the CLI -- `--account <name>` for an encrypted
        // keystore, `--ledger` for a hardware wallet -- so no raw key ever
        // reaches the environment, the shell history, or this repo. Pass
        // `--sender` too: it pins the address that becomes permanent owner, and
        // forge refuses to broadcast if the keystore or device cannot sign for
        // it.
        //
        // With neither flag, forge falls back to its DEFAULT sender
        // (0x1804...1f38) without warning. That address would become the owner,
        // and `finalizeMinter()` is one-shot, so the guard below is not
        // paranoia: it is the difference between a failed script and a
        // permanently bricked launch.
        address deployer = msg.sender;
        require(deployer != DEFAULT_SENDER, "no signer: pass --account/--ledger and --sender");
        vm.startBroadcast();

        // 1. token
        Bithook token = new Bithook(deployer);

        // 2. mine a hook address + deploy
        uint160 flags = uint160(
            Hooks.AFTER_INITIALIZE_FLAG | Hooks.AFTER_SWAP_FLAG
                | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
                | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG // E-01
        );
        bytes memory ctorArgs =
            abi.encode(IPoolManager(POOL_MANAGER), token, deployer);
        (address hookAddr, bytes32 salt) =
            HookMiner.find(CREATE2_DEPLOYER, flags, type(BithookMiningHook).creationCode, ctorArgs);
        BithookMiningHook hook = new BithookMiningHook{salt: salt}(
            IPoolManager(POOL_MANAGER), token, deployer
        );
        require(address(hook) == hookAddr, "hook address mismatch");

        // 3. hand minting rights to the hook, permanently
        token.finalizeMinter(address(hook));

        // 4. initialize the pool
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(token)),
            fee: 0, // the toll is the flat 1% hook fee (F-01)
            tickSpacing: 200,
            hooks: IHooks(address(hook))
        });
        // The hook fixes the production opening tick on-chain, so deployment
        // cannot silently choose another launch valuation.
        int24 startTick = hook.SEED_START_TICK();
        IPoolManager(POOL_MANAGER).initialize(key, TickMath.getSqrtPriceAtTick(startTick));

        // 5. seed the two bands: the entire balance, zero ETH.
        _seed(token, hook, deployer);

        // NOTE: startMining() is deliberately NOT called here. The launch plan
        // is a ~24h trading-only window first, so mining arms against a price
        // the market set rather than the declared opening tick with no flow
        // behind it. Nothing is lost by waiting: the emission schedule runs
        // from miningStart, not from deploy. The pool trades, fees accrue and
        // both burn paths work throughout the window; every mining entry point
        // reverts until the call is made.
        //
        // It is an OWNER-ONLY call with no on-chain deadline, so if the key is
        // lost before it is made, the 10.5M mining allocation is never mined.
        vm.stopBroadcast();

        console.log("BITHOOK: ", address(token));
        console.log("Hook:    ", address(hook));
        console.log("Owner:   ", deployer);
        console.log("Start tick:          ", startTick);
        console.log("Graduation tick:     ", hook.SEED_GRAD_TICK());
        console.log("Tail floor tick:     ", hook.SEED_FLOOR_TICK());
        console.log("");
        console.log("POOL IS LIVE AND TRADING. Liquidity is PERMANENTLY sealed");
        console.log("(E-01). MINING IS NOT STARTED. Verify on-chain:");
        console.log("  - both seed bands sit in the ranges above and hold 0 ETH");
        console.log("  - token.minter() == hook and minterFinalized() == true");
        console.log("  - hook.miningStart() == 0   <-- still zero, by design");
        console.log("");
        console.log("THEN, ~24h later, as owner:");
        console.log("  cast send <hook> 'startMining()' --rpc-url <rpc> ...");
        console.log("  and confirm hook.miningStart() != 0 afterwards.");
    }
}
