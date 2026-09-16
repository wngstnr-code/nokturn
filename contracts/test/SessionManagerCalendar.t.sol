// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SessionManager} from "../src/SessionManager.sol";
import {Session} from "../src/types/Types.sol";
import {CalendarFixture} from "./fixtures/CalendarFixture.sol";

/// @notice Walks every calendar day from 2020 to 2035 against the committed NYSE
/// fixture. rencana-uji.md section 8 asks for exhaustion at every boundary rather
/// than samples, because cases 1 to 6 there are fully deterministic and a sampled
/// test would miss exactly the days that are hard.
contract SessionManagerCalendarTest is Test {
    SessionManager manager;
    address governor = address(0x60174E);

    /// 8 March 2020, the first row of dst-boundaries.csv. Before it the table says
    /// nothing, and sessionAt answers PROTECTIVE by design rather than guessing.
    uint64 constant FIRST_DST_BOUNDARY = 1_583_650_800;
    CalendarFixture.Day[] calendarDays;

    function setUp() public {
        manager = new SessionManager(governor);
        CalendarFixture.Day[] memory loaded = CalendarFixture.loadDays();
        vm.startPrank(governor);
        manager.setDstBoundaries(CalendarFixture.loadDst());
        CalendarFixture.loadCalendar(manager, loaded);
        vm.stopPrank();
        for (uint256 i = 0; i < loaded.length; ++i) {
            calendarDays.push(loaded[i]);
        }
    }

    function test_fixtureCoversSixteenYears() public view {
        assertEq(calendarDays.length, 5844);
        uint256 holidays;
        uint256 earlyCloses;
        for (uint256 i = 0; i < calendarDays.length; ++i) {
            if (calendarDays[i].kind == 1) ++holidays;
            if (calendarDays[i].kind == 2) ++earlyCloses;
        }
        assertEq(holidays, 155);
        assertEq(earlyCloses, 33);
    }

    function test_everyTradingDayOpensAndClosesExactlyOnTheFixture() public view {
        uint64 coveredUntil = manager.coveredUntil();
        uint256 checked;

        for (uint256 i = 0; i < calendarDays.length; ++i) {
            CalendarFixture.Day memory d = calendarDays[i];
            if (d.openUtc == 0) continue;
            if (d.openUtc <= FIRST_DST_BOUNDARY) continue;
            if (d.closeUtc >= coveredUntil) break;

            assertEq(
                uint8(manager.sessionAt(d.openUtc - 1)), uint8(Session.AUCTION_OPEN), "second before open"
            );
            assertEq(uint8(manager.sessionAt(d.openUtc)), uint8(Session.OPEN), "the open");
            assertEq(uint8(manager.sessionAt(d.closeUtc - 1801)), uint8(Session.OPEN), "before auction close");
            assertEq(
                uint8(manager.sessionAt(d.closeUtc - 1800)), uint8(Session.AUCTION_CLOSE), "auction close"
            );
            assertEq(
                uint8(manager.sessionAt(d.closeUtc - 1)), uint8(Session.AUCTION_CLOSE), "second before close"
            );
            assertEq(uint8(manager.sessionAt(d.closeUtc)), uint8(Session.POST_MARKET), "the close");
            ++checked;
        }

        assertGt(checked, 3900); // 16 years of sessions, minus the uncovered head and tail
    }

    function test_everyHolidayAndWeekendIsClosed() public view {
        uint64 coveredUntil = manager.coveredUntil();
        uint256 holidaysChecked;
        uint256 weekendsChecked;

        for (uint256 i = 0; i < calendarDays.length; ++i) {
            CalendarFixture.Day memory d = calendarDays[i];
            // One hour after the bell on a trading day, which is inside the open
            // session even on a 13:00 early close. Closed days carry no open time,
            // so they fall back to 16:30 UTC, which is late morning either offset.
            uint64 middayUtc = d.openUtc != 0 ? d.openUtc + 3600 : uint64(d.dayIndex) * 86_400 + 59_400;
            if (middayUtc >= coveredUntil) break;
            if (middayUtc <= FIRST_DST_BOUNDARY) continue;

            Session s = manager.sessionAt(middayUtc);
            uint8 dow = uint8((d.dayIndex + 4) % 7);

            if (dow == 0 || dow == 6) {
                assertEq(uint8(s), uint8(Session.CLOSED_WEEKEND), "weekend");
                ++weekendsChecked;
            } else if (d.kind == 1) {
                assertEq(uint8(s), uint8(Session.HOLIDAY), "holiday");
                ++holidaysChecked;
            } else {
                assertEq(uint8(s), uint8(Session.OPEN), "trading day one hour after the bell");
            }
        }

        assertGt(holidaysChecked, 140);
        assertGt(weekendsChecked, 1500);
    }

    /// Early close calendarDays are the ones most often forgotten, and the consequence is
    /// an auction crossing three hours after the real market shut.
    function test_earlyCloseDaysShiftTheAuctionWindow() public view {
        uint64 coveredUntil = manager.coveredUntil();
        uint256 checked;
        for (uint256 i = 0; i < calendarDays.length; ++i) {
            CalendarFixture.Day memory d = calendarDays[i];
            if (d.kind != 2 || d.closeUtc == 0 || d.closeUtc >= coveredUntil) continue;

            assertEq(d.closeTimeEt, 46_800, "early close is 13:00 ET");
            assertEq(uint8(manager.sessionAt(d.closeUtc - 1)), uint8(Session.AUCTION_CLOSE));
            assertEq(uint8(manager.sessionAt(d.closeUtc)), uint8(Session.POST_MARKET));
            // The regular 16:00 auction window must not exist on these days.
            assertEq(uint8(manager.sessionAt(d.closeUtc + 9000)), uint8(Session.POST_MARKET));
            ++checked;
        }
        assertGt(checked, 25);
    }

    /// Both DST shifts, every year in the table.
    function test_everyDstBoundaryMovesTheWallClockNotTheSession() public view {
        uint64[] memory boundaries = CalendarFixture.loadDst();
        for (uint256 i = 1; i < boundaries.length - 1; ++i) {
            uint64 b = boundaries[i];
            // 02:00 local on a Sunday, so both sides are the weekend.
            assertEq(uint8(manager.sessionAt(b - 1)), uint8(Session.CLOSED_WEEKEND));
            assertEq(uint8(manager.sessionAt(b)), uint8(Session.CLOSED_WEEKEND));
        }
    }
}
