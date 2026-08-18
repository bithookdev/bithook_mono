// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BithookTest} from "./Bithook.t.sol";
import {BithookMiningHook} from "../src/Bithook.sol";

/// Regression tests for the v5 audit's load-bearing findings. Each of these
/// reproduced a real bug before the fix; they now assert the fixed behaviour,
/// so a regression fails the suite rather than passing silently.
contract AuditV5Test is BithookTest {
    // ============================================================
    // T-01 — an oracle gap must be resumable, never permanent
    // ============================================================
    function test_T01_oracleRecoversImmediatelyAfterASilence() public {
        uint256 cap = hook.MAX_CHECKPOINTS();
        uint256 lastB = cap * 3;

        // a silence far longer than one call can cover
        _toBlock(lastB);
        hook.poke(); // ONE call

        // the recent window is available straight away -- the oracle fills
        // backwards from now, so it is never left parked in the past
        for (uint256 b = lastB - cap + 1; b <= lastB; b++) {
            assertTrue(hook.boundarySet(b), "recent boundary filled by a single call");
        }
        hook.targetTick(lastB - 2); // current blocks resolve with no catch-up
    }

    function test_T01_committerIsNeverBrickedByASilence() public {
        // commit() advances the accumulator, so any block someone actually
        // entered has its target window checkpointed -- the bricking scenario
        // requires nobody to be mining, in which case there is nobody to harm
        _toBlock(40);
        _commit(alice, 100, "a");
        uint256 balBefore = token.balanceOf(alice);

        _toBlock(42);
        hook.poke();
        assertTrue(hook.targetAvailable(40), "entrant's block is resolvable");

        vm.prank(alice);
        hook.reveal(40, 100, "a");
        balBefore; // the stake is locked rather than returned to the wallet
        assertEq(hook.lockedStake(alice, 0), hook.stakeFor(40), "stake recovered, not burned");
    }

    function test_T01_miningActivityKeepsTheOracleAlive() public {
        // commit() advances the accumulator, so an actively mined game does not
        // depend on a good-Samaritan poke() to stay resolvable
        _toBlock(5);
        _commit(alice, 100, "a");
        assertTrue(hook.boundarySet(5), "commit checkpointed the boundaries it crossed");
        _toBlock(9);
        _commit(bob, 100, "b");
        assertTrue(hook.boundarySet(9), "and keeps doing so as mining continues");
    }

    // ============================================================
    // T-02 — same-timestamp swaps must be visible to the oracle
    // ============================================================
    function test_T02_oracleTracksTheLiveTickWithinOneTimestamp() public {
        _toBlock(1);
        hook.poke();
        int24 base = _spotTick();

        _swap(attacker, true, -1 ether);
        int24 pushed = _spotTick();
        assertLt(pushed, base - 3000, "spot really moved");
        assertEq(hook.lastTick(), pushed, "oracle saw the swap despite the shared timestamp");

        // unwind in the same timestamp: the oracle must follow that too
        _swap(attacker, false, -int256(token.balanceOf(attacker) / 2));
        assertEq(hook.lastTick(), _spotTick(), "oracle tracks the pool exactly");
    }

    function test_T02_zeroDurationPushCannotPinTheTwap() public {
        _fund();
        _toBlock(B);
        int24 natural = _spotTick();

        int24 willPinAt;
        {
            uint256 snap = vm.snapshotState();
            _swap(attacker, true, -0.3 ether);
            willPinAt = _spotTick();
            vm.revertToState(snap);
        }
        _commit(attacker, willPinAt, "atk");
        _commit(alice, natural, "honest");

        // push and unwind inside one timestamp -- zero holding time
        _toBlock(B + 1);
        _swap(attacker, true, -0.3 ether);
        _swap(attacker, false, -int256(token.balanceOf(attacker) / 2));

        _toBlock(B + 2);
        hook.poke();
        int24 realised = hook.targetTick(B);

        // the transient price no longer dominates the average, so the attacker
        // is left holding a forecast that is worse than the honest one
        assertTrue(realised != willPinAt, "TWAP is not pinned to the attacker's number");
        assertLt(
            _absDiff(natural, realised), _absDiff(willPinAt, realised),
            "a zero-duration push does not move the average to where it points"
        );

        _reveal(alice, B, natural, "honest");
        _reveal(attacker, B, willPinAt, "atk");
        assertEq(_winnerOf(B), alice, "honest predictor wins");
    }

    // ============================================================
    // E-04 — a winner receives its block's reward without global accrual races
    // ============================================================
    function test_E04_blockZeroWinnerReceivesExactlyItsScheduledReward() public {
        int24 t = _spotTick();
        _toBlock(0);
        _commit(alice, t, "a");
        _toBlock(2);
        _reveal(alice, 0, t, "a");

        _toBlock(3);
        vm.prank(alice);
        hook.claimBlock(0);
        (uint128 vest,,,,) = hook.vestsOf(alice, 0);
        assertEq(uint256(vest), hook.scheduledBlockReward(0), "block 0 receives exactly R");
    }

    // ============================================================
    // E-01 — every entry now carries a non-refundable cost
    // ============================================================
    function test_E01_revealLocksTheStakeAndBurnsNothing() public {
        _toBlock(1);
        uint256 stake = hook.stakeFor(1);
        _commit(alice, 100, "a");

        _toBlock(3);
        uint256 balBefore = token.balanceOf(alice);
        uint256 supplyBefore = token.totalSupply();
        _reveal(alice, 1, 100, "a");

        assertEq(token.totalSupply(), supplyBefore, "a successful reveal burns nothing");
        assertEq(token.balanceOf(alice), balBefore, "and returns nothing yet");
        assertEq(hook.lockedStake(alice, 0), stake, "the whole stake is locked");
        assertEq(hook.totalLockedStakes(), stake);
    }

    function test_E01_lockedStakeComesBackInFullAtSliceUnlock() public {
        _toBlock(1);
        uint256 stake = hook.stakeFor(1);
        _commit(alice, 100, "a");
        _toBlock(3);
        _reveal(alice, 1, 100, "a");

        uint256 balBefore = token.balanceOf(alice);
        vm.expectRevert(BithookMiningHook.StakeStillLocked.selector);
        vm.prank(alice);
        hook.unlockStakes(0);

        // Slice 0 unlocks one slice after it ends (between 10% and 20% of
        // the era after the bet, depending on where in the slice it landed).
        vm.warp(hook.stakeUnlockTime(0));
        vm.prank(alice);
        hook.unlockStakes(0);
        assertEq(token.balanceOf(alice), balBefore + stake, "returned in full, no haircut");
        assertEq(hook.lockedStake(alice, 0), 0);
        assertEq(hook.totalLockedStakes(), 0);
    }

    /// v5.8: the lock is a fixed FRACTION of the halving period -- each era is
    /// cut into LOCK_SLICES_PER_ERA slices and a stake unlocks one slice after
    /// the slice it was placed in. So it is always 10-20% of that era.
    function test_E01_lockIsTenPercentOfTheHalvingPeriod() public view {
        uint256 slices = hook.LOCK_SLICES_PER_ERA();
        uint256 dur = hook.ERA_ONE();
        uint256 start;
        for (uint256 era = 0; era < 6; era++) {
            uint256 w = dur / slices;
            for (uint256 idx = 0; idx < slices; idx++) {
                uint256 slice = era * slices + idx;
                uint256 betAt = start + idx * w; // earliest bet in this slice
                uint256 lock = hook.stakeUnlockTime(slice) - (hook.miningStart() + betAt);
                assertLe(lock, 2 * w, "at most 20% of the halving period");
                assertGe(lock, w, "at least 10% of it");
            }
            start += dur;
            dur *= 2;
        }
    }

    /// The anti-grid property is now CAPITAL, not a fee. Keeping N bets alive
    /// across an era means owning N * (blocks in that era) BITHOOK and leaving
    /// it locked the whole time.
    function test_E01_gridWidthIsBoundedByCapitalNotByAFee() public {
        _toBlock(1);
        uint256 stake = hook.stakeFor(1);
        uint256 supplyBefore = token.totalSupply();

        for (uint256 i = 0; i < 20; i++) {
            _commit(address(uint160(0x1000 + i)), int24(int256(100 + i * 50)), bytes32(i));
        }
        _toBlock(3);
        for (uint256 i = 0; i < 20; i++) {
            _reveal(address(uint160(0x1000 + i)), 1, int24(int256(100 + i * 50)), bytes32(i));
        }
        assertEq(token.totalSupply(), supplyBefore, "blanketing burns nothing at all");
        assertEq(hook.totalLockedStakes(), 20 * stake, "it ties up capital instead");

        // era 1 is 7 days = 1,008 blocks, so one continuous bet-stream ties up
        // 1,008 * stake BITHOOK. At a 1% stake (~34.7 BITHOOK in era 1) that is
        // ~35,000 per stream, and a sustained 1,000-wide grid needs a fifth of
        // the entire supply even after its own winnings help pay for it.
        uint256 perStreamEra1 = 1_008 * stake;
        assertGt(perStreamEra1, 34_000e18, "~35k BITHOOK per continuous bet-stream");
        assertGt(1_000 * perStreamEra1, 21_000_000e18 / 5, "a 1,000-wide grid is >20% of supply");
    }

    function test_E01_honestSingleBetMinerPaysNothing() public {
        _toBlock(1);
        uint256 stake = hook.stakeFor(1);
        _commit(alice, 100, "a");
        _toBlock(3);
        uint256 supplyBefore = token.totalSupply();
        _reveal(alice, 1, 100, "a");
        assertEq(token.totalSupply(), supplyBefore, "no fee of any kind");
        assertEq(hook.lockedStake(alice, 0), stake, "only the wait");
    }

    // ============================================================
    // Blocks nobody bets on
    // ============================================================

    /// An empty block has no winner. Its scheduled issue is minted and burned
    /// when finalized, making the missed reward visible without rolling it on.
    function test_emptyBlockPaysNobodyAndBurnsItsEmission() public {
        _toBlock(10); // nobody commits to block 10
        _toBlock(13);

        assertEq(_winnerOf(10), address(0), "no winner");
        assertEq(_stakedOf(10), 0, "nothing was ever staked");

        uint256 supply = token.totalSupply();
        hook.finalizeBlock(10);
        assertEq(token.totalSupply(), supply, "visible mint and burn net to zero");

        // There are no forfeited stakes to burn separately.
        vm.expectRevert(BithookMiningHook.NothingToBurn.selector);
        hook.burnUnrevealed(10);
    }

    /// A long silence cannot brick anything: mining resumes on the next block
    /// somebody bets on, while each winner remains entitled to exactly its R.
    function test_miningResumesAfterALongSilenceAtTheScheduledReward() public {
        _toBlock(10);

        // 100 blocks with nobody playing at all
        _toBlock(110);
        assertEq(hook.currentBlock(), 110, "the schedule kept advancing");

        // Trading is irrelevant to emission; this buy only confirms that the
        // resumed market path and the accumulated schedule coexist normally.
        _swap(alice, true, -0.05 ether);

        // the next block plays normally
        hook.poke();
        _commit(alice, _spotTick(), "a");
        _toBlock(112);
        hook.poke();
        _reveal(alice, 110, _spotTick(), "a");
        _toBlock(113);
        assertEq(_winnerOf(110), alice, "the game just carries on");

        vm.prank(alice);
        hook.claimBlock(110);
        assertEq(_rewardOf(110), hook.scheduledBlockReward(110), "the silence adds no bonus");
    }

    /// A later swap automatically finalizes the latest settled empty block.
    /// Its scheduled reward is visibly issued and burned in that transaction.
    function test_unminedEmissionIsBurnedWithoutChangingSupply() public {
        uint256 supply = token.totalSupply();
        _toBlock(500); // 500 blocks, no participants
        _swap(alice, true, -0.05 ether);
        assertEq(token.totalSupply(), supply, "mint and burn are supply-neutral");
        assertTrue(_emissionFinalizedOf(497), "the latest settled empty block was burned");
    }

    // ============================================================
    // V-02 — a reward vests over the halving period it was mined in
    // ============================================================

    /// Era boundaries are now at days 7 / 21 / 49 / 105 / 217, i.e. blocks
    /// 1008 / 3024 / 7056 / 15120 / 31248.
    function test_V02_vestDurationTracksTheHalvingPeriod() public view {
        assertEq(hook.vestDurationFor(0), 7 days, "era 1");
        assertEq(hook.vestDurationFor(1_007), 7 days, "still era 1");
        assertEq(hook.vestDurationFor(1_008), 14 days, "era 2");
        assertEq(hook.vestDurationFor(3_024), 28 days, "era 3");
        assertEq(hook.vestDurationFor(7_056), 56 days, "era 4");
        assertEq(hook.vestDurationFor(15_120), 112 days, "era 5");
        // and it stops growing there rather than reaching decades
        assertEq(hook.vestDurationFor(31_248), 112 days, "era 6 is capped");
        assertEq(hook.vestDurationFor(1_000_000), 112 days, "still capped, forever");
    }

    /// The whole point: a later-era win is NOT fully liquid after 7 days any
    /// more, so a grid cannot recycle it into the next day's stakes as fast.
    function test_V02_lateEraRewardVestsOverTheLongerPeriod() public {
        uint256 n = 2_100; // comfortably inside era 3 -> 14-day vest
        // accrue AFTER time has passed: scheduleCap(0) is 0, so a buy at
        // elapsed 0 earmarks nothing
        _toBlock(n - 1);
        _swap(alice, true, -0.05 ether);
        _toBlock(n);
        int24 t = _spotTick();
        _commit(alice, t, "a");
        _toBlock(n + 2);
        hook.poke();
        _reveal(alice, n, t, "a");
        _toBlock(n + 3);
        vm.prank(alice);
        hook.claimBlock(n);

        (uint128 total,,, uint32 dur,) = hook.vestsOf(alice, 0);
        assertEq(dur, 14 days, "vests over era 3's length, not 7 days");
        assertGt(total, 0);

        uint256[] memory ids = new uint256[](1);
        // halfway through the schedule, half the reward is claimable
        vm.warp(block.timestamp + 7 days);
        assertApproxEqRel(hook.claimableVested(alice, ids), uint256(total) / 2, 0.01e18);

        // under the old fixed 7-day schedule it would have been fully liquid here
        vm.warp(block.timestamp + 7 days);
        assertEq(hook.claimableVested(alice, ids), total, "fully vested at 14 days");
    }

    // ============================================================
    // Exact-tick scoring — the former T-06 lattice was removed in v5.9
    // ============================================================

    function test_exactTickTargetEqualsTheRawTwap() public {
        _fund();
        _toBlock(B);
        _commit(alice, _spotTick(), "a");
        _toBlock(B + 2);
        hook.poke();
        assertEq(hook.targetTick(B), hook.targetTickRaw(B), "scoring uses the exact TWAP tick");
    }

    /// One tick of additional accuracy matters again: distinct price forecasts
    /// are not collapsed into the same protocol-defined bucket.
    function test_oneTickOfAccuracyDecidesTheWinner() public {
        _fund();
        _toBlock(B);
        int24 t = _spotTick();
        _commit(alice, t, "a");
        _commit(bob, t + 1, "b");

        _toBlock(B + 2);
        hook.poke();
        _reveal(bob, B, t + 1, "b");
        _reveal(alice, B, t, "a");
        assertEq(_winnerOf(B), alice, "the exact prediction beats a one-tick error");
    }

    /// The mechanism must still TRACK the price: a real, sustained move across
    /// the target window has to move the answer, or the game is inert.
    function test_aRealSustainedMoveStillMovesTheTarget() public {
        _fund();
        _toBlock(B);
        int24 before = _spotTick();
        _commit(alice, before, "a");

        // a large move made EARLY in the target window and left there
        _toBlock(B + 1);
        _swap(attacker, true, -2 ether);

        _toBlock(B + 2);
        hook.poke();
        assertTrue(
            hook.targetTick(B) != before,
            "a percent-scale sustained move still changes the answer"
        );
    }

    // ============================================================
    // T-10 (audit L-2) — the lock follows the BET's era, not the reveal's
    // ============================================================

    /// Era boundaries fall on exact block multiples and a reveal is always two
    /// blocks later, so bets in the last two blocks of an era used to spill
    /// into the next bucket and lock for far longer than documented.
    function test_T10_stakeLocksToTheBetSliceNotTheRevealSlice() public {
        uint256 n = 1_006; // last blocks of era 1; the reveal lands in era 2
        uint256 betSlice = hook.lockSliceAt(n * hook.BLOCK_TIME());
        uint256 revealSlice = hook.lockSliceAt((n + 2) * hook.BLOCK_TIME());
        assertTrue(betSlice != revealSlice, "the bet and the reveal are in different slices");

        _toBlock(n);
        int24 t = _spotTick();
        _commit(alice, t, "a");
        _toBlock(n + 2);
        hook.poke();
        _reveal(alice, n, t, "a");

        assertEq(hook.lockedStake(alice, betSlice), hook.stakeFor(n), "locked to the BET's slice");
        assertEq(hook.lockedStake(alice, revealSlice), 0, "not the reveal's");
    }

    // ============================================================
    // V-03 — the early-exit slash is a real, visible burn
    // ============================================================

    function test_V03_earlyExitSlashIsAVisibleBurn() public {
        _fund();
        _playBlock(B, alice, _spotTick(), "a");
        _toBlock(B + 3);
        vm.prank(alice);
        hook.claimBlock(B);

        (uint128 total,,,,) = hook.vestsOf(alice, 0);
        assertGt(total, 0);

        uint256 supplyBefore = token.totalSupply();
        uint256 slashedBefore = hook.totalSlashed();
        uint256 aliceBefore = token.balanceOf(alice);
        // the hook legitimately holds pending fees and locked stakes; what
        // matters is that the mint->burn round trip leaves that untouched
        uint256 hookBefore = token.balanceOf(address(hook));

        uint256[] memory ids = new uint256[](1);
        vm.prank(alice);
        hook.exitEarly(ids); // fully unvested: 50% out, 50% slashed

        uint256 got = token.balanceOf(alice) - aliceBefore;
        uint256 slashed = hook.totalSlashed() - slashedBefore;

        assertEq(got, uint256(total) / 2, "half is paid out");
        assertEq(slashed, uint256(total) - got, "the rest is slashed");

        // the burn is REAL: supply rose by only the paid half, because the
        // slashed half was minted and then destroyed. Under the old
        // never-mint version the arithmetic is the same -- what differs is
        // that a Transfer to 0x0 was emitted, which explorers render.
        assertEq(token.totalSupply(), supplyBefore + got, "net supply effect unchanged");
        assertEq(
            token.balanceOf(address(hook)), hookBefore,
            "the slashed tokens pass straight through the hook and are destroyed"
        );
    }

    /// The reason the burn is safe to add: the allocation was already spent at
    /// claim time, so a slashed reward can never be re-minted by any path.
    function test_V03_slashedSupplyCanNeverComeBack() public {
        _fund();
        _playBlock(B, alice, _spotTick(), "a");
        _toBlock(B + 3);
        vm.prank(alice);
        hook.claimBlock(B);

        uint256[] memory ids = new uint256[](1);
        vm.prank(alice);
        hook.exitEarly(ids);

        (,,,, bool exited) = hook.vestsOf(alice, 0);
        assertTrue(exited, "the slashed remainder cannot be unlocked later");
        vm.prank(alice);
        vm.expectRevert(BithookMiningHook.AlreadyClaimed.selector);
        hook.claimBlock(B);
        assertLe(token.totalSupply(), token.MAX_SUPPLY(), "and the cap still holds");
    }
}
