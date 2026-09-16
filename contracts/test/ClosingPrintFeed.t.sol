// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ClosingPrintFeed} from "../src/ClosingPrintFeed.sol";
import {IAuctionHouse} from "../src/interfaces/IAuctionHouse.sol";

/// @notice Answers the two reads the feed makes and nothing else. The end to end
/// path runs against the real AuctionHouse in its own suite, so what is worth
/// isolating here is what the feed does with a day that has no print.
contract PrintSource {
    mapping(uint32 => int256) public answers;
    mapping(uint32 => uint64) public times;
    uint32 public day;

    function set(uint32 day_, int256 answer, uint64 startedAt, uint64 updatedAt) external {
        answers[day_] = answer;
        times[day_] = updatedAt;
        starts[day_] = startedAt;
        if (day_ > day) day = day_;
    }

    mapping(uint32 => uint64) public starts;

    function printRound(address, uint32 day_) external view returns (int256, uint64, uint64) {
        return (answers[day_], starts[day_], times[day_]);
    }

    function latestPrintDay(address) external view returns (uint32) {
        return day;
    }
}

contract ClosingPrintFeedTest is Test {
    PrintSource source;
    ClosingPrintFeed feed;

    address token = address(0x4E5DA);

    function setUp() public {
        source = new PrintSource();
        feed = new ClosingPrintFeed(IAuctionHouse(address(source)), token, "Nokturn closing print NVDA / USD");
    }

    function test_looksExactlyLikeTheFeedsConsumersAlreadyRead() public view {
        assertEq(feed.decimals(), 8, "parameter.md section 3.1, same as the feeds on this chain");
        assertEq(feed.description(), "Nokturn closing print NVDA / USD");
        assertEq(feed.version(), 1);
    }

    /// The round id is the date, so a consumer can ask about a specific day without
    /// keeping an index of its own.
    function test_theRoundIdIsTheSessionDay() public {
        source.set(20_260_910, 200e8, 1000, 2000);
        (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound) =
            feed.getRoundData(20_260_910);

        assertEq(roundId, 20_260_910);
        assertEq(answer, 200e8);
        assertEq(startedAt, 1000);
        assertEq(updatedAt, 2000);
        assertEq(answeredInRound, 20_260_910);
    }

    /// Answering zero would be read as a price. Reverting is the only honest
    /// answer for a day that never produced a print.
    function test_aDayWithoutAPrintRevertsRatherThanAnsweringZero() public {
        vm.expectRevert(abi.encodeWithSelector(ClosingPrintFeed.NoPrintYet.selector, token));
        feed.latestRoundData();

        source.set(20_260_910, 200e8, 1000, 2000);
        vm.expectRevert(
            abi.encodeWithSelector(ClosingPrintFeed.NoPrintForDay.selector, token, uint32(20_260_911))
        );
        feed.getRoundData(20_260_911);
    }

    /// The staleness a consumer sees has to be the real one. A print is old for
    /// most of the day by design, and that is the consumer's decision to make.
    function test_updatedAtIsTheCrossAndNotTheMomentOfReading() public {
        source.set(20_260_910, 200e8, 1000, 2000);
        vm.warp(500_000);
        (,,, uint256 updatedAt,) = feed.latestRoundData();
        assertEq(updatedAt, 2000, "never block.timestamp");
    }
}
