// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BithookHarness} from "./Bithook.t.sol";

/// Dumps the fixture that packages/core is differential-tested against.
///
/// The TypeScript port of the emission schedule, the era and lock arithmetic,
/// the commitment hash and the tie rule is what the indexer and the app agree
/// on. If it drifts from Solidity by one wei or one tick, the
/// app reports the wrong winner and nothing in the TS test suite would notice.
/// So the fixture is produced BY THE REAL CONTRACT here, and asserted against
/// in vitest.
///
/// Commitment hashes and the tie outcome are not merely computed with the same
/// expression as the contract -- that would only test a copy of itself. Every
/// commitment in the fixture is proven by a real commit+reveal round trip that
/// the contract accepted, and the tie outcome is read back from a real forced
/// tie between two revealers.
///
///   DUMP_FIXTURES=1 forge test --match-contract DumpFixtures -vv
contract DumpFixtures is BithookHarness {
    string constant OUT = "./packages/core/fixtures/contract.json";

    /// Blocks that were actually played, so their real boundary cumulatives and
    /// targets can be dumped.
    uint256[] playedBlocks;

    function _u(uint256 v) internal pure returns (string memory) {
        return vm.toString(v);
    }

    function _i(int256 v) internal pure returns (string memory) {
        return vm.toString(v);
    }

    /// Block numbers straddling every early era boundary, plus deep ones.
    /// Era k covers blocks [1008*(2^k - 1), 1008*(2^(k+1) - 1)).
    function _sampleBlocks() internal pure returns (uint256[] memory ns) {
        uint256[] memory fixed_ = new uint256[](34);
        uint256 i;
        // era boundaries and their neighbours
        fixed_[i++] = 0;
        fixed_[i++] = 1;
        fixed_[i++] = 2;
        fixed_[i++] = 1007;
        fixed_[i++] = 1008; // era 1 opens
        fixed_[i++] = 1009;
        fixed_[i++] = 3023;
        fixed_[i++] = 3024; // era 2
        fixed_[i++] = 3025;
        fixed_[i++] = 7055;
        fixed_[i++] = 7056; // era 3
        fixed_[i++] = 7057;
        fixed_[i++] = 15119;
        fixed_[i++] = 15120; // era 4
        fixed_[i++] = 15121;
        fixed_[i++] = 31247;
        fixed_[i++] = 31248; // era 5
        fixed_[i++] = 31249;
        fixed_[i++] = 63503;
        fixed_[i++] = 63504; // era 6
        fixed_[i++] = 63505;
        fixed_[i++] = 128015;
        fixed_[i++] = 128016; // era 7
        fixed_[i++] = 128017;
        // lock-slice boundaries inside era 0 (slice width 1008/10 = 100.8 blocks)
        fixed_[i++] = 100;
        fixed_[i++] = 101;
        fixed_[i++] = 504;
        fixed_[i++] = 907;
        // deep tail, where per-block rewards approach the integer floor
        fixed_[i++] = 1_000_000;
        fixed_[i++] = 10_000_000;
        fixed_[i++] = 100_000_000;
        fixed_[i++] = 1_000_000_000;
        fixed_[i++] = 10_000_000_000;
        fixed_[i++] = 100_000_000_000;
        ns = fixed_;
    }

    /// Split across several concats: one chain this long is "stack too deep"
    /// even under via_ir.
    function _meta() internal view returns (string memory s) {
        s = string.concat(
            '"meta": {',
            '"miningStart": "', _u(hook.miningStart()), '",',
            '"blockTime": "', _u(hook.BLOCK_TIME()), '",',
            '"eraOne": "', _u(hook.ERA_ONE()), '",'
        );
        s = string.concat(
            s,
            '"stakeBps": "', _u(hook.STAKE_BPS()), '",',
            '"lockSlicesPerEra": "', _u(hook.LOCK_SLICES_PER_ERA()), '",',
            '"maxVest": "', _u(hook.MAX_VEST()), '",'
        );
        s = string.concat(
            s,
            '"totalMiningSupply": "', _u(hook.TOTAL_MINING_SUPPLY()), '",',
            '"maxCheckpoints": "', _u(hook.MAX_CHECKPOINTS()), '",',
            '"exitSlashBps": "', _u(hook.EXIT_SLASH_BPS()), '",'
        );
        s = string.concat(
            s,
            '"feeBps": "', _u(hook.FEE_BPS()), '",',
            '"seedStartTick": "', _i(hook.SEED_START_TICK()), '",',
            '"seedGradTick": "', _i(hook.SEED_GRAD_TICK()), '",'
        );
        s = string.concat(
            s,
            '"seedFloorTick": "', _i(hook.SEED_FLOOR_TICK()), '",',
            '"curveTokens": "', _u(hook.CURVE_TOKENS()), '",',
            '"maxSupply": "', _u(token.MAX_SUPPLY()), '",',
            '"initialSupply": "', _u(token.INITIAL_SUPPLY()), '"',
            "},\n"
        );
    }

    function _scheduleRow(uint256 n) internal view returns (string memory s) {
        uint256 elapsed = n * hook.BLOCK_TIME();
        (uint256 era, uint256 eraStart, uint256 eraDuration) = hook.eraAt(elapsed);
        uint256 slice = hook.lockSliceAt(elapsed);

        s = string.concat(
            "  {",
            '"n": "', _u(n), '",',
            '"cap": "', _u(hook.scheduleCap(elapsed)), '",',
            '"reward": "', _u(hook.scheduledBlockReward(n)), '",'
        );
        s = string.concat(
            s,
            '"stake": "', _u(hook.stakeFor(n)), '",',
            '"vestDuration": "', _u(hook.vestDurationFor(n)), '",',
            '"era": "', _u(era), '",'
        );
        s = string.concat(
            s,
            '"eraStart": "', _u(eraStart), '",',
            '"eraDuration": "', _u(eraDuration), '",',
            '"lockSlice": "', _u(slice), '",',
            '"unlockTime": "', _u(hook.stakeUnlockTime(slice)), '"'
        );
    }

    function test_dumpFixtures() public {
        if (vm.envOr("DUMP_FIXTURES", uint256(0)) == 0) {
            emit log("skipped; set DUMP_FIXTURES=1 to regenerate");
            return;
        }

        string memory json = string.concat("{\n", _meta());

        // ---- per-block schedule -----------------------------------------
        uint256[] memory ns = _sampleBlocks();
        json = string.concat(json, '"schedule": [\n');
        for (uint256 k = 0; k < ns.length; k++) {
            json = string.concat(
                json, _scheduleRow(ns[k]), k + 1 < ns.length ? "},\n" : "}\n"
            );
        }
        json = string.concat(json, "],\n");

        // ---- scheduleCap at raw elapsed values ---------------------------
        uint256[12] memory els = [
            uint256(0), 1, 599, 600, 604_799, 604_800, 604_801,
            1_814_400, 1_814_401, 9_676_800, 365 days, 3650 days
        ];
        json = string.concat(json, '"scheduleCap": [\n');
        for (uint256 k = 0; k < els.length; k++) {
            json = string.concat(
                json,
                '  {"elapsed": "', _u(els[k]), '", "cap": "', _u(hook.scheduleCap(els[k])), '"}',
                k + 1 < els.length ? ",\n" : "\n"
            );
        }
        json = string.concat(json, "],\n");

        // ---- commitments, each proven by a real commit+reveal ------------
        json = string.concat(json, '"commitments": [\n');
        json = string.concat(json, _proveCommitments());
        json = string.concat(json, "],\n");

        // ---- target division ---------------------------------------------
        json = string.concat(json, '"signedDiv": [\n', _signedDiv(), "],\n");

        // ---- real forced ties, in both reveal orders ---------------------
        json = string.concat(json, '"ties": [\n');
        json = string.concat(json, _proveTie(40, alice, bob), ",\n");
        json = string.concat(json, _proveTie(48, bob, alice), "\n");
        json = string.concat(json, "],\n");

        // ---- real boundary cumulatives -> real targetTickRaw ------------
        json = string.concat(json, '"targets": [\n', _targets(playedBlocks), "]\n}\n");

        vm.writeFile(OUT, json);
        emit log_named_string("fixture written", OUT);
    }

    /// Round-trip each commitment through the live contract, so the hash in the
    /// fixture is provably the one commit()/reveal() agree on -- including for
    /// negative ticks, which reveal() scores fine even though the pool never
    /// trades there.
    function _proveCommitments() internal returns (string memory json) {
        int24[5] memory ticks =
            [int24(164_600), int24(137_800), int24(0), int24(-887_200), int24(-1)];
        bytes32[5] memory salts = [
            bytes32(uint256(1)),
            keccak256("salt-two"),
            bytes32(type(uint256).max),
            keccak256("negative"),
            bytes32(0)
        ];
        address[5] memory whos = [alice, bob, carol, alice, bob];

        uint256 n = 4; // leave room before the first commit block
        for (uint256 k = 0; k < ticks.length; k++) {
            bytes32 h = _hash(ticks[k], salts[k], whos[k]);

            _toBlock(n);
            vm.prank(whos[k]);
            hook.commit(h); // reverts if the hash is malformed
            _toBlock(n + 2);
            hook.poke();
            _reveal(whos[k], n, ticks[k], salts[k]); // reverts unless the hash matches
            playedBlocks.push(n);

            json = string.concat(
                json,
                "  {",
                '"tick": "', _i(ticks[k]), '",',
                '"salt": "', vm.toString(salts[k]), '",',
                '"sender": "', vm.toString(whos[k]), '",',
                '"hash": "', vm.toString(h), '",',
                '"blockId": "', _u(n), '",',
                '"target": "', _i(hook.targetTick(n)), '",',
                '"dist": "', _u(_absDiff(ticks[k], hook.targetTick(n))), '"',
                k + 1 < ticks.length ? "},\n" : "}\n"
            );

            n += 4; // next lifecycle, clear of this one's reveal window
        }
    }

    /// targetTickRaw is `int24(diff / int256(BLOCK_TIME))`. Solidity's signed
    /// division truncates toward zero; JavaScript's BigInt division does too,
    /// but Math.floor does NOT, and would sit one tick low for any non-integral
    /// negative average.
    ///
    /// Ticks are deeply positive at this pool's prices, so no fixture taken from
    /// live boundary cumulatives can ever exercise the negative branch — the
    /// price would have to rise ~10^7x first. The table below therefore uses the
    /// contract's exact expression over hand-picked diffs, which is what pins
    /// the two languages' rounding against each other. `targets` separately ties
    /// that expression back to the real targetTickRaw() for observed blocks, so
    /// the copied expression cannot drift from the function it stands in for.
    function _signedDiv() internal pure returns (string memory s) {
        int256[14] memory diffs = [
            int256(0), 1, 599, 600, 601, 1_200, 98_760_000,
            -1, -599, -600, -601, -700, -1_199, -98_760_001
        ];
        for (uint256 k = 0; k < diffs.length; k++) {
            int24 result = int24(diffs[k] / int256(uint256(600)));
            s = string.concat(
                s,
                '  {"diff": "', _i(diffs[k]), '", "tick": "', _i(result), '"}',
                k + 1 < diffs.length ? ",\n" : "\n"
            );
        }
    }

    /// Real boundary cumulatives and the real targetTickRaw() they produce.
    function _targets(uint256[] memory ns) internal view returns (string memory s) {
        for (uint256 k = 0; k < ns.length; k++) {
            uint256 n = ns[k];
            s = string.concat(
                s,
                '  {"n": "', _u(n), '",',
                '"cumAtN1": "', _i(hook.boundaryCum(n + 1)), '",',
                '"cumAtN2": "', _i(hook.boundaryCum(n + 2)), '",',
                '"targetRaw": "', _i(hook.targetTickRaw(n)), '"}',
                k + 1 < ns.length ? ",\n" : "\n"
            );
        }
    }

    /// Two revealers, same tick, same block: distances are equal, so the winner
    /// is decided purely by keccak(sender, blockId, target). Reading the result
    /// back off the contract is the only way to test the tie rule without
    /// re-implementing it.
    ///
    /// Called twice with the reveal order swapped. The contract's whole reason
    /// for hashing addresses instead of taking first-revealer is that the winner
    /// must not depend on ordering, so the two runs are what actually pins the
    /// rule: if either the contract or the TypeScript replay quietly used reveal
    /// order, the two fixtures would disagree.
    function _proveTie(uint256 n, address first, address second)
        internal
        returns (string memory)
    {
        int24 tick = 150_000;
        bytes32 saltA = keccak256("tie-a");
        bytes32 saltB = keccak256("tie-b");

        _toBlock(n);
        _commit(first, tick, saltA);
        _commit(second, tick, saltB);

        _toBlock(n + 2);
        hook.poke();
        _reveal(first, n, tick, saltA);
        _reveal(second, n, tick, saltB);

        playedBlocks.push(n);
        int24 target = hook.targetTick(n);
        address winner = _winnerOf(n);
        assertTrue(winner == first || winner == second, "tie winner must be a revealer");

        return string.concat(
            "  {",
            '"blockId": "', _u(n), '",',
            '"tick": "', _i(tick), '",',
            '"target": "', _i(target), '",',
            '"revealOrder": ["', vm.toString(first), '", "', vm.toString(second), '"],',
            '"winner": "', vm.toString(winner), '"',
            "}"
        );
    }
}
