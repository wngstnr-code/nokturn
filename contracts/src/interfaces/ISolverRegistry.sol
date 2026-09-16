// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

interface ISolverRegistry {
    event SolverBonded(address indexed solver, uint256 amount, uint256 total);
    event SolverUnbondRequested(address indexed solver, uint64 availableAt);
    event SolverSlashed(address indexed solver, uint256 amount, bytes32 reason);
    event SolverScoreUpdated(address indexed solver, uint256 batchesWon, uint256 savingsGeneratedUsd);

    function bond(uint256 amount) external;
    function requestUnbond() external;
    function withdrawBond() external;
    function slash(address solver, uint256 amount, bytes32 reason) external;
    function isActive(address solver) external view returns (bool);

    /// @notice Every field is derived from settlement facts, never self reported.
    function stats(address solver)
        external
        view
        returns (uint256 batchesWon, uint256 savingsGeneratedUsd, uint256 failedFinalizes, uint256 slashCount);
}
