// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SessionManager} from "../src/SessionManager.sol";
import {Session} from "../src/types/Types.sol";
import {CalendarFixture} from "../script/Calendar.sol";

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

    function test_currentSessionReadsTheClock() public {
        vm.warp(DAY_OPEN + 60);
        assertEq(uint8(manager.currentSession()), uint8(Session.OPEN));
        vm.warp(DAY_OPEN + 40_000);
        assertEq(uint8(manager.currentSession()), uint8(Session.CLOSED_OVERNIGHT));
    }

    /// A run of holidays still ends at the weekend, because the weekend is checked
    /// before the calendar. A three day weekend is the common case of this and it
    /// has to widen the band, so the ordering is load bearing rather than cosmetic.
    function test_weekendOutranksAHolidayRun() public {
        SessionManager stuck = new SessionManager(governor);
        // forge-lint: disable-next-line(unsafe-typecast)
        uint32 firstDay = uint32(DAY_OPEN / 1 days);

        uint32[] memory dates = new uint32[](30);
        uint8[] memory kinds = new uint8[](30);
        uint32[] memory closes = new uint32[](30);
        for (uint32 i = 0; i < 30; ++i) {
            dates[i] = firstDay + i;
            kinds[i] = 1;
        }

        vm.startPrank(governor);
        stuck.setDstBoundaries(CalendarFixture.loadDst());
        stuck.setCalendarEntries(dates, kinds, closes);
        vm.stopPrank();

        assertEq(uint8(stuck.sessionAt(DAY_OPEN)), uint8(Session.HOLIDAY));

        uint64 next = stuck.nextTransition(DAY_OPEN);
        assertEq(uint8(stuck.sessionAt(next)), uint8(Session.CLOSED_WEEKEND));
        assertEq(uint8(stuck.sessionAt(next - 1)), uint8(Session.HOLIDAY));
        assertEq(stuck.batchDuration(Session.CLOSED_WEEKEND), 60);
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

    /// Two boundaries at the same second are not ascending either. A table that
    /// allowed them would put two offset changes on one instant, and the parity
    /// search that decides the offset would answer differently depending on which
    /// one it landed on.
    function test_twoDstBoundariesOnTheSameSecondAreRefused() public {
        uint64[] memory b = new uint64[](2);
        b[0] = 100;
        b[1] = 100;
        vm.prank(governor);
        vm.expectRevert(abi.encodeWithSelector(SessionManager.BoundariesNotAscending.selector, 1));
        manager.setDstBoundaries(b);
    }

    /// The early close window is open at one end and closed at the other. A close
    /// exactly at the opening bell leaves no session to trade in, and one exactly
    /// at the regular close is not an early close at all but is still a legal entry.
    function test_theEarlyCloseWindowIsExactAtBothEnds() public {
        uint32[] memory dates = new uint32[](1);
        uint8[] memory kinds = new uint8[](1);
        uint32[] memory closes = new uint32[](1);
        dates[0] = 20_260_311;
        kinds[0] = 2;

        closes[0] = OPEN_START;
        vm.prank(governor);
        vm.expectRevert(abi.encodeWithSelector(SessionManager.CloseTimeOutOfRange.selector, OPEN_START));
        manager.setCalendarEntries(dates, kinds, closes);

        closes[0] = OPEN_START + 1;
        vm.prank(governor);
        manager.setCalendarEntries(dates, kinds, closes);

        closes[0] = REGULAR_CLOSE;
        vm.prank(governor);
        manager.setCalendarEntries(dates, kinds, closes);

        closes[0] = REGULAR_CLOSE + 1;
        vm.prank(governor);
        vm.expectRevert(
            abi.encodeWithSelector(SessionManager.CloseTimeOutOfRange.selector, REGULAR_CLOSE + 1)
        );
        manager.setCalendarEntries(dates, kinds, closes);
    }

    /// The table covers its first second and stops one short of its last. The lower
    /// edge is inclusive because the first boundary is itself a shift into EDT, and
    /// the upper one is exclusive because past it the offset is a guess.
    function test_theTableCoversItsFirstSecondAndNotItsLast() public view {
        uint64 first = manager.dstBoundaries(0);
        uint64 last = manager.coveredUntil();

        assertTrue(manager.sessionAt(first - 1) == Session.PROTECTIVE, "one second early is a guess");
        assertTrue(manager.sessionAt(first) != Session.PROTECTIVE, "the first second is covered");
        assertTrue(manager.sessionAt(last - 1) != Session.PROTECTIVE, "one second short is covered");
        assertTrue(manager.sessionAt(last) == Session.PROTECTIVE, "the last boundary is not covered");
    }

    /// Past the end of the table nextTransition has no boundary left to hand back,
    /// and it says zero rather than the intraday mark it would otherwise compute.
    /// A caller reading that mark would schedule a batch on a guessed offset.
    function test_pastTheTableThereIsNoNextBoundaryAtAll() public view {
        uint64 last = manager.coveredUntil();
        assertEq(manager.nextTransition(last + 1 days), 0, "a boundary past the table");
        assertEq(manager.nextTransition(last), 0, "a boundary at the edge of the table");
    }

    /// Sunday 8 March 2026, the spring shift. The DST boundary at 02:00 lands
    /// before the first intraday mark of that Sunday, so the walk has to step onto
    /// it rather than past it. Stepping past would leave the rest of the weekend
    /// measured on the winter offset, and Monday would then open an hour late.
    function test_theWalkStepsOntoTheDstBoundaryRatherThanPastIt() public view {
        uint64 springForward = 1_772_953_200;
        uint64 sundayEarly = springForward - 3600;

        uint64 next = manager.nextTransition(sundayEarly);
        assertEq(uint8(manager.sessionAt(next)), uint8(Session.CLOSED_OVERNIGHT), "monday overnight");
        // Midnight in New York on Monday 9 March, which is 04:00 UTC on the summer
        // offset. On the winter offset the same instant reads 05:00 UTC, so an hour
        // of Monday would still be counted as the weekend.
        assertEq(next, 1_773_028_800, "the walk kept the winter offset across the shift");
    }

    uint32 constant OPEN_START = 34_200;
    uint32 constant REGULAR_CLOSE = 57_600;
}
