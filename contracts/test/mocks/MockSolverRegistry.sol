// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {ISolverRegistry} from "../../src/interfaces/ISolverRegistry.sol";

contract MockSolverRegistry is ISolverRegistry {
    mapping(address => bool) public active;

    function setActive(address solver, bool value) external {
        active[solver] = value;
    }

    function isActive(address solver) external view returns (bool) {
        return active[solver];
    }

    uint256 public minBond = 500e6;

    function setMinBond(uint256 value) external {
        minBond = value;
    }

    address public lastWinner;
    uint256 public lastSavings;
    uint256 public failedFinalizes;

    function recordWin(address solver, uint256 savingsUsd) external {
        lastWinner = solver;
        lastSavings = savingsUsd;
    }

    function reportFailedFinalize(address) external {
        failedFinalizes += 1;
    }

    function reportInvalidSurplus(address) external {}

    function bond(uint256) external {}
    function requestUnbond() external {}
    function withdrawBond() external {}
    function slash(address, uint256, bytes32) external {}

    function stats(address) external pure returns (uint256, uint256, uint256, uint256) {
        return (0, 0, 0, 0);
    }
}
