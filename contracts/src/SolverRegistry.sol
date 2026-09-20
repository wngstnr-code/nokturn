// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ISolverRegistry} from "./interfaces/ISolverRegistry.sol";

/// @title Solver bonding and slashing
/// @notice The scoreboard is derived entirely from settlement facts, never from
/// anything a solver reports about itself. Sybil identities buy nothing: the only
/// way to raise a score is to actually generate savings for real users.
///
/// Bonding is permissionless. The bond exists to make griefing expensive, not to
/// gate entry, which is why it is 5000 USDG rather than a number that would keep
/// anyone out.
contract SolverRegistry is ISolverRegistry {
    using SafeERC20 for IERC20;

    struct Solver {
        uint256 bonded;
        uint64 unbondAvailableAt;
        uint256 batchesWon;
        uint256 savingsGeneratedUsd;
        uint256 failedFinalizes;
        uint256 slashCount;
    }

    uint16 internal constant BPS = 10_000;

    /// parameter.md section 5A. The floor is enforced rather than merely written
    /// down, because isActive reads bonded >= minBond and a zero minimum would
    /// make every address that never bonded at all read as an active solver. That
    /// is not a loosened parameter, it is the gate switched off. The floor also
    /// means the bond can never fall below the calibration it launched with, which
    /// is the same direction the exposure caps move in.
    uint256 public constant MIN_BOND_FLOOR = 500e6; // USDG has 6 decimals
    uint256 public constant MIN_BOND_CEILING = 50_000e6;
    uint64 public constant UNBOND_COOLDOWN = 7 days;
    uint16 public constant SLASH_FAILED_FINALIZE_BPS = 1000; // 10 percent
    uint16 public constant SLASH_INVALID_SURPLUS_BPS = 2500; // 25 percent

    IERC20 public immutable bondToken;
    address public immutable treasury;
    address public immutable governor;

    /// Settlement is the only contract allowed to report facts. It is set once,
    /// after deployment, because the two contracts reference each other.
    address public settlement;

    /// Governed rather than constant, because the exposure caps this bond backs
    /// are governed too. A constant bond sized for the protocol at scale is an
    /// entry price of a hundred and eleven days of the whole solver revenue pool
    /// in the months when third party solvers are most needed. parameter.md 5A.
    uint256 public minBond;

    mapping(address => Solver) internal solvers;

    error NotGovernor();
    error NotSettlement();
    error SettlementAlreadySet();
    error NothingBonded(address solver);
    error UnbondNotRequested(address solver);
    error UnbondStillCooling(uint64 availableAt);
    error SlashExceedsBond(uint256 amount, uint256 bonded);
    error MinBondOutOfRange(uint256 value);

    event SettlementSet(address indexed settlement);

    constructor(IERC20 bondToken_, address treasury_, address governor_) {
        bondToken = bondToken_;
        treasury = treasury_;
        governor = governor_;
        minBond = MIN_BOND_FLOOR;
        emit MinBondUpdated(MIN_BOND_FLOOR);
    }

    /// @notice Raising this deactivates every solver already below the new value
    /// until it tops up. There is no grandfathering, the same way a tightened
    /// exposure cap applies to everyone at once, and the timelock gives two full
    /// days of warning. parameter.md 5A.
    function setMinBond(uint256 value) external {
        if (msg.sender != governor) revert NotGovernor();
        if (value < MIN_BOND_FLOOR || value > MIN_BOND_CEILING) revert MinBondOutOfRange(value);
        minBond = value;
        emit MinBondUpdated(value);
    }

    modifier onlySettlement() {
        if (msg.sender != settlement) revert NotSettlement();
        _;
    }

    function setSettlement(address settlement_) external {
        if (msg.sender != governor) revert NotGovernor();
        if (settlement != address(0)) revert SettlementAlreadySet();
        settlement = settlement_;
        emit SettlementSet(settlement_);
    }

    /// @inheritdoc ISolverRegistry
    function bond(uint256 amount) external {
        bondToken.safeTransferFrom(msg.sender, address(this), amount);
        Solver storage s = solvers[msg.sender];
        s.bonded += amount;
        // Topping up cancels a pending exit. A solver cannot sit in the cooldown
        // and keep winning batches at the same time.
        s.unbondAvailableAt = 0;
        emit SolverBonded(msg.sender, amount, s.bonded);
    }

    /// @inheritdoc ISolverRegistry
    function requestUnbond() external {
        Solver storage s = solvers[msg.sender];
        if (s.bonded == 0) revert NothingBonded(msg.sender);
        uint64 availableAt = uint64(block.timestamp) + UNBOND_COOLDOWN;
        s.unbondAvailableAt = availableAt;
        emit SolverUnbondRequested(msg.sender, availableAt);
    }

    /// @inheritdoc ISolverRegistry
    /// @dev The cooldown exists so that bad behaviour discovered after the fact is
    /// still reachable. Withdrawing early would make slashing a race.
    function withdrawBond() external {
        Solver storage s = solvers[msg.sender];
        uint64 availableAt = s.unbondAvailableAt;
        if (availableAt == 0) revert UnbondNotRequested(msg.sender);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < availableAt) revert UnbondStillCooling(availableAt);

        uint256 amount = s.bonded;
        if (amount == 0) revert NothingBonded(msg.sender);
        s.bonded = 0;
        s.unbondAvailableAt = 0;
        bondToken.safeTransfer(msg.sender, amount);
    }

    /// @inheritdoc ISolverRegistry
    function slash(address solver, uint256 amount, bytes32 reason) external {
        if (msg.sender != governor && msg.sender != settlement) revert NotGovernor();

        Solver storage s = solvers[solver];
        if (amount > s.bonded) revert SlashExceedsBond(amount, s.bonded);

        s.bonded -= amount;
        s.slashCount += 1;
        bondToken.safeTransfer(treasury, amount);
        emit SolverSlashed(solver, amount, reason);
    }

    /// @notice Winning and then failing to finalize blocks the batch for everyone,
    /// so it is slashable even though nothing was stolen.
    function reportFailedFinalize(address solver) external onlySettlement {
        Solver storage s = solvers[solver];
        s.failedFinalizes += 1;
        _slashShare(solver, SLASH_FAILED_FINALIZE_BPS, "failed finalize");
    }

    /// @notice A claimed surplus that proves false is an attempt to deceive rather
    /// than an operational slip, so it costs more.
    function reportInvalidSurplus(address solver) external onlySettlement {
        _slashShare(solver, SLASH_INVALID_SURPLUS_BPS, "invalid surplus");
    }

    function recordWin(address solver, uint256 savingsUsd) external onlySettlement {
        Solver storage s = solvers[solver];
        s.batchesWon += 1;
        s.savingsGeneratedUsd += savingsUsd;
        emit SolverScoreUpdated(solver, s.batchesWon, s.savingsGeneratedUsd);
    }

    /// @inheritdoc ISolverRegistry
    function isActive(address solver) external view returns (bool) {
        Solver storage s = solvers[solver];
        return s.bonded >= minBond && s.unbondAvailableAt == 0;
    }

    /// @inheritdoc ISolverRegistry
    function stats(address solver)
        external
        view
        returns (uint256 batchesWon, uint256 savingsGeneratedUsd, uint256 failedFinalizes, uint256 slashCount)
    {
        Solver storage s = solvers[solver];
        return (s.batchesWon, s.savingsGeneratedUsd, s.failedFinalizes, s.slashCount);
    }

    function bondOf(address solver) external view returns (uint256 bonded, uint64 unbondAvailableAt) {
        Solver storage s = solvers[solver];
        return (s.bonded, s.unbondAvailableAt);
    }

    function _slashShare(address solver, uint16 shareBps, bytes32 reason) internal {
        Solver storage s = solvers[solver];
        uint256 amount = (s.bonded * shareBps) / BPS;
        if (amount == 0) return;

        s.bonded -= amount;
        s.slashCount += 1;
        bondToken.safeTransfer(treasury, amount);
        emit SolverSlashed(solver, amount, reason);
    }
}
