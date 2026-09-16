// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Drop in read surface for consumers already written against Chainlink.
/// Every equity price consumer measured on this chain reads through this interface,
/// so this is the shape the closing print is published in.
interface AggregatorV3Interface {
    function decimals() external view returns (uint8);
    function description() external view returns (string memory);

    /// @dev updatedAt is the actual cross timestamp and is never block.timestamp.
    /// The print is stale by design, up to 23 hours. Faking freshness would make
    /// consumer staleness checks fail silently. See parameter.md section 3.1.
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);

    function getRoundData(uint80 roundId)
        external
        view
        returns (uint80 roundId_, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}
