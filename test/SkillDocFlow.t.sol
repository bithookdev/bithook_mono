// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

/**
 * Pins the published agent instructions (apps/web/public/SKILL.md) to the
 * deployed contract.
 *
 * That document tells third-party agents the exact commitment encoding and the
 * exact reveal window. Both are silent failure modes: a wrong `encodePacked`
 * field order or an off-by-one window produces a commitment that can never be
 * revealed, and the deposit is burned with no recovery path. Prose describing a
 * contract drifts from the contract; this executes the documented steps against
 * the real mainnet bytecode so the doc cannot rot unnoticed.
 *
 * Run against a mainnet fork:
 *   forge test --match-contract SkillDocFlow --fork-url <rpc>
 */
interface IHook {
    function owner() external view returns (address);
    function startMining() external;
    function miningStart() external view returns (uint256);
    function currentBlock() external view returns (uint256);
    function blockStart(uint256 n) external view returns (uint256);
    function stakeFor(uint256 n) external pure returns (uint256);
    function commit(bytes32 h) external;
    function reveal(uint256 n, int24 tick, bytes32 salt) external;
    function entries(uint256 n, address who)
        external
        view
        returns (bytes32 commitment, int24 tick, bool revealed);
    function targetAvailable(uint256 n) external view returns (bool);
    function targetTick(uint256 n) external view returns (int24);
    function claimBlock(uint256 n) external;
    function lastTick() external view returns (int24);
    function poke() external;
    function blocks(uint256 n)
        external
        view
        returns (
            uint128 stakedTotal,
            uint128 returnedTotal,
            uint128 reward,
            address winner,
            uint32 bestDist,
            bytes32 bestTiebreak,
            bool emissionFinalized,
            bool claimed,
            bool burned
        );
}

interface IToken {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

contract SkillDocFlowTest is Test {
    IHook constant HOOK = IHook(0x65DeBe0205E7c5395FBD31c894eb96AD1c92da44);
    IToken constant TOKEN = IToken(0x386c4CB30d2861AdB02eCBdFEA76f6a67eD2cddC);

    address miner = makeAddr("skill-doc-miner");

    function setUp() public {
        if (HOOK.miningStart() == 0) {
            vm.prank(HOOK.owner());
            HOOK.startMining();
        }
        deal(address(TOKEN), miner, 10_000e18);
    }

    /// The exact sequence SKILL.md tells an agent to run, in order.
    function test_documentedFlow() public {
        // --- Step 1: approve the deposit --------------------------------
        vm.prank(miner);
        TOKEN.approve(address(HOOK), type(uint256).max);

        uint256 n = HOOK.currentBlock();
        uint256 stake = HOOK.stakeFor(n);
        assertGt(stake, 0, "deposit must be non-zero");

        uint256 balBefore = TOKEN.balanceOf(miner);

        // --- Step 2: build the commitment -------------------------------
        // The documented encoding: keccak256(abi.encodePacked(int24, bytes32, address)).
        int24 tick = HOOK.lastTick();
        bytes32 salt = keccak256("a durable, reproducible salt");
        bytes32 h = keccak256(abi.encodePacked(tick, salt, miner));

        // The doc states this is exactly 55 bytes: 3 + 32 + 20.
        assertEq(abi.encodePacked(tick, salt, miner).length, 55, "commitment preimage must be 55 bytes");

        // --- Step 3: commit ---------------------------------------------
        vm.prank(miner);
        uint256 g0 = gasleft();
        HOOK.commit(h);
        uint256 commitGas = g0 - gasleft();

        (bytes32 stored,, bool revealedFlag) = HOOK.entries(n, miner);
        assertEq(stored, h, "stored commitment must match the documented encoding");
        assertFalse(revealedFlag);
        assertEq(TOKEN.balanceOf(miner), balBefore - stake, "commit must take exactly stakeFor(n)");

        // --- Step 4: reveal, during block n+2 ----------------------------
        // The doc is explicit that reveal(n) is valid only while
        // currentBlock() == n + 2. Prove both halves of that claim.
        vm.warp(HOOK.blockStart(n + 1) + 1);
        HOOK.poke();
        vm.warp(HOOK.blockStart(n + 2) + 1);
        HOOK.poke();

        assertEq(HOOK.currentBlock(), n + 2, "reveal window is exactly block n+2");
        assertTrue(HOOK.targetAvailable(n), "targetAvailable(n) must be true inside the window");

        vm.prank(miner);
        uint256 g1 = gasleft();
        HOOK.reveal(n, tick, salt);
        uint256 revealGas = g1 - gasleft();

        (,, bool nowRevealed) = HOOK.entries(n, miner);
        assertTrue(nowRevealed, "reveal must succeed with the documented arguments");

        // --- Step 5: claim ----------------------------------------------
        vm.warp(HOOK.blockStart(n + 3) + 1);
        (,,, address winner,,,,,) = HOOK.blocks(n);
        assertEq(winner, miner, "sole revealer must be the winner");

        vm.prank(miner);
        HOOK.claimBlock(n);

        (,,,,,,, bool claimed,) = HOOK.blocks(n);
        assertTrue(claimed, "claimBlock must settle the block");

        emit log_named_uint("commit gas", commitGas);
        emit log_named_uint("reveal gas", revealGas);
        emit log_named_uint("pair total", commitGas + revealGas);
    }

    /**
     * Reveal cost depends on whether you take the lead, so a single number is
     * not honest on its own. A revealer who does not beat the standing best
     * writes less state than one who does. Both figures inform what SKILL.md
     * and the risk list publish.
     */
    function test_gasRangeForNonLeadingReveal() public {
        address other = makeAddr("skill-doc-miner-2");
        deal(address(TOKEN), miner, 10_000e18);
        deal(address(TOKEN), other, 10_000e18);
        vm.prank(miner);
        TOKEN.approve(address(HOOK), type(uint256).max);
        vm.prank(other);
        TOKEN.approve(address(HOOK), type(uint256).max);

        uint256 n = HOOK.currentBlock();
        int24 spot = HOOK.lastTick();
        bytes32 saltA = keccak256("A");
        bytes32 saltB = keccak256("B");

        vm.prank(miner);
        HOOK.commit(keccak256(abi.encodePacked(spot, saltA, miner)));
        // Deliberately far off, so this reveal cannot take the lead.
        int24 far = spot + 50_000;
        vm.prank(other);
        HOOK.commit(keccak256(abi.encodePacked(far, saltB, other)));

        vm.warp(HOOK.blockStart(n + 1) + 1);
        HOOK.poke();
        vm.warp(HOOK.blockStart(n + 2) + 1);
        HOOK.poke();

        // First reveal takes the lead from nothing.
        vm.prank(miner);
        uint256 g0 = gasleft();
        HOOK.reveal(n, spot, saltA);
        uint256 leadingGas = g0 - gasleft();

        // Second reveal loses and writes less.
        vm.prank(other);
        uint256 g1 = gasleft();
        HOOK.reveal(n, far, saltB);
        uint256 losingGas = g1 - gasleft();

        emit log_named_uint("reveal gas (takes the lead)", leadingGas);
        emit log_named_uint("reveal gas (does not lead)", losingGas);
        assertLt(losingGas, leadingGas, "a non-leading reveal should write less state");
    }

    /// Reveal is rejected outside block n+2 — the doc's headline failure mode.
    function test_revealWindowIsExact() public {
        vm.prank(miner);
        TOKEN.approve(address(HOOK), type(uint256).max);

        uint256 n = HOOK.currentBlock();
        int24 tick = HOOK.lastTick();
        bytes32 salt = keccak256("window test");

        vm.prank(miner);
        HOOK.commit(keccak256(abi.encodePacked(tick, salt, miner)));

        // Too early: still inside block n.
        vm.prank(miner);
        vm.expectRevert();
        HOOK.reveal(n, tick, salt);

        // Too early: block n+1, the window the target is still forming over.
        vm.warp(HOOK.blockStart(n + 1) + 1);
        vm.prank(miner);
        vm.expectRevert();
        HOOK.reveal(n, tick, salt);

        // Too late: block n+3, after the window closed.
        vm.warp(HOOK.blockStart(n + 3) + 1);
        vm.prank(miner);
        vm.expectRevert();
        HOOK.reveal(n, tick, salt);
    }

    /// A wrong encodePacked field order is unrevealable — stated in the doc as
    /// the mistake that silently costs the deposit.
    function test_wrongFieldOrderIsUnrevealable() public {
        vm.prank(miner);
        TOKEN.approve(address(HOOK), type(uint256).max);

        uint256 n = HOOK.currentBlock();
        int24 tick = HOOK.lastTick();
        bytes32 salt = keccak256("wrong order");

        // salt, tick, sender — a plausible ordering, and wrong.
        vm.prank(miner);
        HOOK.commit(keccak256(abi.encodePacked(salt, tick, miner)));

        vm.warp(HOOK.blockStart(n + 1) + 1);
        HOOK.poke();
        vm.warp(HOOK.blockStart(n + 2) + 1);
        HOOK.poke();

        vm.prank(miner);
        vm.expectRevert();
        HOOK.reveal(n, tick, salt);
    }
}
