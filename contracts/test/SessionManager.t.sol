// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SessionManager} from "../src/SessionManager.sol";
import {Session} from "../src/types/Types.sol";
import {CalendarFixture} from "./fixtures/CalendarFixture.sol";

contract SessionManagerTest is Test {
    SessionManager manager;
    address governor = address(0x60174E);

    function setUp() public {
        manager = new SessionManager(governor);
        vm.startPrank(governor);
        manager.setDstBoundaries(CalendarFixture.loadDst());
        CalendarFixture.loadCalendar(manager, CalendarFixture.loadDays());
        vm.stopPrank();
    }

    /// Wednesday 11 March 2026, a plain trading day. Every constant below is read
    /// off nyse-sessions.csv rather than computed here, so the test cannot agree
    /// with a mistake of its own making.
    uint64 constant DAY_OPEN = 1_773_235_800; // 09:30 ET, 13:30 UTC in EDT
    uint64 constant DAY_CLOSE = 1_773_259_200; // 16:00 ET

    function test_regularDayWalksEverySession() public view {
        uint64 midnightEt = DAY_OPEN - 34_200;
        assertEq(uint8(manager.sessionAt(midnightEt + 3600)), uint8(Session.CLOSED_OVERNIGHT));
        assertEq(uint8(manager.sessionAt(midnightEt + 14_400)), uint8(Session.PRE_MARKET));
        assertEq(uint8(manager.sessionAt(midnightEt + 32_399)), uint8(Session.PRE_MARKET));
        assertEq(uint8(manager.sessionAt(midnightEt + 32_400)), uint8(Session.AUCTION_OPEN));
        assertEq(uint8(manager.sessionAt(midnightEt + 34_199)), uint8(Session.AUCTION_OPEN));
        assertEq(uint8(manager.sessionAt(midnightEt + 34_200)), uint8(Session.OPEN));
        assertEq(uint8(manager.sessionAt(midnightEt + 55_799)), uint8(Session.OPEN));
        assertEq(uint8(manager.sessionAt(midnightEt + 55_800)), uint8(Session.AUCTION_CLOSE));
        assertEq(uint8(manager.sessionAt(midnightEt + 57_599)), uint8(Session.AUCTION_CLOSE));
        assertEq(uint8(manager.sessionAt(midnightEt + 57_600)), uint8(Session.POST_MARKET));
        assertEq(uint8(manager.sessionAt(midnightEt + 71_999)), uint8(Session.POST_MARKET));
        assertEq(uint8(manager.sessionAt(midnightEt + 72_000)), uint8(Session.CLOSED_OVERNIGHT));
    }

    /// The whole reason the DST table exists. The same wall clock open moves a full
    /// hour in UTC across the March boundary, and getting it wrong moves the most
    /// price certain session of the week.
    function test_dstShiftMovesTheOpenByExactlyOneHour() public view {
        uint64 fridayBeforeEst = 1_772_807_400; // 6 March 2026, 14:30 UTC
        uint64 mondayAfterEdt = 1_773_063_000; // 9 March 2026, 13:30 UTC
        assertEq(mondayAfterEdt - fridayBeforeEst, 3 days - 1 hours);
        assertEq(uint8(manager.sessionAt(fridayBeforeEst)), uint8(Session.OPEN));
        assertEq(uint8(manager.sessionAt(fridayBeforeEst - 1)), uint8(Session.AUCTION_OPEN));
        assertEq(uint8(manager.sessionAt(mondayAfterEdt)), uint8(Session.OPEN));
        assertEq(uint8(manager.sessionAt(mondayAfterEdt - 1)), uint8(Session.AUCTION_OPEN));
    }

    function test_outsideTheDstTableIsProtectiveNotAGuess() public view {
        uint64 lastBoundary = manager.coveredUntil();
        assertEq(uint8(manager.sessionAt(lastBoundary)), uint8(Session.PROTECTIVE));
        assertEq(uint8(manager.sessionAt(lastBoundary + 365 days)), uint8(Session.PROTECTIVE));
        assertEq(uint8(manager.sessionAt(1)), uint8(Session.PROTECTIVE));
    }

    function test_guardBandOpensAroundEveryBoundary() public view {
        uint64 open = DAY_OPEN;
        assertTrue(manager.inGuardBand(open));
        assertTrue(manager.inGuardBand(open - 59));
        assertTrue(manager.inGuardBand(open + 59));
        assertFalse(manager.inGuardBand(open + 3600));
    }

    function test_nextTransitionLandsOnTheFirstDifferentSecond() public view {
        uint64 t = DAY_OPEN + 600;
        uint64 next = manager.nextTransition(t);
        assertEq(uint8(manager.sessionAt(next - 1)), uint8(Session.OPEN));
        assertTrue(manager.sessionAt(next) != Session.OPEN);
        assertEq(next, DAY_CLOSE - 1800); // 15:30 ET, auction close opens
    }

    function test_protectiveOverridesTimeAndTakesThreeHealthyReportsToClear() public {
        address token = address(0xA11CE);
        vm.warp(DAY_OPEN);
        assertEq(uint8(manager.tokenSession(token)), uint8(Session.OPEN));

        vm.prank(governor);
        manager.setProtective(token, "stale feed");
        assertEq(uint8(manager.tokenSession(token)), uint8(Session.PROTECTIVE));

        vm.startPrank(governor);
        manager.reportHealthy(token);
        assertEq(uint8(manager.tokenSession(token)), uint8(Session.PROTECTIVE));
        manager.reportHealthy(token);
        assertEq(uint8(manager.tokenSession(token)), uint8(Session.PROTECTIVE));
        manager.reportHealthy(token);
        vm.stopPrank();
        assertEq(uint8(manager.tokenSession(token)), uint8(Session.OPEN));
    }

    function test_parametersMatchTheParameterDoc() public view {
        assertEq(manager.batchDuration(Session.OPEN), 10);
        assertEq(manager.batchDuration(Session.CLOSED_OVERNIGHT), 45);
        assertEq(manager.batchDuration(Session.CLOSED_WEEKEND), 60);
        assertEq(manager.batchDuration(Session.HOLIDAY), 120);
        assertEq(manager.batchDuration(Session.PROTECTIVE), 180);
        assertEq(manager.maxDeviationBps(Session.OPEN), 30);
        assertEq(manager.maxDeviationBps(Session.CLOSED_WEEKEND), 150);
        assertEq(manager.maxDeviationBps(Session.PROTECTIVE), 20);
    }

    function test_auctionPhasesRunNoOrdinaryBatchAndUseTheCollar() public view {
        assertEq(manager.batchDuration(Session.AUCTION_OPEN), 0);
        assertEq(manager.batchDuration(Session.AUCTION_CLOSE), 0);
        assertEq(manager.maxDeviationBps(Session.AUCTION_OPEN), 200);
        assertEq(manager.maxDeviationBps(Session.AUCTION_CLOSE), 200);
        assertEq(manager.batchDuration(Session.PRE_MARKET), 30);
        assertEq(manager.batchDuration(Session.POST_MARKET), 30);
        assertEq(manager.maxDeviationBps(Session.PRE_MARKET), 60);
        assertEq(manager.maxDeviationBps(Session.CLOSED_OVERNIGHT), 100);
        assertEq(manager.maxDeviationBps(Session.HOLIDAY), 150);
    }

    function test_nextTransitionGivesUpOutsideTheTable() public view {
        assertEq(manager.nextTransition(manager.coveredUntil() + 1 days), 0);
    }

    function test_nextTransitionCrossesAWholeWeekend() public view {
        // Friday 6 March 2026, one second into post market. The next different
        // session is the Saturday that follows, not any boundary inside Friday.
        uint64 fridayClose = 1_772_830_800;
        uint64 next = manager.nextTransition(fridayClose + 1);
        assertEq(uint8(manager.sessionAt(next)), uint8(Session.CLOSED_OVERNIGHT));
        assertTrue(next > fridayClose);
    }

    function test_emptyManagerIsProtectiveEverywhere() public {
        SessionManager fresh = new SessionManager(governor);
        assertEq(fresh.coveredUntil(), 0);
        assertEq(uint8(fresh.sessionAt(DAY_OPEN)), uint8(Session.PROTECTIVE));
        assertEq(fresh.nextTransition(DAY_OPEN), 0);
    }

    function test_calendarRejectsNonsenseEntries() public {
        uint32[] memory dates = new uint32[](1);
        uint8[] memory kinds = new uint8[](1);
        uint32[] memory closes = new uint32[](1);
        dates[0] = 20_000;

        kinds[0] = 3;
        vm.prank(governor);
        vm.expectRevert(abi.encodeWithSelector(SessionManager.CalendarKindInvalid.selector, 3));
        manager.setCalendarEntries(dates, kinds, closes);

        // An early close at 21:00 ET would put the auction after post market ends.
        kinds[0] = 2;
        closes[0] = 75_600;
        vm.prank(governor);
        vm.expectRevert(abi.encodeWithSelector(SessionManager.CloseTimeOutOfRange.selector, 75_600));
        manager.setCalendarEntries(dates, kinds, closes);
    }

    function test_healthyReportsOnlyApplyToProtectiveTokens() public {
        vm.prank(governor);
        vm.expectRevert(abi.encodeWithSelector(SessionManager.TokenNotProtective.selector, address(0xBEEF)));
        manager.reportHealthy(address(0xBEEF));
    }

    function test_onlyGovernorMovesTheTables() public {
        uint64[] memory b = new uint64[](1);
        b[0] = 1;
        vm.expectRevert(SessionManager.NotGovernor.selector);
        manager.setDstBoundaries(b);
    }

    function test_dstBoundariesMustAscend() public {
        uint64[] memory b = new uint64[](2);
        b[0] = 100;
        b[1] = 50;
        vm.prank(governor);
        vm.expectRevert(abi.encodeWithSelector(SessionManager.BoundariesNotAscending.selector, 1));
        manager.setDstBoundaries(b);
    }
}
