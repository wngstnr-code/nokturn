// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PriceOracle} from "../src/PriceOracle.sol";
import {SessionManager} from "../src/SessionManager.sol";
import {ISessionManager} from "../src/interfaces/ISessionManager.sol";
import {Session} from "../src/types/Types.sol";
import {CalendarFixture} from "./fixtures/CalendarFixture.sol";
import {MockAdapter} from "./mocks/MockAdapter.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";

contract PriceOracleTest is Test {
    SessionManager sessions;
    PriceOracle oracle;
    MockAggregator feed;
    MockAdapter adapter;

    address governor = address(0x60174E);
    address nvda = address(0x4E7DA);
    address usdg = address(0x05D6);

    /// Wednesday 11 March 2026, read off nyse-sessions.csv.
    uint64 constant DAY_OPEN = 1_773_235_800;
    uint32 constant DAY_INDEX = 20_523;
    /// Saturday 14 March 2026, noon UTC.
    uint64 constant WEEKEND = 1_773_489_600;

    /// parameter.md 7.1, measured 16 September 2026 rather than assumed.
    uint32 constant STALENESS_OPEN = 6000;
    uint32 constant STALENESS_CLOSED = 20_000;

    function setUp() public {
        sessions = new SessionManager(governor);
        vm.startPrank(governor);
        sessions.setDstBoundaries(CalendarFixture.loadDst());
        CalendarFixture.loadCalendar(sessions, CalendarFixture.loadDays());
        vm.stopPrank();

        oracle = new PriceOracle(ISessionManager(address(sessions)), governor);
        feed = new MockAggregator(8, "RHNVDA / USD");
        adapter = new MockAdapter();

        vm.startPrank(governor);
        oracle.setFeed(nvda, address(feed), STALENESS_OPEN, STALENESS_CLOSED);
        oracle.setTwapSource(nvda, address(adapter), usdg, 1800);
        vm.stopPrank();
    }

    function test_dayIndexMatchesTheFixture() public view {
        assertEq(uint8(sessions.sessionAt(DAY_OPEN)), uint8(Session.OPEN));
        assertEq(uint64(DAY_INDEX) * 1 days + 34_200 + 14_400, DAY_OPEN);
    }

    function test_freshFeedIsHealthyAndStaleFeedIsNot() public {
        vm.warp(DAY_OPEN + 1000);
        feed.push(21_304_000_000, DAY_OPEN + 900);

        (uint256 price, uint64 ts, bool healthy) = oracle.refPrice(nvda);
        assertEq(price, 213.04e18);
        assertEq(ts, DAY_OPEN + 900);
        assertTrue(healthy);

        vm.warp(DAY_OPEN + 900 + STALENESS_OPEN + 1);
        (,, healthy) = oracle.refPrice(nvda);
        assertFalse(healthy);
    }

    /// The closed session limit is wider than the open one, and the switch happens
    /// because the session changed, not because anyone reconfigured anything.
    function test_stalenessLimitFollowsTheSession() public {
        vm.warp(DAY_OPEN + 60);
        assertEq(oracle.stalenessLimit(nvda), STALENESS_OPEN);
        vm.warp(WEEKEND);
        assertEq(oracle.stalenessLimit(nvda), STALENESS_CLOSED);
    }

    /// parameter.md 7.3. On a weekend the feed is Friday's close, so the TWAP leads
    /// and the feed becomes the anchor the drift cap is measured against.
    function test_weekendSwapsTheRolesAndUsesTheDriftCap() public {
        feed.push(21_304_000_000, DAY_OPEN + 21_000); // Friday close, then frozen
        vm.warp(WEEKEND);

        adapter.setTwap(215e18);
        (uint256 price, uint64 ts, bool healthy) = oracle.refPrice(nvda);
        assertEq(price, 215e18, "twap leads on the weekend");
        assertEq(ts, WEEKEND, "twap is live, so the timestamp is now");
        assertTrue(healthy, "92 bps of drift is normal weekend movement");

        // TSLA once drifted 781 bps over a weekend with nothing broken, which is why
        // the cap is 1500 and not 500. parameter.md 7.3.
        adapter.setTwap(229e18); // 750 bps
        (,, healthy) = oracle.refPrice(nvda);
        assertTrue(healthy);

        adapter.setTwap(260e18); // 1806 bps
        (,, healthy) = oracle.refPrice(nvda);
        assertFalse(healthy, "past the drift cap");
    }

    function test_disagreementCheckIsOffOnWeekendsAndTighterWhenOpen() public {
        feed.push(200e8, DAY_OPEN + 100);

        vm.warp(DAY_OPEN + 200);
        adapter.setTwap(201e18); // 50 bps exactly
        (,, bool agree) = oracle.dualCheck(nvda);
        assertTrue(agree);

        adapter.setTwap(202e18); // 99 bps
        (,, agree) = oracle.dualCheck(nvda);
        assertFalse(agree, "50 bps limit while open");

        // Overnight the limit loosens to 150 bps.
        vm.warp(DAY_OPEN + 40_000);
        assertEq(uint8(sessions.sessionAt(uint64(block.timestamp))), uint8(Session.CLOSED_OVERNIGHT));
        (,, agree) = oracle.dualCheck(nvda);
        assertTrue(agree);

        vm.warp(WEEKEND);
        adapter.setTwap(400e18); // absurd, and still fine because the check is off
        (,, agree) = oracle.dualCheck(nvda);
        assertTrue(agree, "disabled on the weekend by design");
    }

    function test_openReferenceIsTimeWeightedOverTheFirstFiveMinutes() public {
        feed.push(200e8, DAY_OPEN - 1000); // last round before the bell
        feed.push(210e8, DAY_OPEN + 100); // inside the window
        feed.push(220e8, DAY_OPEN + 200); // inside the window
        feed.push(999e8, DAY_OPEN + 400); // after the window closes

        vm.warp(DAY_OPEN + 1000);
        uint256 price = oracle.finalizeOpenReference(nvda, DAY_INDEX);

        // 200 for 100s, 210 for 100s, 220 for the remaining 100s of the window.
        assertEq(price, (200e18 * 100 + 210e18 * 100 + 220e18 * 100) / 300);

        (uint256 stored, bool available) = oracle.openReference(nvda, DAY_INDEX);
        assertEq(stored, price);
        assertTrue(available);
    }

    /// A feed that barely updates cannot settle a ROO intent. Saying so is the
    /// point. parameter.md 12 sets OPEN_REF_MIN_UPDATES to 2 for this reason.
    function test_openReferenceRefusesWhenTheFeedBarelyMoved() public {
        feed.push(200e8, DAY_OPEN - 1000);
        feed.push(210e8, DAY_OPEN + 100);

        vm.warp(DAY_OPEN + 1000);
        vm.expectRevert(
            abi.encodeWithSelector(PriceOracle.OpenReferenceNotEnoughUpdates.selector, nvda, DAY_INDEX, 1)
        );
        oracle.finalizeOpenReference(nvda, DAY_INDEX);

        (, bool available) = oracle.openReference(nvda, DAY_INDEX);
        assertFalse(available, "no reference is better than an invented one");
    }

    function test_openReferenceWaitsForTheWindowToClose() public {
        feed.push(200e8, DAY_OPEN + 10);
        feed.push(210e8, DAY_OPEN + 100);

        vm.warp(DAY_OPEN + 200);
        vm.expectRevert(
            abi.encodeWithSelector(PriceOracle.OpenReferenceWindowNotClosed.selector, nvda, DAY_INDEX)
        );
        oracle.finalizeOpenReference(nvda, DAY_INDEX);
    }

    function test_openReferenceIsWrittenOnce() public {
        feed.push(200e8, DAY_OPEN - 100);
        feed.push(210e8, DAY_OPEN + 100);
        feed.push(220e8, DAY_OPEN + 200);
        vm.warp(DAY_OPEN + 1000);
        oracle.finalizeOpenReference(nvda, DAY_INDEX);

        vm.expectRevert(abi.encodeWithSelector(PriceOracle.OpenReferenceAlreadySet.selector, nvda, DAY_INDEX));
        oracle.finalizeOpenReference(nvda, DAY_INDEX);
    }

    function test_openReferenceRejectsADayTheMarketNeverOpened() public {
        uint32 saturday = 20_526;
        vm.warp(WEEKEND + 3 days);
        vm.expectRevert(abi.encodeWithSelector(PriceOracle.NotATradingDay.selector, saturday));
        oracle.finalizeOpenReference(nvda, saturday);
    }

    function test_configurationIsGovernorOnlyAndStalenessIsBounded() public {
        vm.expectRevert(PriceOracle.NotGovernor.selector);
        oracle.setFeed(nvda, address(feed), 6000, 20_000);

        vm.prank(governor);
        vm.expectRevert(abi.encodeWithSelector(PriceOracle.StalenessOutOfRange.selector, uint32(599)));
        oracle.setFeed(nvda, address(feed), 599, 20_000);

        vm.prank(governor);
        vm.expectRevert(abi.encodeWithSelector(PriceOracle.StalenessOutOfRange.selector, uint32(200_001)));
        oracle.setFeed(nvda, address(feed), 6000, 200_001);
    }

    function test_unknownTokenRevertsRatherThanReturningZero() public {
        address unknown = address(0xDEAD);
        vm.warp(DAY_OPEN + 100);
        vm.expectRevert(abi.encodeWithSelector(PriceOracle.FeedNotSet.selector, unknown));
        oracle.refPrice(unknown);

        vm.prank(governor);
        oracle.setFeed(unknown, address(feed), 6000, 20_000);
        vm.expectRevert(abi.encodeWithSelector(PriceOracle.TwapSourceNotSet.selector, unknown));
        oracle.dualCheck(unknown);
    }
}
