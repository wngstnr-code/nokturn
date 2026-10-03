// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {AggregatorV3Interface} from "../../src/interfaces/AggregatorV3Interface.sol";

/// @title A Chainlink feed on chain 46630 that repeats one on mainnet 4663
/// @notice Chain 46630 has no Chainlink at all, so the rehearsal used to run with
/// prices nobody quotes. This one only accepts rounds copied from a named mainnet
/// proxy, and keeps the source round id next to every round so anyone can look the
/// same round up on mainnet and compare.
///
/// updatedAt is the mainnet timestamp, not the time the copy landed. A feed that
/// froze for the weekend on mainnet reads as frozen here too, and the staleness
/// limits tuned on mainnet mean the same thing on both chains.
///
/// Round ids here are contiguous and local. PriceOracle walks rounds backwards one
/// id at a time, and a relayer that skips a mainnet round would otherwise leave a
/// gap that ends the walk early.
contract MirrorFeed is AggregatorV3Interface {
    struct Round {
        int256 answer;
        uint64 updatedAt;
        uint80 sourceRoundId;
    }

    address public immutable operator;
    /// The mainnet 4663 proxy every round here is copied from.
    address public immutable source;
    uint8 public immutable decimals;
    string public description;

    uint80 public latestRound;
    mapping(uint80 => Round) internal rounds;

    error NotOperator();
    error NonPositiveAnswer(int256 answer);
    error SourceRoundNotNewer(uint80 sourceRoundId, uint80 latest);
    error UpdatedAtNotNewer(uint256 updatedAt, uint64 latest);
    error UpdatedAtInFuture(uint256 updatedAt);

    event Mirrored(uint80 indexed roundId, uint80 indexed sourceRoundId, int256 answer, uint256 updatedAt);

    constructor(address operator_, address source_, uint8 decimals_, string memory description_) {
        operator = operator_;
        source = source_;
        decimals = decimals_;
        description = description_;
    }

    function push(uint80 sourceRoundId, int256 answer, uint256 updatedAt) external {
        if (msg.sender != operator) revert NotOperator();
        if (answer <= 0) revert NonPositiveAnswer(answer);

        Round memory last = rounds[latestRound];
        if (sourceRoundId <= last.sourceRoundId) {
            revert SourceRoundNotNewer(sourceRoundId, last.sourceRoundId);
        }
        if (updatedAt <= last.updatedAt) revert UpdatedAtNotNewer(updatedAt, last.updatedAt);
        if (updatedAt > block.timestamp) revert UpdatedAtInFuture(updatedAt);

        uint80 roundId = latestRound + 1;
        // Bounded by block.timestamp one line up.
        // forge-lint: disable-next-line(unsafe-typecast)
        rounds[roundId] = Round(answer, uint64(updatedAt), sourceRoundId);
        latestRound = roundId;
        emit Mirrored(roundId, sourceRoundId, answer, updatedAt);
    }

    function sourceRoundOf(uint80 roundId) external view returns (uint80) {
        return rounds[roundId].sourceRoundId;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return _round(latestRound);
    }

    /// @dev An unknown round answers zeros rather than reverting, because that is
    /// where PriceOracle stops walking back.
    function getRoundData(uint80 roundId) external view returns (uint80, int256, uint256, uint256, uint80) {
        return _round(roundId);
    }

    function _round(uint80 roundId) internal view returns (uint80, int256, uint256, uint256, uint80) {
        Round memory r = rounds[roundId];
        if (r.updatedAt == 0) return (roundId, 0, 0, 0, roundId);
        return (roundId, r.answer, r.updatedAt, r.updatedAt, roundId);
    }
}
