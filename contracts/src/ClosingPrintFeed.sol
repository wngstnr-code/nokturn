// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";
import {IAuctionHouse} from "./interfaces/IAuctionHouse.sol";

/// @title Chainlink shaped read surface for one token's closing print
/// @notice One instance per token, because AggregatorV3Interface answers for a
/// single pair and every equity price consumer measured on this chain reads
/// through it. Adopting the print is meant to cost one address change and nothing
/// else. See desain-auction.md section 3.3.
///
/// This contract stores nothing and decides nothing. It reverts where there is no
/// print, rather than answering zero, because a consumer that reads zero as a price
/// is the exact failure this surface exists to avoid.
contract ClosingPrintFeed is AggregatorV3Interface {
    uint8 internal constant PRINT_DECIMALS = 8;

    IAuctionHouse public immutable auctionHouse;
    address public immutable token;

    string internal desc;

    error NoPrintYet(address token);
    error NoPrintForDay(address token, uint32 day);

    constructor(IAuctionHouse auctionHouse_, address token_, string memory description_) {
        auctionHouse = auctionHouse_;
        token = token_;
        desc = description_;
    }

    function decimals() external pure returns (uint8) {
        return PRINT_DECIMALS;
    }

    function description() external view returns (string memory) {
        return desc;
    }

    function version() external pure returns (uint256) {
        return 1;
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        uint32 day = auctionHouse.latestPrintDay(token);
        if (day == 0) revert NoPrintYet(token);
        return getRoundData(uint80(day));
    }

    /// @dev The round id is the session day as YYYYMMDD, so getRoundData(20260910)
    /// answers on its own. parameter.md section 3.1.
    function getRoundData(uint80 roundId_)
        public
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        // forge-lint: disable-next-line(unsafe-typecast)
        uint32 day = uint32(roundId_); // aderyn-fp(unsafe-casting)
        (int256 storedAnswer, uint64 storedStart, uint64 storedUpdate) = auctionHouse.printRound(token, day);
        if (storedUpdate == 0) revert NoPrintForDay(token, day);
        return (roundId_, storedAnswer, storedStart, storedUpdate, roundId_);
    }
}
