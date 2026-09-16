// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {AggregatorV3Interface} from "../../src/interfaces/AggregatorV3Interface.sol";

/// @notice Test double for a Chainlink feed. Lives only in the test suite, which
/// rencana-uji.md section 6 allows, because a real feed cannot be made to freeze
/// or to skip rounds on demand.
contract MockAggregator is AggregatorV3Interface {
    struct Round {
        int256 answer;
        uint256 startedAt;
        uint256 updatedAt;
    }

    uint8 public decimals;
    string public description;
    uint80 public latestRound;
    mapping(uint80 => Round) internal rounds;

    constructor(uint8 decimals_, string memory description_) {
        decimals = decimals_;
        description = description_;
    }

    function push(int256 answer, uint256 updatedAt) external returns (uint80) {
        latestRound += 1;
        rounds[latestRound] = Round(answer, updatedAt, updatedAt);
        return latestRound;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        Round memory r = rounds[latestRound];
        return (latestRound, r.answer, r.startedAt, r.updatedAt, latestRound);
    }

    function getRoundData(uint80 roundId) external view returns (uint80, int256, uint256, uint256, uint80) {
        Round memory r = rounds[roundId];
        return (roundId, r.answer, r.startedAt, r.updatedAt, roundId);
    }
}
