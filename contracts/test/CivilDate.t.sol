// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CivilDate} from "../src/libraries/CivilDate.sol";

contract CivilDateHarness {
    function toDayIndex(uint32 ymd) external pure returns (uint32) {
        return CivilDate.toDayIndex(ymd);
    }
}

contract CivilDateTest is Test {
    CivilDateHarness internal harness = new CivilDateHarness();

    string internal constant SESSIONS_PATH = "../data/nyse-calendar/nyse-sessions.csv";
    uint32 internal constant FIRST_DAY_INDEX = 18_262; // 2020-01-01

    /// Walks every row of the committed calendar, which is one row per day from
    /// 2020-01-01 to 2035-12-31. The row number is the day index and the first
    /// column is the date, so the file is a ready made table of expected answers
    /// that nobody on this project wrote by hand.
    function test_matchesEveryDayInTheCommittedCalendar() public view {
        string[] memory lines = _lines(vm.readFile(SESSIONS_PATH));
        uint32 n = 0;
        for (uint256 i = 1; i < lines.length; ++i) {
            string[] memory cols = vm.split(lines[i], ",");
            if (cols.length < 8) continue;

            uint32 dayIndex = FIRST_DAY_INDEX + n;
            uint32 expected = _ymd(cols[0]);
            assertEq(CivilDate.toYmd(dayIndex), expected, cols[0]);
            assertEq(CivilDate.toDayIndex(expected), dayIndex, cols[0]);
            n++;
        }
        assertEq(n, 5844, "the calendar covers sixteen years");
    }

    function test_leapDayAndCenturyRulesHold() public pure {
        assertEq(CivilDate.toYmd(CivilDate.toDayIndex(20_240_229)), 20_240_229);
        assertEq(CivilDate.toDayIndex(20_240_301) - CivilDate.toDayIndex(20_240_229), 1);
        // 2100 is not a leap year, so the day after 28 February is 1 March.
        assertEq(CivilDate.toDayIndex(21_000_301) - CivilDate.toDayIndex(21_000_228), 1);
        // 2000 is, because the four hundred year rule wins over the hundred year one.
        assertEq(CivilDate.toDayIndex(20_000_301) - CivilDate.toDayIndex(20_000_228), 2);
    }

    function test_rejectsDatesThatDoNotExist() public {
        vm.expectRevert(abi.encodeWithSelector(CivilDate.DateOutOfRange.selector, uint32(20_260_231)));
        harness.toDayIndex(20_260_231);

        vm.expectRevert(abi.encodeWithSelector(CivilDate.DateOutOfRange.selector, uint32(20_260_000)));
        harness.toDayIndex(20_260_000);

        vm.expectRevert(abi.encodeWithSelector(CivilDate.DateOutOfRange.selector, uint32(20_261_301)));
        harness.toDayIndex(20_261_301);
    }

    function testFuzz_roundTripsOverTheProtocolLifetime(uint32 dayIndex) public pure {
        dayIndex = uint32(bound(dayIndex, 0, 60_000)); // 1970 to 2134
        assertEq(CivilDate.toDayIndex(CivilDate.toYmd(dayIndex)), dayIndex);
    }

    function _ymd(string memory date) internal pure returns (uint32) {
        string[] memory parts = vm.split(date, "-");
        return uint32(vm.parseUint(parts[0]) * 10_000 + vm.parseUint(parts[1]) * 100 + vm.parseUint(parts[2]));
    }

    function _lines(string memory file) internal pure returns (string[] memory) {
        return vm.split(file, "\n");
    }

    /// The last day of a four hundred year era, which is the only day where the
    /// fourth term of the year-of-era formula is not zero. 2400 is a leap year
    /// because the four hundred year rule wins, so that day is 29 February.
    function test_theLastDayOfAnEraIsTheLeapDayOfTwentyFourHundred() public pure {
        assertEq(CivilDate.toYmd(157_113), 24_000_229);
        assertEq(CivilDate.toYmd(157_114), 24_000_301);
        assertEq(CivilDate.toDayIndex(24_000_229), 157_113);
    }

    /// Each clause of the range guard turned away on its own. A date that breaks
    /// exactly one rule has to be refused by that rule, because the round trip
    /// check behind it cannot catch a year below the epoch or a day of zero
    /// without underflowing first.
    function test_eachRangeRuleRefusesOnItsOwn() public {
        vm.expectRevert(abi.encodeWithSelector(CivilDate.DateOutOfRange.selector, uint32(19_691_231)));
        harness.toDayIndex(19_691_231);

        vm.expectRevert(abi.encodeWithSelector(CivilDate.DateOutOfRange.selector, uint32(20_260_300)));
        harness.toDayIndex(20_260_300);

        vm.expectRevert(abi.encodeWithSelector(CivilDate.DateOutOfRange.selector, uint32(20_260_332)));
        harness.toDayIndex(20_260_332);
    }
}
