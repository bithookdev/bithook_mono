// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console} from "forge-std/console.sol";

import {BithookHarness} from "../Bithook.t.sol";
import {Bithook, BithookMiningHook} from "../../src/Bithook.sol";

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
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";

/// Agent-based economic simulation of a full Bithook launch.
///
/// Runs the REAL contracts — no mocks, no reimplemented economics. Every
/// commit, reveal, claim, swap, burn and unlock is an actual call against the
/// hook that would ship, so anything this reports is a property of the code
/// rather than of a model of it.
///
/// Inert under plain `forge test`: skips unless SIM_RUN=1.
///
///   SIM_RUN=1 forge test --match-contract BithookSim -vv
///   SIM_RUN=1 SIM_DAYS=365 forge test --match-contract BithookSim -vv
///
/// Against the live mainnet PoolManager rather than a locally compiled one:
///
///   SIM_RUN=1 forge test --fork-url "$MAINNET_RPC_URL" \
///     --fork-block-number <pinned> --match-contract BithookSim -vv
///
/// Everything except the PoolManager is fork-local, so the pool id is fresh
/// and no mainnet state is touched.
///
/// FORK COST, MEASURED. Every storage slot this run touches on the live
/// PoolManager for the first time is an RPC round-trip. Against a public
/// endpoint that is roughly four orders of magnitude slower than local: one
/// simulated day did not finish in ten minutes, where the local build does a
/// day in ~1.5s and a full year in minutes. Pin --fork-block-number so
/// Foundry can reuse its on-disk slot cache between runs, point it at a local
/// node, and keep forked runs SHORT (SIM_DAYS=1) — they exist to confirm the
/// deployed PoolManager bytecode behaves identically, not to carry the
/// long-horizon economics.
///
/// It does behave identically, and that is now checked over a span that
/// crosses two halvings rather than a single smoke day. At SIM_SEED=1 over 23
/// simulated days the forked and local runs produce BYTE-IDENTICAL reports --
/// same discovered tick, final tick, supply, burns, commits, reveals, claims
/// and stake unlocks -- with one expected exception: total miner gas differs
/// by 0.005% (3 gas per commit/reveal), because Uniswap ships the deployed
/// PoolManager with a far higher optimizer-runs setting than this repo builds
/// with, making it marginally cheaper to call. So the local build's gas
/// figures very slightly OVERSTATE real mainnet cost.
///
/// Getting there required zeroing the routers' balances after deployment; see
/// the note in setUp. Before that, forked runs silently diverged.
contract BithookSim is BithookHarness {
    using StateLibrary for IPoolManager;

    address constant MAINNET_MANAGER = 0x000000000004444c5dc75cB358380D2e3dE08A90;

    // ---------------------------------------------------------------
    // Configuration (env-overridable)
    // ---------------------------------------------------------------
    uint256 SIM_DAYS;
    uint256 N_FORECASTERS;
    uint256 N_GRIDDERS;
    uint256 GRID_WIDTH;
    uint256 N_TRADERS;
    uint256 TRADER_ETH;     // wei of starting capital per trader
    uint256 TRADES_PER_STEP; // max trades per sub-step; this sets VOLUME
    uint256 WARMUP_HOURS;   // trading-only window before startMining()
    uint256 GAS_GWEI;
    uint256 SEED;
    uint256 SAMPLE_EVERY;
    string OUT;

    bool onFork;
    uint256 rng;

    // ---------------------------------------------------------------
    // Agents
    // ---------------------------------------------------------------
    uint8 constant KIND_FORECASTER = 0;
    uint8 constant KIND_GRIDDER = 1;

    struct Operator {
        uint8 kind;
        uint32 noise;       // forecast error scale, in ticks
        uint32 first;       // index into minerAddrs
        uint32 count;       // addresses controlled
        uint32 blocksWon;
        uint256 rewardWon;
        uint256 gasUsed;
        uint256 revealMisses;
    }

    Operator[] operators;
    address[] minerAddrs;
    address[] traders;
    mapping(address => uint32) ownerOfAddr;

    // Pending commitments, keyed by block-slot AND address. A miner has up to
    // three commitments in flight at once (blocks n, n+1, n+2), so per-address
    // state would clobber itself every block. Ring depth 4 > the 3-block
    // pipeline; the slot for n is cleared at n and read at n+2, and
    // n % 4 != (n+2) % 4, so nothing is overwritten before it is revealed.
    mapping(uint256 => address[]) committersRing;                 // key: n % 4
    mapping(uint256 => mapping(address => int24)) pendingTick;    // key: n % 4
    mapping(uint256 => mapping(address => bytes32)) pendingSalt;  // key: n % 4

    uint256 lastSweptSlice = type(uint256).max;

    // ---------------------------------------------------------------
    // Counters
    // ---------------------------------------------------------------
    uint256 commits;
    uint256 reveals;
    uint256 revealFails;
    uint256 claims;
    uint256 buys;
    uint256 sells;
    uint256 buyFails;
    uint256 sellFails;
    uint256 corridorReverts;
    uint256 emptyBlocks;
    uint256 stakeSkips;
    uint256 earlyExits;
    uint256 ethIn;
    uint256 ethOut;
    /// Miner gas, measured with vm.lastCallGas() — the CALLEE frame only.
    /// A gasleft() bracket in the caller is wrong here: the whole year runs in
    /// one Solidity call frame whose free-memory pointer never resets, and
    /// memory expansion is quadratic, so a gasleft() delta charges every
    /// commit for the harness's own accumulated allocations. That artifact
    /// inflated the measured cost ~8x by day 360 (157k/op at day 40 rising to
    /// 949k/op at day 360, for two O(1) functions).
    uint256 minerGas;
    int24 minTickSeen;
    int24 maxTickSeen;
    /// Snapshot of the pre-mining trading window, so mining-phase figures can
    /// be read net of it.
    int24 warmupTick;
    uint256 warmupBuys;
    uint256 warmupSells;
    uint256 warmupEthIn;
    uint256 warmupFeeEth;
    uint256 warmupFeeToken;
    /// Halving verification state.
    uint256 eraSeen;
    uint256 prevEraReward;
    uint256 erasCrossed;
    uint256 stakesReclaimed;
    /// On a fork the live PoolManager already holds thousands of ETH for every
    /// other mainnet pool, so only the delta since setUp is ours.
    uint256 managerEthBaseline;

    modifier onlySim() {
        if (vm.envOr("SIM_RUN", uint256(0)) == 0) {
            vm.skip(true);
            return;
        }
        _;
    }

    // ===============================================================
    // Setup
    // ===============================================================
    function setUp() public override {
        if (vm.envOr("SIM_RUN", uint256(0)) == 0) return;

        SIM_DAYS      = vm.envOr("SIM_DAYS", uint256(365));
        N_FORECASTERS = vm.envOr("SIM_FORECASTERS", uint256(60));
        N_GRIDDERS    = vm.envOr("SIM_GRIDDERS", uint256(6));
        GRID_WIDTH    = vm.envOr("SIM_GRID_WIDTH", uint256(12));
        N_TRADERS     = vm.envOr("SIM_TRADERS", uint256(300));
        TRADER_ETH    = vm.envOr("SIM_TRADER_ETH", uint256(2 ether));
        TRADES_PER_STEP = vm.envOr("SIM_TRADES_PER_STEP", uint256(5));
        WARMUP_HOURS  = vm.envOr("SIM_WARMUP_HOURS", uint256(24));
        GAS_GWEI      = vm.envOr("SIM_GAS_GWEI", uint256(1));
        SEED          = vm.envOr("SIM_SEED", uint256(1));
        SAMPLE_EVERY  = vm.envOr("SIM_SAMPLE_EVERY", uint256(144)); // daily
        OUT           = vm.envOr("SIM_OUT", string("sim-out/run.csv"));
        rng = uint256(keccak256(abi.encodePacked("bithook-sim", SEED)));

        onFork = (block.chainid == 1 && MAINNET_MANAGER.code.length > 0);

        // Fork-safe actors: makeAddr() labels collide with live mainnet code.
        owner = address(0x0FF1CE);
        alice = address(0xA11CE);
        bob = address(0xB0B);
        carol = address(0xCA401);
        attacker = address(0xBAD);

        if (onFork) {
            manager = PoolManager(payable(MAINNET_MANAGER));
        } else {
            manager = new PoolManager(address(this));
        }
        swapRouter = new PoolSwapTest(IPoolManager(address(manager)));
        lpRouter = new PoolModifyLiquidityTest(IPoolManager(address(manager)));
        // A freshly deployed contract can land on an address that ALREADY
        // holds ETH on mainnet, and PoolSwapTest refunds its whole balance to
        // the caller after every swap -- so on a fork the first trader pockets
        // that windfall, their balance shifts, and every later trade size
        // (drawn as _rand(balance / 8)) diverges from the local run. Measured:
        // the router landed on 577,021,548,053,172 wei of pre-existing dust,
        // which was the entire fork-vs-local discrepancy. Zero them so the two
        // runs are comparable.
        vm.deal(address(swapRouter), 0);
        vm.deal(address(lpRouter), 0);

        token = new Bithook(owner);

        // Deploy the hook the way the LAUNCH does — mine a salt whose address
        // carries the permission flags, then CREATE2 — rather than with the
        // deployCodeTo cheatcode the other suites use. deployCodeTo writes
        // bytecode straight to an address it is handed, which both assumes the
        // flag bits it should be deriving and bypasses EIP-170 entirely; the
        // hook was 270 bytes oversize for a while and no test noticed. Mining
        // ~16k salts costs ~30ms, which is nothing against a run of this size.
        bytes memory ctorArgs = abi.encode(IPoolManager(address(manager)), token, owner);
        (address hookAddr, bytes32 salt) = HookMiner.find(
            address(this), HOOK_FLAGS, type(BithookMiningHook).creationCode, ctorArgs
        );
        hook = new BithookMiningHook{salt: salt}(IPoolManager(address(manager)), token, owner);
        require(address(hook) == hookAddr, "hook address mismatch");
        require(address(hook).code.length <= 24_576, "hook exceeds EIP-170");
        // The token's constructor sets minter = msg.sender (this test), while
        // INITIAL_SUPPLY goes to `owner`. The handoff is ours to make.
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

        // v6.0 launch order: seed now, START MINING LATER. The live plan is a
        // 24h trading-only window between deploy and startMining(), so the
        // run must model it — mining then begins against a market-discovered
        // price instead of the artificial opening tick, and no era-1 emission
        // is burned into an empty market (the schedule is measured from
        // miningStart, not from deploy).
        vm.startPrank(owner);
        _seedProduction(hook, token);
        vm.stopPrank();

        minTickSeen = PRODUCTION_START_TICK;
        maxTickSeen = PRODUCTION_START_TICK;
        managerEthBaseline = address(manager).balance;

        _buildAgents();
    }

    /// Miner identities are OPERATORS, not addresses. A forecaster runs one
    /// address; a gridder runs GRID_WIDTH of them, because commit() is one per
    /// address per block — so spreading a grid genuinely costs that many
    /// separately funded identities and that many commit/reveal pairs. That is
    /// the mechanism the whole capital-weighting argument rests on, and it is
    /// simulated rather than assumed.
    function _buildAgents() internal {
        uint256 idx;

        for (uint256 i = 0; i < N_FORECASTERS; i++) {
            // Skill spread: best land ~120 ticks out, worst ~2000. The README
            // quotes ~780 as a realistic forecast error.
            uint32 noise = uint32(120 + _rand(1900));
            operators.push(Operator(KIND_FORECASTER, noise, uint32(idx), 1, 0, 0, 0, 0));
            _newMiner(idx++, operators.length - 1);
        }

        for (uint256 i = 0; i < N_GRIDDERS; i++) {
            operators.push(
                Operator(KIND_GRIDDER, 0, uint32(idx), uint32(GRID_WIDTH), 0, 0, 0, 0)
            );
            for (uint256 j = 0; j < GRID_WIDTH; j++) _newMiner(idx++, operators.length - 1);
        }

        for (uint256 i = 0; i < N_TRADERS; i++) {
            address t = address(uint160(0x200000 + i));
            require(t.code.length == 0, "trader address occupied");
            traders.push(t);
            vm.deal(t, TRADER_ETH / 2 + _rand(TRADER_ETH));
            vm.prank(t);
            token.approve(address(swapRouter), type(uint256).max);
        }
    }

    function _newMiner(uint256 idx, uint256 op) internal {
        address m = address(uint160(0x100000 + idx));
        require(m.code.length == 0, "miner address occupied");
        minerAddrs.push(m);
        ownerOfAddr[m] = uint32(op);
        vm.deal(m, 3 ether);
        vm.startPrank(m);
        token.approve(address(hook), type(uint256).max);
        token.approve(address(swapRouter), type(uint256).max);
        vm.stopPrank();
    }

    // ===============================================================
    // The run
    // ===============================================================
    function test_simulateLaunch() public onlySim {
        uint256 totalBlocks = (SIM_DAYS * 1 days) / BLOCK_TIME;
        _writeHeader();

        console.log("=== Bithook launch simulation ===");
        console.log(onFork ? "PoolManager: LIVE MAINNET FORK" : "PoolManager: local build");
        console.log("sim days:        ", SIM_DAYS);
        console.log("mining blocks:   ", totalBlocks);
        console.log("miner addresses: ", minerAddrs.length);
        console.log("operators:       ", operators.length);
        console.log("traders:         ", traders.length);
        console.log("warmup hours:    ", WARMUP_HOURS);
        console.log("");

        _runWarmup();

        eraSeen = type(uint256).max; // force a checkpoint on the first block

        for (uint256 n = 0; n < totalBlocks; n++) {
            uint256 base = hook.blockStart(n);

            _checkEra(n);

            // Early in the block: settle n-2, then commit for n.
            vm.warp(base + 60);
            if (n >= 2) _doReveals(n - 2);
            _doCommits(n);

            // Mid block: trading moves the price the TWAP will average.
            vm.warp(base + 300);
            _doTrades();

            // Late block: more flow, then maintenance.
            vm.warp(base + 540);
            _doTrades();
            _doKeepers(n);

            if (n % SAMPLE_EVERY == 0 || n == totalBlocks - 1) _sample(n);
        }

        _report(totalBlocks);
        _writeOperators();
    }

    /// Halving verification, asserted as the run crosses each era boundary.
    ///
    /// The schedule functions are all `pure` -- they never touch the
    /// PoolManager -- so these hold identically on a fork and locally. What a
    /// forked run adds is that the surrounding activity (claims, vests, stake
    /// unlocks, swaps) keeps working across the transition against the
    /// deployed v4 bytecode, which is why the same config is run both ways.
    function _checkEra(uint256 n) internal {
        uint256 era = hook.eraOf(n * BLOCK_TIME);
        if (era == eraSeen) return;

        uint256 reward = hook.scheduledBlockReward(n);
        uint256 stake = hook.stakeFor(n);
        uint256 vest = hook.vestDurationFor(n);
        (, uint256 eraStart, uint256 eraDur) = hook.eraAt(n * BLOCK_TIME);

        // Era k spans [ERA_ONE*(2^k - 1), ...) and lasts ERA_ONE * 2^k.
        assertEq(eraDur, hook.ERA_ONE() * (1 << era), "era duration doubles");
        assertEq(eraStart, hook.ERA_ONE() * ((1 << era) - 1), "era starts where the schedule says");

        // Stake tracks the reward at exactly STAKE_BPS, every era.
        assertEq(stake, (reward * hook.STAKE_BPS()) / 10_000, "stake is STAKE_BPS of the reward");

        // Vesting follows the era length until MAX_VEST caps it.
        uint256 maxVest = hook.MAX_VEST();
        assertEq(vest, eraDur > maxVest ? maxVest : eraDur, "vest is era length, capped");

        if (eraSeen != type(uint256).max) {
            // Total halves while duration doubles, so the PER-BLOCK reward
            // quarters. Allow 1 wei of integer-division slack.
            assertApproxEqAbs(reward * 4, prevEraReward, 4, "per-block reward quarters each era");
            assertLt(reward, prevEraReward, "and strictly decreases");
        }

        console.log("--- era transition ---");
        console.log("  era               ", era);
        console.log("  first block        ", n);
        console.log("  day                ", (n * BLOCK_TIME) / 1 days);
        console.log("  reward/block E18   ", reward / 1e18);
        console.log("  stake/block E18    ", stake / 1e18);
        console.log("  vest days          ", vest / 1 days);
        console.log("  supply E18         ", token.totalSupply() / 1e18);
        console.log("  locked stakes E18  ", hook.totalLockedStakes() / 1e18);

        eraSeen = era;
        prevEraReward = reward;
        erasCrossed++;
    }

    /// The trading-only window between seeding and startMining().
    ///
    /// Only swaps and fee burns are live here — every mining entry point
    /// reverts while miningStart is zero, and _accumulate() is a no-op, so the
    /// oracle carries nothing across the boundary. startMining() then adopts
    /// the live tick and zeroes tickCumulative, which is the point: mining
    /// begins on a price the market set rather than on the declared opening
    /// tick with no flow behind it.
    ///
    /// Flow density matches the mining phase exactly (two trade batches per
    /// ten-minute interval), so warm-up volume is comparable to a mining day.
    function _runWarmup() internal {
        if (WARMUP_HOURS == 0) {
            vm.prank(owner);
            hook.startMining();
            return;
        }

        uint256 t0 = block.timestamp;
        uint256 steps = (WARMUP_HOURS * 1 hours) / BLOCK_TIME;
        for (uint256 i = 0; i < steps; i++) {
            vm.warp(t0 + i * BLOCK_TIME + 300);
            _doTrades();
            vm.warp(t0 + i * BLOCK_TIME + 540);
            _doTrades();
        }
        vm.warp(t0 + WARMUP_HOURS * 1 hours);

        warmupTick = _spotTick();
        warmupBuys = buys;
        warmupSells = sells;
        warmupEthIn = ethIn;
        warmupFeeEth = hook.pendingEth();
        warmupFeeToken = hook.pendingToken();

        vm.prank(owner);
        hook.startMining();

        console.log("--- warmup (trading only, no mining) ---");
        console.log("hours:                ", WARMUP_HOURS);
        console.log("buys / sells:         ", warmupBuys, warmupSells);
        console.log("ETH bought:           ", warmupEthIn);
        console.log("opening tick:         ", vm.toString(int256(PRODUCTION_START_TICK)));
        console.log("discovered tick:      ", vm.toString(int256(warmupTick)));
        console.log("pending fee ETH:      ", warmupFeeEth);
        console.log("pending fee BITHOOK:  ", warmupFeeToken / 1e18);
        console.log("mining armed at tick: ", vm.toString(int256(hook.lastTick())));
        console.log("");
    }

    /// Per-operator ledger, so reward concentration and net-of-gas
    /// profitability can be analysed properly rather than eyeballed.
    function _writeOperators() internal {
        string memory path = string.concat(OUT, ".operators.csv");
        vm.writeFile(path, "operator,kind,addresses,noiseTicks,blocksWon,rewardWonE18,gasUsed,revealMisses\n");
        for (uint256 i = 0; i < operators.length; i++) {
            Operator storage op = operators[i];
            vm.writeLine(
                path,
                string.concat(
                    vm.toString(i), ",",
                    op.kind == KIND_GRIDDER ? "gridder" : "forecaster", ",",
                    vm.toString(uint256(op.count)), ",",
                    vm.toString(uint256(op.noise)), ",",
                    vm.toString(uint256(op.blocksWon)), ",",
                    vm.toString(op.rewardWon / 1e18), ",",
                    vm.toString(op.gasUsed), ",",
                    vm.toString(op.revealMisses)
                )
            );
        }
    }

    // ===============================================================
    // Miner behaviour
    // ===============================================================
    function _doCommits(uint256 n) internal {
        int24 spot = _spotTick();
        uint256 stake = hook.stakeFor(n);
        address[] storage ring = committersRing[n % 4];
        delete committersRing[n % 4];

        for (uint256 o = 0; o < operators.length; o++) {
            Operator storage op = operators[o];

            // Not everyone plays every block.
            if (op.kind == KIND_FORECASTER && _rand(100) < 35) continue;
            if (op.kind == KIND_GRIDDER && _rand(100) < 10) continue;

            for (uint256 k = 0; k < op.count; k++) {
                address m = minerAddrs[op.first + k];

                if (!_ensureStake(m, stake)) {
                    stakeSkips++;
                    continue;
                }

                int24 guess;
                if (op.kind == KIND_FORECASTER) {
                    guess = spot + int24(_signedRand(op.noise));
                } else {
                    // A grid straddling spot; the k-th address takes rung k.
                    int24 offset = int24(int256(k)) - int24(int256(uint256(op.count) / 2));
                    guess = spot + offset * 60 + int24(_signedRand(30));
                }

                bytes32 salt = bytes32(_next());
                vm.prank(m);
                try hook.commit(_hash(guess, salt, m)) {
                    uint256 used = uint256(vm.lastCallGas().gasTotalUsed) + 21_000;
                    op.gasUsed += used;
                    minerGas += used;
                    commits++;
                    pendingTick[n % 4][m] = guess;
                    pendingSalt[n % 4][m] = salt;
                    ring.push(m);
                } catch {}
            }
        }
    }

    function _doReveals(uint256 n) internal {
        if (!hook.targetAvailable(n)) {
            hook.poke();
            if (!hook.targetAvailable(n)) return;
        }

        address[] storage ring = committersRing[n % 4];
        for (uint256 i = 0; i < ring.length; i++) {
            address m = ring[i];
            Operator storage op = operators[ownerOfAddr[m]];

            // 1.5% of committers vanish before revealing — the liveness-bond
            // path burnUnrevealed() exists to sweep.
            if (_rand(1000) < 15) {
                op.revealMisses++;
                continue;
            }

            vm.prank(m);
            try hook.reveal(n, pendingTick[n % 4][m], pendingSalt[n % 4][m]) {
                uint256 used = uint256(vm.lastCallGas().gasTotalUsed) + 21_000;
                op.gasUsed += used;
                minerGas += used;
                reveals++;
            } catch {
                revealFails++;
            }
        }
    }

    /// A miner short of stake buys some. This is real endogenous buy pressure:
    /// mining REQUIRES holding the token, and the sim makes miners pay for it
    /// through the same pool everyone else trades against.
    function _ensureStake(address m, uint256 stake) internal returns (bool) {
        if (stake == 0) return true;
        if (token.balanceOf(m) >= stake) return true;
        if (m.balance < 0.02 ether) return false;

        // Buy ~40 blocks of inventory at a time to amortise swap gas.
        uint256 spend = _quoteEthFor(stake * 40);
        if (spend < 0.005 ether) spend = 0.005 ether;
        if (spend > m.balance / 3) spend = m.balance / 3;
        if (spend == 0) return false;

        _buy(m, spend);
        return token.balanceOf(m) >= stake;
    }

    // ===============================================================
    // Trading
    // ===============================================================
    /// Trade COUNT, not trader population, sets volume: raising SIM_TRADERS
    /// spreads the same flow over more wallets. Since the 1% fee burn is
    /// volume-driven, SIM_TRADES_PER_STEP is the knob that moves it.
    function _doTrades() internal {
        uint256 count = _rand(TRADES_PER_STEP);
        for (uint256 i = 0; i < count; i++) {
            address t = traders[_rand(traders.length)];
            uint256 bal = token.balanceOf(t);

            // Slight buy bias; sellers can only sell what they actually hold.
            bool wantBuy = _rand(100) < 52;

            if (wantBuy && t.balance > 0.02 ether) {
                uint256 size = 0.005 ether + _rand(t.balance / 8);
                _buy(t, size);
            } else if (bal > 1e18) {
                _sell(t, 1e18 + _rand(bal / 2));
            }
        }

        // Winners take profit: release what has vested and sell part of it.
        if (_rand(100) < 25) _harvestAndSell();
    }

    function _buy(address who, uint256 ethAmount) internal {
        if (ethAmount == 0 || who.balance < ethAmount) return;
        uint256 before = who.balance;
        vm.prank(who);
        try swapRouter.swap{value: ethAmount}(
            key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(ethAmount),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        ) {
            buys++;
            ethIn += before - who.balance;
            _trackTick();
        } catch (bytes memory reason) {
            buyFails++;
            if (_isCorridor(reason)) corridorReverts++;
        }
    }

    function _sell(address who, uint256 tokenAmount) internal {
        if (tokenAmount == 0 || token.balanceOf(who) < tokenAmount) return;
        uint256 before = who.balance;
        vm.prank(who);
        try swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: false,
                amountSpecified: -int256(tokenAmount),
                sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        ) {
            sells++;
            ethOut += who.balance - before;
            _trackTick();
        } catch (bytes memory reason) {
            sellFails++;
            if (_isCorridor(reason)) corridorReverts++;
        }
    }

    /// Pick a random miner, release what has vested, sell a slice of it.
    ///
    /// One in twelve harvests instead takes the impatient route: exitEarly()
    /// pays out the unvested remainder minus a 50% slash. Some winners really
    /// will trade half their tail for liquidity now, and without this the
    /// slash path — a deflationary sink the supply model depends on — would
    /// never execute in a year of simulated time.
    function _harvestAndSell() internal {
        address m = minerAddrs[_rand(minerAddrs.length)];
        uint256 c = hook.vestCount(m);
        if (c == 0) return;

        uint256 take = c > 12 ? 12 : c;
        uint256[] memory ids = new uint256[](take);
        for (uint256 i = 0; i < take; i++) ids[i] = c - take + i;

        if (_rand(12) == 0) {
            vm.prank(m);
            try hook.exitEarly(ids) { earlyExits++; } catch { return; }
        } else {
            vm.prank(m);
            try hook.unlockVested(ids) {} catch { return; }
        }

        uint256 bal = token.balanceOf(m);
        if (bal > 2e18 && _rand(100) < 60) _sell(m, bal / 2);
    }

    // ===============================================================
    // Keepers — the permissionless, unrewarded maintenance surface
    // ===============================================================
    function _doKeepers(uint256 n) internal {

        if (n >= 3) {
            uint256 settled = n - 3;
            (,,, address w,,,,,) = hook.blocks(settled);
            if (w != address(0)) {
                uint256 r = hook.scheduledBlockReward(settled);
                vm.prank(w);
                try hook.claimBlock(settled) {
                    claims++;
                    Operator storage op = operators[ownerOfAddr[w]];
                    op.blocksWon++;
                    op.rewardWon += r;
                } catch {}
            } else {
                try hook.finalizeBlock(settled) { emptyBlocks++; } catch {}
            }

            // Sweep forfeited stakes.
            try hook.burnUnrevealed(settled) {} catch {}
        }

        // Fee destruction, roughly hourly.
        if (n % 6 == 0) {
            try hook.burnFees() {} catch {}
            try hook.buybackAndBurn(0.5 ether) {} catch {}
        }

        // Stake reclamation, once per lock slice.
        _reclaimStakes();
    }

    function _reclaimStakes() internal {
        uint256 slice = hook.lockSliceAt(block.timestamp - hook.miningStart());
        if (slice < 2) return;
        uint256 due = slice - 2;
        if (lastSweptSlice != type(uint256).max && due <= lastSweptSlice) return;
        lastSweptSlice = due;

        for (uint256 i = 0; i < minerAddrs.length; i++) {
            vm.prank(minerAddrs[i]);
            try hook.unlockStakes(due) { stakesReclaimed++; } catch {}
        }
    }

    // ===============================================================
    // Metrics
    // ===============================================================
    function _writeHeader() internal {
        vm.writeFile(
            OUT,
            "day,block,era,tick,ethPerBithookE18,fdvMilliEth,poolEthWei,totalSupplyE18,"
            "lockedStakesE18,feeBurnedE18,buybackBurnedE18,stakeBurnedE18,slashedE18,"
            "commits,reveals,buys,sells,emptyBlocks,minerGas\n"
        );
    }

    function _sample(uint256 n) internal {
        int24 t = _spotTick();
        uint256 priceE18 = _ethPerBithookE18(t);

        string memory a = string.concat(
            vm.toString((n * BLOCK_TIME) / 1 days), ",",
            vm.toString(n), ",",
            vm.toString(hook.eraOf(n * BLOCK_TIME)), ",",
            vm.toString(int256(t)), ",",
            vm.toString(priceE18), ",",
            vm.toString((21_000_000 * priceE18) / 1e15), ",",
            vm.toString(_poolEth()), ","
        );
        string memory b = string.concat(
            vm.toString(token.totalSupply() / 1e18), ",",
            vm.toString(hook.totalLockedStakes() / 1e18), ",",
            vm.toString(hook.totalFeeBurned() / 1e18), ",",
            vm.toString(hook.totalBuybackBurned() / 1e18), ",",
            vm.toString(hook.totalBurnedStakes() / 1e18), ",",
            vm.toString(hook.totalSlashed() / 1e18), ","
        );
        string memory c = string.concat(
            vm.toString(commits), ",",
            vm.toString(reveals), ",",
            vm.toString(buys), ",",
            vm.toString(sells), ",",
            vm.toString(emptyBlocks), ",",
            vm.toString(minerGas)
        );
        vm.writeLine(OUT, string.concat(a, b, c));
    }

    function _report(uint256 totalBlocks) internal view {
        int24 t = _spotTick();
        uint256 priceE18 = _ethPerBithookE18(t);
        uint256 openPrice = _ethPerBithookE18(PRODUCTION_START_TICK);

        console.log("--- halvings ---");
        console.log("era transitions crossed:", erasCrossed > 0 ? erasCrossed - 1 : 0);
        console.log("final era:              ", eraSeen);
        console.log("stakes reclaimed:       ", stakesReclaimed);
        console.log("");

        console.log("--- market ---");
        console.log("opening tick:       ", vm.toString(int256(PRODUCTION_START_TICK)));
        console.log("final tick:         ", vm.toString(int256(t)));
        console.log("lowest tick seen:   ", vm.toString(int256(minTickSeen)));
        console.log("highest tick seen:  ", vm.toString(int256(maxTickSeen)));
        console.log("price x vs open:    ", priceE18 * 1000 / openPrice, "(per 1000)");
        console.log("FDV milliETH:       ", (21_000_000 * priceE18) / 1e15);
        console.log("ETH in pool (wei):  ", _poolEth());
        console.log("gross ETH in (wei): ", ethIn);
        console.log("gross ETH out (wei):", ethOut);
        console.log("");

        console.log("--- supply (BITHOOK) ---");
        console.log("totalSupply:        ", token.totalSupply() / 1e18);
        console.log("fee burned:         ", hook.totalFeeBurned() / 1e18);
        console.log("buyback burned:     ", hook.totalBuybackBurned() / 1e18);
        console.log("stakes burned:      ", hook.totalBurnedStakes() / 1e18);
        console.log("vest slashed:       ", hook.totalSlashed() / 1e18);
        console.log("locked stakes:      ", hook.totalLockedStakes() / 1e18);
        console.log("");

        console.log("--- activity ---");
        console.log("mining blocks:      ", totalBlocks);
        console.log("commits:            ", commits);
        console.log("reveals:            ", reveals);
        console.log("claims:             ", claims);
        console.log("blocks with no winner:", emptyBlocks);
        console.log("buys:               ", buys);
        console.log("sells:              ", sells);
        console.log("buy fails:          ", buyFails);
        console.log("sell fails:         ", sellFails);
        console.log("corridor reverts:   ", corridorReverts);
        console.log("stake-funding skips:", stakeSkips);
        console.log("reveal failures:    ", revealFails);
        console.log("early vest exits:   ", earlyExits);
        console.log("");

        console.log("--- miner economics ---");
        console.log("gas price assumed (gwei):", GAS_GWEI);
        console.log("total miner gas:    ", minerGas);
        uint256 gasCostWei = minerGas * GAS_GWEI * 1e9;
        console.log("miner gas cost (wei):", gasCostWei);
        uint256 wonValueWei = (_totalWon() * priceE18) / 1e18;
        console.log("rewards won at final px (wei):", wonValueWei);
        if (wonValueWei >= gasCostWei) {
            console.log("NET: profitable by (wei):", wonValueWei - gasCostWei);
        } else {
            console.log("NET: UNDERWATER by (wei):", gasCostWei - wonValueWei);
        }
        console.log("");

        _reportConcentration();
    }

    function _reportConcentration() internal view {
        uint256 total = _totalWon();
        if (total == 0) {
            console.log("--- concentration --- no blocks won");
            return;
        }

        uint256 best;
        uint256 bestIdx;
        uint256 gridTotal;
        uint256 gridWins;
        uint256 fcTotal;
        uint256 fcWins;
        for (uint256 i = 0; i < operators.length; i++) {
            if (operators[i].rewardWon > best) {
                best = operators[i].rewardWon;
                bestIdx = i;
            }
            if (operators[i].kind == KIND_GRIDDER) {
                gridTotal += operators[i].rewardWon;
                gridWins += operators[i].blocksWon;
            } else {
                fcTotal += operators[i].rewardWon;
                fcWins += operators[i].blocksWon;
            }
        }

        console.log("--- concentration ---");
        console.log("operators:              ", operators.length);
        console.log("top operator index:     ", bestIdx);
        console.log("top operator share (bps):", (best * 10_000) / total);
        console.log("gridder share (bps):    ", (gridTotal * 10_000) / total);
        console.log("forecaster share (bps): ", (fcTotal * 10_000) / total);
        console.log("gridder addresses:      ", N_GRIDDERS * GRID_WIDTH);
        console.log("forecaster addresses:   ", N_FORECASTERS);
        console.log("gridder blocks won:     ", gridWins);
        console.log("forecaster blocks won:  ", fcWins);
    }

    function _totalWon() internal view returns (uint256 total) {
        for (uint256 i = 0; i < operators.length; i++) total += operators[i].rewardWon;
    }

    // ===============================================================
    // Helpers
    // ===============================================================
    /// ETH this pool actually holds, net of anything the manager already had.
    function _poolEth() internal view returns (uint256) {
        uint256 b = address(manager).balance;
        return b > managerEthBaseline ? b - managerEthBaseline : 0;
    }

    function _trackTick() internal {
        int24 t = _spotTick();
        if (t < minTickSeen) minTickSeen = t;
        if (t > maxTickSeen) maxTickSeen = t;
    }

    /// ETH per BITHOOK, 18 decimals.
    /// currency0 is ETH and currency1 is BITHOOK, so sqrtPriceX96 encodes
    /// sqrt(BITHOOK per ETH). Invert, staged to stay inside uint256:
    ///   r = 2^96 * 1e9 / sqrt  ->  (r / 1e9)^2 ETH per BITHOOK  ->  * 1e18 = r^2
    function _ethPerBithookE18(int24 t) internal pure returns (uint256) {
        uint256 sq = uint256(TickMath.getSqrtPriceAtTick(t));
        uint256 r = ((uint256(1) << 96) * 1e9) / sq;
        return r * r;
    }

    /// Rough ETH needed to buy `want` BITHOOK at the current tick.
    function _quoteEthFor(uint256 want) internal view returns (uint256) {
        return (want * _ethPerBithookE18(_spotTick()) / 1e18) * 12 / 10;
    }

    function _isCorridor(bytes memory reason) internal pure returns (bool) {
        if (reason.length < 4) return false;
        bytes4 sel;
        assembly { sel := mload(add(reason, 0x20)) }
        return sel == bytes4(keccak256("PriceOutsideCorridor()"));
    }

    function _next() internal returns (uint256) {
        rng = uint256(keccak256(abi.encodePacked(rng)));
        return rng;
    }

    function _rand(uint256 mod) internal returns (uint256) {
        if (mod == 0) return 0;
        return _next() % mod;
    }

    /// Symmetric triangular draw in (-scale, +scale): small errors dominate.
    function _signedRand(uint256 scale) internal returns (int256) {
        if (scale == 0) return 0;
        return int256(_rand(scale)) - int256(_rand(scale));
    }
}
