// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

interface ISolverRegistry {
    event SolverBonded(address indexed solver, uint256 amount, uint256 total);
    event SolverUnbondRequested(address indexed solver, uint64 availableAt);
    event SolverSlashed(address indexed solver, uint256 amount, bytes32 reason);
    event SolverScoreUpdated(address indexed solver, uint256 batchesWon, uint256 savingsGeneratedUsd);
    event MinBondUpdated(uint256 value);

    function bond(uint256 amount) external;
    function requestUnbond() external;
    function withdrawBond() external;
    function slash(address solver, uint256 amount, bytes32 reason) external;
    function isActive(address solver) external view returns (bool);

    /// @notice The entry price, governed within a fixed range rather than fixed.
    function minBond() external view returns (uint256);

    /// @notice Facts reported by Settlement, the only caller allowed to report
    /// them. The scoreboard is derived from settlement rather than from anything a
    /// solver says about itself, which is what makes sybil identities worthless.
    function recordWin(address solver, uint256 savingsUsd) external;

    /// @notice Winning and then failing to finalize blocks the batch for everyone,
    /// so it is slashable even though nothing was stolen.
    function reportFailedFinalize(address solver) external;

    function reportInvalidSurplus(address solver) external;

    /// @notice Every field is derived from settlement facts, never self reported.
    function stats(address solver)
        external
        view
        returns (uint256 batchesWon, uint256 savingsGeneratedUsd, uint256 failedFinalizes, uint256 slashCount);
}
