// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";

/// Deployability guard.
///
/// The rest of the suite installs the hook with `deployCodeTo`, a cheatcode
/// that writes bytecode straight to a chosen address. That is the only
/// practical way to place a hook at an address whose low bits carry the
/// permission flags — but it bypasses EIP-170 entirely, so a hook that CANNOT
/// BE DEPLOYED still passes every other test in this repo.
///
/// That is not hypothetical: under the legacy (non-via-IR) pipeline
/// BithookMiningHook compiles to 24,846 bytes, 270 over the limit, and the
/// mainnet launch would have failed on the hook transaction with the token
/// already deployed. 252 green tests said nothing about it; only running the
/// deploy script against a fork surfaced it.
///
/// So these assertions read the COMPILED ARTIFACT — exactly the bytes that
/// would be deposited on-chain — and fail if either limit is breached.
contract DeploySizeTest is Test {
    /// EIP-170: maximum runtime code a contract may deposit.
    uint256 constant MAX_RUNTIME = 24_576;
    /// EIP-3860: maximum initcode a CREATE/CREATE2 may execute. The launch
    /// deploys the hook via the CREATE2 proxy, so this bound is live too.
    uint256 constant MAX_INITCODE = 49_152;

    function _check(string memory artifact) internal view returns (uint256 runtime) {
        runtime = vm.getDeployedCode(artifact).length;
        uint256 initcode = vm.getCode(artifact).length;

        // Signed, so an OVERSIZE contract reports a negative margin and trips
        // the assertion below rather than panicking on an underflow here --
        // the failure has to name the actual problem.
        console2.log(artifact);
        console2.log("  runtime ", runtime);
        console2.log("  margin  ", int256(MAX_RUNTIME) - int256(runtime));
        console2.log("  initcode", initcode);
        console2.log("  margin  ", int256(MAX_INITCODE) - int256(initcode));

        assertLe(runtime, MAX_RUNTIME, "EIP-170: runtime code too large to deploy");
        assertLe(initcode, MAX_INITCODE, "EIP-3860: initcode too large to execute");
    }

    /// The hook is the tight one. If this fails, `via_ir = true` was probably
    /// dropped from foundry.toml — the legacy pipeline does not fit, and
    /// lowering optimizer_runs does not rescue it (runs=1 still lands at
    /// 24,650). See the comment on that setting.
    function test_hookFitsInTheEip170Limit() public view {
        uint256 runtime = _check("Bithook.sol:BithookMiningHook");
        // Warn while there is still room to act, not at broadcast. Written as
        // an addition so it cannot underflow on an already-oversize build.
        assertLe(
            runtime + 512,
            MAX_RUNTIME,
            "under 512 bytes of headroom left: shrink the hook before adding more"
        );
    }

    function test_tokenFitsInTheEip170Limit() public view {
        _check("Bithook.sol:Bithook");
    }
}
