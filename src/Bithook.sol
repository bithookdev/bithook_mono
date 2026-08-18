// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title Bithook — block-mined token and Uniswap v4 hook
/// @notice One winner per ten-minute block: closest prediction to the next
///         block's BITHOOK/ETH TWAP receives that block's scheduled reward.
/// @dev Mining uses a three-block pipeline:
///      - N: commit keccak(tick, salt, sender) and lock a stake
///      - N+1: measure the TWAP target
///      - N+2: reveal; closest prediction wins
///
///      Revealed stakes unlock after 10–20% of their era; no-shows are burned.
///      Emission is time-only: era duration doubles while its allocation halves.
///      Rewards vest for an era, capped at MAX_VEST.
///
///      The launch is pump.fun's curve as two hook-owned Uniswap positions:
///      a bonding-curve band selling CURVE_TOKENS across a ~14.6x price rise,
///      then a tail band reaching the minimum usable tick, so the price has
///      no ceiling. Together they define an inclusive sqrt-price corridor.
///      Swaps and buybacks that would enter an empty-price void revert. External
///      liquidity changes are disabled.
///
///      Predictions are exact int24 ticks. Ties use a deterministic address
///      hash, which avoids reveal-order bias but can be address-grinded when the
///      target is predictable. See README.md for economics and design history.
///
///      The 1% hook fee is held as ERC-6909 claims and fully burned: BITHOOK
///      directly, ETH through buybackAndBurn. A zero maxEthIn spends all pending
///      ETH; a nonzero value caps the atomic purchase.

import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {BaseHook} from "v4-hooks-public/src/base/BaseHook.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SafeCast} from "@uniswap/v4-core/src/libraries/SafeCast.sol";
import {Position} from "@uniswap/v4-core/src/libraries/Position.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {FixedPoint96} from "@uniswap/v4-core/src/libraries/FixedPoint96.sol";

// Token
contract Bithook is ERC20 {
    uint256 public constant MAX_SUPPLY = 21_000_000e18;
    uint256 public constant INITIAL_SUPPLY = 10_500_000e18; // 50% — all of it goes into the seed

    address public minter;          // deployer, until finalizeMinter()
    bool public minterFinalized;

    error NotMinter();
    error MaxSupplyExceeded();
    error MinterAlreadyFinalized();
    error MinterNotFinalized();
    error ZeroAddress();

    constructor(address initialHolder) ERC20("Bithook", "BITHOOK", 18) {
        if (initialHolder == address(0)) revert ZeroAddress();
        _mint(initialHolder, INITIAL_SUPPLY);
        minter = msg.sender;
    }

    /// @notice One-shot: the deployer hands minting rights to the hook permanently.
    function finalizeMinter(address hook) external {
        if (msg.sender != minter) revert NotMinter();
        if (minterFinalized) revert MinterAlreadyFinalized();
        if (hook == address(0)) revert ZeroAddress();
        minter = hook;
        minterFinalized = true;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != minter) revert NotMinter();
        // The deployer is a handoff authority, never an active minter.
        if (!minterFinalized) revert MinterNotFinalized();
        if (totalSupply + amount > MAX_SUPPLY) revert MaxSupplyExceeded();
        _mint(to, amount);
    }

    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }
}

// Hook
contract BithookMiningHook is BaseHook {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using SafeCast for uint256;

    // Emission
    uint256 public constant TOTAL_MINING_SUPPLY = 10_500_000e18;

    // Pool configuration
    uint24 public constant POOL_LP_FEE = 0;
    int24 public constant POOL_TICK_SPACING = 200;
    /// Fixed production opening tick (~1.49 ETH FDV on the 21M cap — pump.fun's
    /// ~$4.5k start).
    int24 public constant SEED_START_TICK = 164_600;
    /// Where the bonding-curve band ends, 26,800 ticks below the open: a
    /// 14.58x price rise, pump.fun's start-to-graduation multiple.
    int24 public constant SEED_GRAD_TICK = 137_800;
    /// Bottom of the tail band: the minimum usable tick at spacing 200. The
    /// seed reaches it, so the price has NO ceiling; walking there would cost
    /// ~4e22 ETH, so in practice buys never run out of book.
    int24 public constant SEED_FLOOR_TICK = -887_200;
    /// Tokens sold on the curve band. The 80/20 split reproduces pump.fun's
    /// ~1.4x liquidity-density drop where their curve graduates into an AMM.
    uint256 public constant CURVE_TOKENS = 8_400_000e18;
    /// Maximum uint128-liquidity conversion dust across BOTH bands. Each floor
    /// division under-consumes by less than one granularity — the token-wei
    /// one liquidity unit spans: 2,768 on the curve band, 982 on the tail.
    uint256 public constant MAX_SEED_TOKEN_DUST = 4_000;

    // Hook fee
    /// Flat 1% hook fee; all proceeds are burned.
    uint256 public constant FEE_BPS = 100;

    // Mining
    uint256 public constant BLOCK_TIME = 10 minutes;
    /// Entry stake as a fraction of the scheduled block reward.
    uint256 public constant STAKE_BPS = 100;
    /// Length of the first halving period; every era after it doubles.
    uint256 public constant ERA_ONE = 7 days;
    /// Stakes unlock one slice after their placement slice: a 10–20% era lock.
    uint256 public constant LOCK_SLICES_PER_ERA = 10;
    /// Maximum reward vesting duration.
    uint256 public constant MAX_VEST = 112 days;
    /// Maximum boundaries checkpointed per call (5.3 hours at 10 minutes each).
    uint256 public constant MAX_CHECKPOINTS = 32;
    // Vesting
    uint256 public constant EXIT_SLASH_BPS = 5_000;

    /// unlockCallback payload discriminator.
    uint8 internal constant ACTION_BUYBACK = 0;
    uint8 internal constant ACTION_SEED = 1;
    uint8 internal constant ACTION_BURN_FEES = 2;

    Bithook public immutable token;
    address public immutable owner;

    PoolKey public poolKey;
    PoolId public poolId;
    bool public poolInitialized;
    uint256 public miningStart; // 0 = not started yet

    // Fee state
    /// ERC-6909 fee claims awaiting destruction.
    uint256 public pendingEth;
    uint256 public pendingToken;
    uint256 public totalFeeBurned;      // BITHOOK fees burned outright
    uint256 public totalBuybackBurned;  // BITHOOK bought with ETH fees and burned
    uint256 public totalBurnedStakes;
    /// user => lock slice => amount
    mapping(address => mapping(uint256 => uint256)) public lockedStake;
    uint256 public totalLockedStakes;

    // Seed positions
    /// The hook owns the pool's only two positions: the bonding-curve band
    /// [SEED_GRAD_TICK, SEED_START_TICK] and the tail band
    /// [SEED_FLOOR_TICK, SEED_GRAD_TICK]. Outer bounds are recorded here.
    int24 public seedLower;
    int24 public seedUpper;
    uint128 public curveLiquidity;
    uint128 public tailLiquidity;
    /// Cached inclusive corridor bounds; zero until seed().
    uint160 public seedSqrtLower;
    uint160 public seedSqrtUpper;

    // TWAP oracle
    int256 public tickCumulative;
    int24 public lastTick;
    uint64 public lastObsTs;
    mapping(uint256 => int256) public boundaryCum; // cumulative at block boundary i
    mapping(uint256 => bool) public boundarySet;

    // Mining state
    struct Entry {
        bytes32 commitment;
        int24 tick;
        bool revealed;
    }

    struct BlockData {
        uint128 stakedTotal;
        uint128 returnedTotal;
        uint128 reward;
        address winner;
        uint32 bestDist;
        bytes32 bestTiebreak;
        bool emissionFinalized;
        bool claimed;
        bool burned;
    }

    mapping(uint256 => mapping(address => Entry)) public entries;
    mapping(uint256 => BlockData) public blocks;

    // Vesting state
    struct VestEntry {
        uint128 total;
        uint128 released;
        uint64 start;
        /// Era-based duration, packed with start and exited.
        uint32 duration;
        bool exited;
    }

    mapping(address => VestEntry[]) public vestsOf;
    uint256 public totalSlashed;

    event Seeded(uint128 curveLiquidity, uint128 tailLiquidity, uint256 amount1);
    event MiningStarted(uint256 timestamp);
    event Checkpointed(uint256 indexed boundary, int256 cumulative);
    event Committed(uint256 indexed blockId, address indexed who);
    event Revealed(uint256 indexed blockId, address indexed who, int24 tick, uint32 dist);
    event StakeLocked(address indexed who, uint256 indexed slice, uint256 amount, uint256 unlockAt);
    event StakeUnlocked(address indexed who, uint256 indexed slice, uint256 amount);
    event BlockWon(uint256 indexed blockId, address indexed winner, uint256 reward, int24 targetTick);
    event StakesBurned(uint256 indexed blockId, uint256 amount);
    event HookFeeTaken(Currency indexed currency, uint256 amount);
    event FeesBurned(uint256 amount);
    event BoughtBackAndBurned(uint256 ethSpent, uint256 bithookBurned);
    event VestCreated(address indexed who, uint256 indexed id, uint256 amount);
    event Unlocked(address indexed who, uint256 amount);
    event EarlyExited(address indexed who, uint256 minted, uint256 slashed);

    error NotOwner();
    error AlreadyInitialized();
    error InvalidPoolKey();
    error UnauthorizedInitializer();
    error NotInitialized();
    error MiningAlreadyStarted();
    error MiningNotStarted();
    error NothingToUnlock();
    error NothingToBurn();
    error OnlyThisPool();
    error PoolNotSeeded();
    error MinterNotFinalizedToHook();
    error InitialSupplyExceeded();
    error BadEra();
    error NothingLocked();
    error StakeStillLocked();
    error PriceOutsideCorridor();
    error NativeOnlyFromPoolManager();
    error LiquidityFrozen();
    error AlreadySeeded();
    error InvalidSeedRange();
    error InvalidSeedFunding();
    error SeedRefundFailed();
    error UnknownAction();
    error RevealNotOpen();
    error AlreadyCommitted();
    error AlreadyRevealed();
    error NothingCommitted();
    error BadReveal();
    error TargetUnavailable();
    error BlockNotSettled();
    error NotWinner();
    error AlreadyClaimed();
    error AlreadyBurned();
    error NothingToBuyBack();
    error EmptyCommitment();

    constructor(IPoolManager _manager, Bithook _token, address _owner) BaseHook(_manager) {
        if (
            address(_manager) == address(0) || address(_token) == address(0)
                || _owner == address(0)
        ) revert InvalidPoolKey();
        token = _token;
        owner = _owner;
    }

    // Hook permissions
    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: true,
            beforeAddLiquidity: true,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: true,
            afterRemoveLiquidity: false,
            beforeSwap: false,
            afterSwap: true,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: true,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    // Initialization
    function _afterInitialize(address sender, PoolKey calldata key, uint160 sqrtPriceX96, int24 tick)
        internal
        override
        returns (bytes4)
    {
        if (poolInitialized) revert AlreadyInitialized();
        if (sender != owner) revert UnauthorizedInitializer();
        if (
            !key.currency0.isAddressZero() ||
            Currency.unwrap(key.currency1) != address(token) ||
            key.fee != POOL_LP_FEE ||
            key.tickSpacing != POOL_TICK_SPACING ||
            address(key.hooks) != address(this)
        ) revert InvalidPoolKey();
        if (
            tick != SEED_START_TICK
                || sqrtPriceX96 != TickMath.getSqrtPriceAtTick(SEED_START_TICK)
        ) revert InvalidSeedRange();

        poolKey = key;
        poolId = key.toId();
        poolInitialized = true;
        lastTick = tick;
        lastObsTs = uint64(block.timestamp);

        return this.afterInitialize.selector;
    }

    // Seed liquidity
    /// @notice Install the two launch bands. Owner-only, one-shot, before mining.
    /// @dev The geometry lives entirely on-chain: a bonding-curve band holding
    ///      CURVE_TOKENS from the opening tick down to SEED_GRAD_TICK, then a
    ///      tail band holding the rest down to SEED_FLOOR_TICK. Band liquidity
    ///      is derived here from the token amounts, so the caller supplies
    ///      nothing but the full INITIAL_SUPPLY; conversion dust is refunded.
    function seed() external {
        if (msg.sender != owner) revert NotOwner();
        if (!poolInitialized) revert NotInitialized();
        if (miningStart != 0) revert MiningAlreadyStarted();
        if (curveLiquidity != 0) revert AlreadySeeded();

        // The upper-bound price makes both bands entirely BITHOOK.
        uint160 sqrtUpper = TickMath.getSqrtPriceAtTick(SEED_START_TICK);
        uint160 sqrtGrad = TickMath.getSqrtPriceAtTick(SEED_GRAD_TICK);
        uint160 sqrtLower = TickMath.getSqrtPriceAtTick(SEED_FLOOR_TICK);
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(poolId);
        if (sqrtPriceX96 != sqrtUpper) revert InvalidSeedRange();

        // amount1 = L * (sqrtUpper - sqrtLower) / Q96 in v4's liquidity math,
        // so this floor division under-consumes each band by less than one
        // granularity; _installSeed enforces the combined dust bound.
        uint256 amount = token.INITIAL_SUPPLY();
        uint128 lCurve =
            FullMath.mulDiv(CURVE_TOKENS, FixedPoint96.Q96, sqrtUpper - sqrtGrad).toUint128();
        uint128 lTail = FullMath.mulDiv(
            amount - CURVE_TOKENS, FixedPoint96.Q96, sqrtGrad - sqrtLower
        ).toUint128();
        if (lCurve == 0 || lTail == 0) revert InvalidSeedRange();

        seedLower = SEED_FLOOR_TICK;
        seedUpper = SEED_START_TICK;
        curveLiquidity = lCurve;
        tailLiquidity = lTail;
        seedSqrtLower = sqrtLower;
        seedSqrtUpper = sqrtUpper;

        token.transferFrom(msg.sender, address(this), amount);
        poolManager.unlock(abi.encode(ACTION_SEED, abi.encode(lCurve, lTail)));

        // Before mining, any residual balance is seed conversion dust.
        uint256 dust = token.balanceOf(address(this));
        if (dust > 0) token.transfer(msg.sender, dust);
        if (address(this).balance > 0) {
            (bool ok,) = msg.sender.call{value: address(this).balance}("");
            if (!ok) revert SeedRefundFailed();
        }
    }

    /// @notice Irreversibly starts emission and block 0 after validating launch.
    function startMining() external {
        if (msg.sender != owner) revert NotOwner();
        if (!poolInitialized) revert NotInitialized();
        if (miningStart != 0) revert MiningAlreadyStarted();
        // Check both exact positions: active liquidity is zero at the upper
        // bound, so getLiquidity() cannot stand in for these.
        if (curveLiquidity == 0) revert PoolNotSeeded();
        bytes32 curveKey = Position.calculatePositionKey(
            address(this), SEED_GRAD_TICK, SEED_START_TICK, bytes32(0)
        );
        bytes32 tailKey = Position.calculatePositionKey(
            address(this), SEED_FLOOR_TICK, SEED_GRAD_TICK, bytes32(0)
        );
        if (
            poolManager.getPositionLiquidity(poolId, curveKey) != curveLiquidity
                || poolManager.getPositionLiquidity(poolId, tailKey) != tailLiquidity
        ) revert PoolNotSeeded();
        // Pre-start swaps are allowed, so require the corridor, not the open tick.
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(poolId);
        if (sqrtPriceX96 < seedSqrtLower || sqrtPriceX96 > seedSqrtUpper) {
            revert PriceOutsideCorridor();
        }
        // Mint authority is immutable after finalization; validate before start.
        if (!token.minterFinalized() || token.minter() != address(this)) {
            revert MinterNotFinalizedToHook();
        }
        // Permit pre-launch burns, never pre-launch supply growth.
        if (token.totalSupply() > token.INITIAL_SUPPLY()) revert InitialSupplyExceeded();
        miningStart = block.timestamp;
        // Adopt the live tick because pre-start swaps may have moved it.
        (, int24 tick0,,) = poolManager.getSlot0(poolId);
        lastTick = tick0;
        lastObsTs = uint64(block.timestamp);
        tickCumulative = 0;
        boundaryCum[0] = 0;
        boundarySet[0] = true;
        emit MiningStarted(block.timestamp);
    }

    // Sealed liquidity
    /// @dev Every call reaching these hooks is external; v4 skips them for the
    ///      hook's own seed call. Never add a self-call that removes liquidity.
    function _beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        internal
        pure
        override
        returns (bytes4)
    {
        revert LiquidityFrozen();
    }

    function _beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        internal
        pure
        override
        returns (bytes4)
    {
        revert LiquidityFrozen();
    }

    // Time-indexed blocks
    function blockStart(uint256 n) public view returns (uint256) {
        if (miningStart == 0) revert MiningNotStarted();
        return miningStart + n * BLOCK_TIME;
    }

    function currentBlock() public view returns (uint256) {
        if (miningStart == 0) revert MiningNotStarted();
        return (block.timestamp - miningStart) / BLOCK_TIME;
    }

    // Emission schedule
    /// @notice Mining allocation released by `elapsed` seconds after start.
    /// @dev Era duration doubles and each era emits half the remainder. Integer
    ///      precision eventually leaves a remote zero-reward tail.
    function scheduleCap(uint256 elapsed) public pure returns (uint256 cap) {
        uint256 remaining = TOTAL_MINING_SUPPLY;
        uint256 dur = ERA_ONE;
        while (true) {
            uint256 share = remaining / 2;
            if (share == 0) return cap; // dust floor, unreachable in practice
            if (elapsed < dur) return cap + (share * elapsed) / dur;
            cap += share;
            remaining -= share;
            elapsed -= dur;
            dur *= 2;
        }
    }

    /// @notice Era index (0-based) containing `elapsed`, and where it starts.
    ///         Era k spans [ERA_ONE*(2^k - 1), ERA_ONE*(2^(k+1) - 1)).
    function eraAt(uint256 elapsed)
        public
        pure
        returns (uint256 era, uint256 start, uint256 duration)
    {
        duration = ERA_ONE;
        while (elapsed >= duration) {
            elapsed -= duration;
            start += duration;
            duration *= 2;
            era++;
        }
    }

    /// @notice Emission the schedule earmarks for block n. Pure function of time.
    function scheduledBlockReward(uint256 n) public pure returns (uint256) {
        return scheduleCap((n + 1) * BLOCK_TIME) - scheduleCap(n * BLOCK_TIME);
    }

    /// @notice Stake required for block n: STAKE_BPS of its scheduled reward.
    function stakeFor(uint256 n) public pure returns (uint256) {
        return (scheduledBlockReward(n) * STAKE_BPS) / 10_000;
    }

    /// @notice Block reward vesting duration: its era length, capped at MAX_VEST.
    function vestDurationFor(uint256 n) public pure returns (uint32) {
        (,, uint256 duration) = eraAt(n * BLOCK_TIME);
        return uint32(duration > MAX_VEST ? MAX_VEST : duration);
    }

    /// @notice Era containing `elapsed` seconds since miningStart.
    function eraOf(uint256 elapsed) public pure returns (uint256 era) {
        (era,,) = eraAt(elapsed);
    }

    /// @notice Lock slice for a bet placed `elapsed` seconds after mining start.
    function lockSliceAt(uint256 elapsed) public pure returns (uint256) {
        (uint256 era, uint256 start, uint256 duration) = eraAt(elapsed);
        uint256 w = duration / LOCK_SLICES_PER_ERA;
        uint256 idx = (elapsed - start) / w;
        // Clamp defensively if the era constants stop dividing exactly.
        if (idx >= LOCK_SLICES_PER_ERA) idx = LOCK_SLICES_PER_ERA - 1;
        return era * LOCK_SLICES_PER_ERA + idx;
    }

    /// @notice Unlock time: the end of the slice following `slice`.
    function stakeUnlockTime(uint256 slice) public view returns (uint256) {
        if (miningStart == 0) revert MiningNotStarted();
        uint256 era = slice / LOCK_SLICES_PER_ERA;
        uint256 idx = slice % LOCK_SLICES_PER_ERA;
        uint256 duration = ERA_ONE;
        uint256 start;
        for (uint256 i = 0; i < era; i++) {
            start += duration;
            duration *= 2;
        }
        uint256 w = duration / LOCK_SLICES_PER_ERA;
        return miningStart + start + (idx + 2) * w;
    }

    /// @notice Era the current moment falls in.
    function currentEra() public view returns (uint256) {
        if (miningStart == 0) revert MiningNotStarted();
        return eraOf(block.timestamp - miningStart);
    }

    // TWAP checkpoints
    /// @notice Advance the oracle through any crossed block boundaries.
    function poke() external {
        _accumulate();
    }

    function _accumulate() internal {
        if (miningStart == 0) return;
        uint64 nowTs = uint64(block.timestamp);
        uint64 last = lastObsTs;
        (, int24 tick,,) = poolManager.getSlot0(poolId);

        // Multiple swaps may share a timestamp; always retain the latest tick.
        if (nowTs == last) {
            lastTick = tick;
            return;
        }

        // Between `last` and now the pool price never moved (no swap happened),
        // so every boundary in that span shares the same extrapolation.
        uint256 firstBoundary = ((uint256(last) - miningStart) / BLOCK_TIME) + 1;
        uint256 lastBoundary = (uint256(nowTs) - miningStart) / BLOCK_TIME;
        if (lastBoundary >= firstBoundary) {
            // Prioritize recent boundaries so one call restores a current oracle.
            uint256 startB = firstBoundary;
            if (lastBoundary - firstBoundary + 1 > MAX_CHECKPOINTS) {
                startB = lastBoundary - MAX_CHECKPOINTS + 1;
            }
            for (uint256 b = startB; b <= lastBoundary; b++) {
                if (boundarySet[b]) continue;
                uint256 bTs = miningStart + b * BLOCK_TIME;
                int256 cum = tickCumulative + int256(lastTick) * int256(bTs - uint256(last));
                boundaryCum[b] = cum;
                boundarySet[b] = true;
                emit Checkpointed(b, cum);
            }
        }

        tickCumulative += int256(lastTick) * int256(uint256(nowTs - last));
        lastTick = tick;
        lastObsTs = nowTs;
    }

    /// @notice Target for block n: the TWAP tick over block n+1.
    ///         Requires both bounding checkpoints to exist.
    function targetTick(uint256 n) public view returns (int24) {
        return targetTickRaw(n);
    }

    /// @notice Arithmetic-mean TWAP tick over block n+1.
    /// @dev Signed division rounds toward zero; clients must do the same.
    function targetTickRaw(uint256 n) public view returns (int24) {
        if (!boundarySet[n + 1] || !boundarySet[n + 2]) revert TargetUnavailable();
        int256 diff = boundaryCum[n + 2] - boundaryCum[n + 1];
        return int24(diff / int256(BLOCK_TIME));
    }

    function targetAvailable(uint256 n) public view returns (bool) {
        return boundarySet[n + 1] && boundarySet[n + 2];
    }

    // Swap oracle and fee
    function _afterSwap(
        address,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata
    ) internal override returns (bytes4, int128) {
        if (PoolId.unwrap(key.toId()) != PoolId.unwrap(poolId)) revert OnlyThisPool();

        // Empty ticks are traversable for free, so the oracle must stay inside
        // the seed corridor. Sqrt-price bounds are inclusive because v4's tick
        // can report lower - 1 after landing exactly on the lower boundary.
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(poolId);
        if (sqrtPriceX96 < seedSqrtLower || sqrtPriceX96 > seedSqrtUpper) {
            revert PriceOutsideCorridor();
        }

        // Charge the flat fee in the unspecified currency.
        bool specifiedIsZero = (params.amountSpecified < 0) == params.zeroForOne;
        Currency unspecified = specifiedIsZero ? key.currency1 : key.currency0;
        int128 unspecifiedAmount = specifiedIsZero ? delta.amount1() : delta.amount0();
        uint256 absUnspecified = unspecifiedAmount < 0
            ? uint256(uint128(-unspecifiedAmount))
            : uint256(uint128(unspecifiedAmount));
        uint256 fee = (absUnspecified * FEE_BPS) / 10_000;

        // Record the price that applied until this swap.
        _accumulate();
        // Only the latest eligible block is finalized to keep swap gas bounded.
        _autoFinalizeLatest();

        if (fee == 0) return (this.afterSwap.selector, 0);

        // afterSwap precedes router settlement, so book a 1:1 ERC-6909 claim
        // instead of taking physical currency. Burn paths redeem it later.
        poolManager.mint(address(this), unspecified.toId(), fee);
        if (unspecified.isAddressZero()) {
            pendingEth += fee;
        } else {
            pendingToken += fee;
        }
        emit HookFeeTaken(unspecified, fee);

        return (this.afterSwap.selector, fee.toInt128());
    }

    // Commit, reveal, claim
    /// @notice Commit keccak256(tick, salt, sender) for the current block.
    function commit(bytes32 h) external {
        _accumulate();
        uint256 n = currentBlock();
        if (h == bytes32(0)) revert EmptyCommitment();
        Entry storage e = entries[n][msg.sender];
        if (e.commitment != bytes32(0)) revert AlreadyCommitted();

        uint256 stake = stakeFor(n);
        e.commitment = h;
        blocks[n].stakedTotal += uint128(stake);
        if (stake > 0) token.transferFrom(msg.sender, address(this), stake);
        emit Committed(n, msg.sender);
    }

    /// @notice Reveal during block n+2; the closest prediction holds the lead.
    function reveal(uint256 n, int24 tick, bytes32 salt) external {
        _accumulate();
        if (currentBlock() != n + 2) revert RevealNotOpen();
        Entry storage e = entries[n][msg.sender];
        if (e.commitment == bytes32(0)) revert NothingCommitted();
        if (e.revealed) revert AlreadyRevealed();
        if (keccak256(abi.encodePacked(tick, salt, msg.sender)) != e.commitment) revert BadReveal();

        int24 target = targetTick(n);
        e.revealed = true;
        e.tick = tick;

        // Predictions are scored as exact Uniswap ticks.
        int256 d = int256(tick) - int256(target);
        uint32 dist = uint32(uint256(d < 0 ? -d : d));

        BlockData storage b = blocks[n];
        // Address-hash ties avoid reveal-order bias but are grindable when the
        // target is predictable; only the selected address needs a stake.
        bytes32 tb = keccak256(abi.encodePacked(msg.sender, n, target));
        if (b.winner == address(0) || dist < b.bestDist) {
            b.winner = msg.sender;
            b.bestDist = dist;
            b.bestTiebreak = tb;
        } else if (dist == b.bestDist && tb < b.bestTiebreak) {
            b.winner = msg.sender;
            b.bestTiebreak = tb;
        }

        // Successful reveals lock, rather than consume, their stake. Slices
        // aggregate entries so lock and unlock remain O(1).
        uint256 stake = stakeFor(n);
        b.returnedTotal += uint128(stake);
        // Use placement time so a reveal crossing an era boundary cannot extend the lock.
        uint256 slice = lockSliceAt(n * BLOCK_TIME);
        lockedStake[msg.sender][slice] += stake;
        totalLockedStakes += stake;

        emit Revealed(n, msg.sender, tick, dist);
        emit StakeLocked(msg.sender, slice, stake, stakeUnlockTime(slice));
    }

    /// @notice Finalize a settled block; missed rewards are visibly minted and burned.
    function finalizeBlock(uint256 n) external {
        if (currentBlock() <= n + 2) revert BlockNotSettled();
        _finalizeBlock(n);
    }

    /// @dev Swaps finalize only the latest settled block to keep gas bounded.
    function _autoFinalizeLatest() internal {
        if (miningStart == 0) return;
        uint256 c = currentBlock();
        if (c < 3) return;

        _finalizeBlock(c - 3);
    }

    function _finalizeBlock(uint256 n) internal {
        BlockData storage b = blocks[n];
        if (b.emissionFinalized) return;
        b.emissionFinalized = true;
        uint256 reward = scheduledBlockReward(n);

        if (b.winner == address(0)) {
            token.mint(address(this), reward);
            token.burn(reward);
        } else {
            b.reward = uint128(reward);
        }
    }

    /// @notice Claim block n's fixed reward, finalizing it lazily if needed.
    function claimBlock(uint256 n) external {
        if (currentBlock() <= n + 2) revert BlockNotSettled();
        BlockData storage b = blocks[n];
        if (b.winner != msg.sender) revert NotWinner();
        if (b.claimed) revert AlreadyClaimed();
        _finalizeBlock(n);

        b.claimed = true;
        uint256 reward = b.reward;

        if (reward != 0) {
            vestsOf[msg.sender].push(
                VestEntry({
                    total: uint128(reward),
                    released: 0,
                    start: uint64(block.timestamp),
                    duration: vestDurationFor(n),
                    exited: false
                })
            );
            emit VestCreated(msg.sender, vestsOf[msg.sender].length - 1, reward);
        }
        emit BlockWon(n, msg.sender, reward, targetTick(n));
    }

    /// @notice Reclaim all stake in an expired lock slice in O(1).
    /// @param slice Value returned by lockSliceAt or emitted by StakeLocked.
    function unlockStakes(uint256 slice) external {
        uint256 amount = lockedStake[msg.sender][slice];
        if (amount == 0) revert NothingLocked();
        if (block.timestamp < stakeUnlockTime(slice)) revert StakeStillLocked();
        lockedStake[msg.sender][slice] = 0;
        totalLockedStakes -= amount;
        token.transfer(msg.sender, amount);
        emit StakeUnlocked(msg.sender, slice, amount);
    }

    /// @notice Burn all unrevealed stake for settled block n in O(1).
    function burnUnrevealed(uint256 n) external {
        if (currentBlock() <= n + 2) revert BlockNotSettled();
        BlockData storage b = blocks[n];
        if (b.burned) revert AlreadyBurned();
        uint256 amount = uint256(b.stakedTotal) - uint256(b.returnedTotal);
        if (amount == 0) revert NothingToBurn();
        b.burned = true;
        token.burn(amount);
        totalBurnedStakes += amount;
        emit StakesBurned(n, amount);
    }

    // Fee destruction
    /// @notice Burn accumulated BITHOOK-denominated fee claims. Permissionless.
    function burnFees() external {
        uint256 t = pendingToken;
        if (t == 0) revert NothingToBurn();
        pendingToken = 0;
        totalFeeBurned += t;
        // Redeem the ERC-6909 claim inside an unlock, then burn the token.
        poolManager.unlock(abi.encode(ACTION_BURN_FEES, abi.encode(t)));
        emit FeesBurned(t);
    }

    /// @notice Spend pending ETH fee claims on BITHOOK and burn the output.
    /// @param maxEthIn Maximum pending ETH claim to spend. Pass zero to spend
    ///        all pending ETH. Unspent claims remain pending.
    function buybackAndBurn(uint256 maxEthIn) external {
        uint256 e = pendingEth;
        if (e == 0) revert NothingToBuyBack();
        uint256 ethIn = maxEthIn == 0 || maxEthIn > e ? e : maxEthIn;
        // Self-swaps skip afterSwap, so checkpoint explicitly on both sides.
        _accumulate();
        poolManager.unlock(abi.encode(ACTION_BUYBACK, abi.encode(ethIn)));
        _accumulate();
    }

    /// @dev Dispatches callbacks initiated by this hook through PoolManager.unlock.
    function unlockCallback(bytes calldata data) external onlyPoolManager returns (bytes memory) {
        (uint8 action, bytes memory payload) = abi.decode(data, (uint8, bytes));
        if (action == ACTION_BUYBACK) {
            _buybackAndBurn(abi.decode(payload, (uint256)));
        } else if (action == ACTION_SEED) {
            (uint128 lCurve, uint128 lTail) = abi.decode(payload, (uint128, uint128));
            _installSeed(lCurve, lTail);
        } else if (action == ACTION_BURN_FEES) {
            _burnTokenFees(abi.decode(payload, (uint256)));
        } else {
            revert UnknownAction();
        }
        return "";
    }

    /// @dev Redeem a token claim and burn its physical backing in one unlock.
    function _burnTokenFees(uint256 amount) internal {
        poolManager.burn(address(this), poolKey.currency1.toId(), amount);
        poolManager.take(poolKey.currency1, address(this), amount);
        token.burn(amount);
    }

    /// @dev Installs both bands; v4 skips the hook's own liquidity callback.
    ///      The bands are contiguous at SEED_GRAD_TICK, so the corridor has no
    ///      internal void a swap could park in.
    function _installSeed(uint128 lCurve, uint128 lTail) internal {
        (BalanceDelta dCurve,) = poolManager.modifyLiquidity(
            poolKey,
            ModifyLiquidityParams({
                tickLower: SEED_GRAD_TICK,
                tickUpper: SEED_START_TICK,
                liquidityDelta: int256(uint256(lCurve)),
                salt: bytes32(0)
            }),
            ""
        );
        (BalanceDelta dTail,) = poolManager.modifyLiquidity(
            poolKey,
            ModifyLiquidityParams({
                tickLower: SEED_FLOOR_TICK,
                tickUpper: SEED_GRAD_TICK,
                liquidityDelta: int256(uint256(lTail)),
                salt: bytes32(0)
            }),
            ""
        );
        BalanceDelta delta = dCurve + dTail;

        uint256 owed0 = delta.amount0() < 0 ? uint256(uint128(-delta.amount0())) : 0;
        uint256 owed1 = delta.amount1() < 0 ? uint256(uint128(-delta.amount1())) : 0;
        uint256 expected = token.INITIAL_SUPPLY();
        if (owed0 != 0 || owed1 > expected || expected - owed1 > MAX_SEED_TOKEN_DUST) {
            revert InvalidSeedFunding();
        }
        if (owed1 > 0) {
            poolManager.sync(poolKey.currency1);
            token.transfer(address(poolManager), owed1);
            poolManager.settle();
        }
        emit Seeded(lCurve, lTail, owed1);
    }

    function _buybackAndBurn(uint256 ethIn) internal {
        BalanceDelta delta = poolManager.swap(
            poolKey,
            SwapParams({
                zeroForOne: true, // ETH in, BITHOOK out
                amountSpecified: -int256(ethIn), // exact input
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            ""
        );

        // amount0 is ETH owed; amount1 is BITHOOK received.
        uint256 spent = uint256(uint128(-delta.amount0()));
        uint256 bought = uint256(uint128(delta.amount1()));

        // Underflow prevents spending more than the recorded ETH fee claims.
        pendingEth -= spent;
        // Burn the claim to settle the ETH input without custodying native ETH.
        poolManager.burn(address(this), poolKey.currency0.toId(), spent);

        poolManager.take(poolKey.currency1, address(this), bought);
        totalBuybackBurned += bought;
        token.burn(bought);

        // Self-swaps skip afterSwap, so enforce the corridor here as well.
        // An oversized atomic purchase reverts and leaves its claim pending.
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(poolId);
        if (sqrtPriceX96 < seedSqrtLower || sqrtPriceX96 > seedSqrtUpper) {
            revert PriceOutsideCorridor();
        }

        emit BoughtBackAndBurned(spent, bought);
    }

    // Vesting and early exit
    function _vested(VestEntry storage e) internal view returns (uint256) {
        uint256 elapsed = block.timestamp - e.start;
        uint256 d = e.duration;
        if (elapsed >= d) return e.total;
        return (uint256(e.total) * elapsed) / d;
    }

    function unlockVested(uint256[] calldata ids) external {
        uint256 due;
        for (uint256 i = 0; i < ids.length; i++) {
            VestEntry storage e = vestsOf[msg.sender][ids[i]];
            if (e.exited) continue;
            uint256 vested = _vested(e);
            uint256 d = vested - e.released;
            if (d == 0) continue;
            e.released = uint128(vested);
            due += d;
        }
        if (due == 0) revert NothingToUnlock();
        token.mint(msg.sender, due);
        emit Unlocked(msg.sender, due);
    }

    /// @notice Exit now with vested rewards plus the unslashed remainder.
    function exitEarly(uint256[] calldata ids) external {
        uint256 due;
        uint256 slashed;
        for (uint256 i = 0; i < ids.length; i++) {
            VestEntry storage e = vestsOf[msg.sender][ids[i]];
            if (e.exited) continue;
            uint256 vested = _vested(e);
            uint256 unvested = e.total - vested;
            uint256 kept = (unvested * (10_000 - EXIT_SLASH_BPS)) / 10_000;
            due += (vested - e.released) + kept;
            slashed += unvested - kept;
            e.released = e.total;
            e.exited = true;
        }
        if (due == 0) revert NothingToUnlock();
        totalSlashed += slashed;
        token.mint(msg.sender, due);
        // Mint-and-burn makes the slash visible to supply trackers.
        if (slashed > 0) {
            token.mint(address(this), slashed);
            token.burn(slashed);
        }
        emit EarlyExited(msg.sender, due, slashed);
    }

    function vestCount(address user) external view returns (uint256) {
        return vestsOf[user].length;
    }

    function claimableVested(address user, uint256[] calldata ids) external view returns (uint256 total) {
        for (uint256 i = 0; i < ids.length; i++) {
            VestEntry storage e = vestsOf[user][ids[i]];
            if (e.exited) continue;
            total += _vested(e) - e.released;
        }
    }

    // Normal fee flow uses manager claims; reject direct native transfers.
    receive() external payable {
        if (msg.sender != address(poolManager)) revert NativeOnlyFromPoolManager();
    }
}
