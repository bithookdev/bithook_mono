// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BithookTest} from "./Bithook.t.sol";

/// The auditor's original proofs-of-concept, kept verbatim in structure but
/// with their assertions inverted: each demonstrated a real bug, and now
/// asserts that the fix holds. A regression re-breaks these first.
contract BithookAuditPoC is BithookTest {
    function test_AUDIT_sameTimestampRoundTripPinsIntermediateTick() public {
        _fund();
        int24 natural = _spotTick();

        // Preview the deterministic post-push tick, then restore the state so
        // the attacker can commit to it before the target window.
        uint256 snapshot = vm.snapshotState();
        _toBlock(B + 1);
        _swap(attacker, true, -0.5 ether);
        int24 predictedManipulatedTick = _spotTick();
        assertTrue(vm.revertToStateAndDelete(snapshot));

        _toBlock(B);
        _commit(attacker, predictedManipulatedTick, "attack");
        _commit(alice, natural, "honest");

        // Two swaps at one timestamp: push first, then reverse immediately.
        // The second afterSwap returns early because nowTs == lastObsTs, so
        // lastTick stays at the intermediate manipulated price.
        _toBlock(B + 1);
        uint256 tokensBefore = token.balanceOf(attacker);
        _swap(attacker, true, -0.5 ether);
        int24 pushed = _spotTick();
        uint256 bought = token.balanceOf(attacker) - tokensBefore;
        _swap(attacker, false, -int256(bought));
        int24 restored = _spotTick();

        assertEq(pushed, predictedManipulatedTick, "preview is deterministic");
        assertLt(_absDiff(natural, restored), _absDiff(natural, pushed), "spot was substantially restored");
        assertEq(hook.lastTick(), restored, "T-02 fixed: oracle follows the unwind, not the spike");

        _toBlock(B + 2);
        hook.poke();
        int24 target = hook.targetTick(B);
        assertTrue(target != pushed, "T-02 fixed: a 0-second price no longer defines the window");

        _reveal(attacker, B, predictedManipulatedTick, "attack");
        _reveal(alice, B, natural, "honest");
        assertEq(_winnerOf(B), alice, "T-02 fixed: restoring spot immediately no longer wins");
    }

    function test_AUDIT_checkpointLimitBurnsValidCommitment() public {
        _fund();
        uint256 n = 40;
        int24 prediction = _spotTick();

        _toBlock(n);
        _commit(alice, prediction, "valid");
        uint256 aliceBefore = token.balanceOf(alice);

        // A long quiet period used to orphan every boundary past the checkpoint
        // cap; the oracle now fills the most recent ones, so this block resolves.
        _toBlock(n + 2);
        hook.poke();
        assertTrue(hook.targetAvailable(n), "T-01 fixed: the target is available after a long quiet period");

        vm.prank(alice);
        hook.reveal(n, prediction, "valid");

        aliceBefore; // the stake is locked at reveal rather than returned
        assertEq(
            hook.lockedStake(alice, 0), hook.stakeFor(n),
            "T-01 fixed: a valid committer recovers their stake (locked, not burned)"
        );
    }
}
