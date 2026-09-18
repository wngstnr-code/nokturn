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

    /// The Orbit sequencer sets block.timestamp, so a round can carry a stamp a
    /// few seconds ahead of the block it is read in. Early is not stale, and the
    /// subtraction that would have panicked here took every batch on the token with
    /// it. Found by the settlement invariant run.
    function test_aRoundStampedAheadOfTheBlockIsEarlyRatherThanStale() public {
        vm.warp(DAY_OPEN + 1000);
        feed.push(21_304_000_000, DAY_OPEN + 1030);

        (uint256 price, uint64 ts, bool healthy) = oracle.refPrice(nvda);
        assertEq(price, 213.04e18);
        assertEq(ts, DAY_OPEN + 1030);
        assertTrue(healthy);
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

    // ---- boundaries, one assertion each, from the mutation run ----

    /// Fifteen hundred basis points is the weekend drift cap, and a token sitting
    /// exactly on it is still healthy. parameter.md 7.2 picked that number because
    /// TSLA drifts 781 over a real weekend, so the edge has to be inclusive.
    function test_driftExactlyOnTheWeekendCapIsStillHealthy() public {
        vm.warp(WEEKEND);
        feed.push(200e8, WEEKEND - 1 days);
        // Fifteen percent below the Friday close is exactly the cap.
        adapter.setTwap(170e18);

        (uint256 price,, bool healthy) = oracle.refPrice(nvda);
        assertEq(price, 170e18, "the weekend answer is the pool, not the frozen feed");
        assertTrue(healthy, "a drift of exactly the cap is inside it");

        adapter.setTwap(169.9e18);
        (,, healthy) = oracle.refPrice(nvda);
        assertFalse(healthy, "one step past the cap is outside it");
    }

    /// A round whose age is exactly the staleness limit is fresh. One second more
    /// is not.
    function test_ageExactlyOnTheStalenessLimitIsStillFresh() public {
        feed.push(200e8, DAY_OPEN);
        vm.warp(DAY_OPEN + STALENESS_OPEN);
        (,, bool healthy) = oracle.refPrice(nvda);
        assertTrue(healthy, "exactly the limit is inside it");

        vm.warp(DAY_OPEN + STALENESS_OPEN + 1);
        (,, healthy) = oracle.refPrice(nvda);
        assertFalse(healthy, "one second past it is not");
    }

    /// Fifty basis points is the disagreement limit inside OPEN, and two sources
    /// exactly that far apart still agree.
    function test_disagreementExactlyOnTheLimitStillAgrees() public {
        vm.warp(DAY_OPEN + 60);
        feed.push(200e8, DAY_OPEN + 30);
        // A dollar away from two hundred, measured against the larger of the two,
        // is exactly fifty basis points.
        adapter.setTwap(199e18);

        (,, bool agree) = oracle.dualCheck(nvda);
        assertTrue(agree, "exactly the limit is agreement");

        adapter.setTwap(198.9e18);
        (,, agree) = oracle.dualCheck(nvda);
        assertFalse(agree, "past it is not");
    }

    /// The opening reference window closes at its last second, and the call is
    /// allowed from that second on rather than one after it.
    function test_theOpenReferenceWindowIsClosedOnItsLastSecond() public {
        feed.push(200e8, DAY_OPEN - 10);
        feed.push(201e8, DAY_OPEN + 100);
        feed.push(202e8, DAY_OPEN + 200);

        vm.warp(DAY_OPEN + 299);
        vm.expectRevert(
            abi.encodeWithSelector(PriceOracle.OpenReferenceWindowNotClosed.selector, nvda, DAY_INDEX)
        );
        oracle.finalizeOpenReference(nvda, DAY_INDEX);

        vm.warp(DAY_OPEN + 300);
        assertGt(oracle.finalizeOpenReference(nvda, DAY_INDEX), 0, "the window is closed on its edge");
    }

    /// A round stamped on the closing second of the window is inside it, and one
    /// stamped on the opening second counts towards the update floor.
    function test_roundsOnBothEdgesOfTheWindowCount() public {
        feed.push(200e8, DAY_OPEN - 10);
        feed.push(210e8, DAY_OPEN); // exactly the first second of the window
        feed.push(220e8, DAY_OPEN + 300); // exactly the last

        vm.warp(DAY_OPEN + 300);
        uint256 price = oracle.finalizeOpenReference(nvda, DAY_INDEX);
        assertEq(price, 210e18, "the round on the opening second held the window");
    }

    /// Two sources cannot be compared when one of them is missing, and a missing
    /// source is not the same as a source that reads zero away.
    function test_aMissingSourceIsTheWidestPossibleDisagreement() public {
        vm.warp(DAY_OPEN + 60);
        feed.push(200e8, DAY_OPEN + 30);
        adapter.setTwap(0);

        (,, bool agree) = oracle.dualCheck(nvda);
        assertFalse(agree, "nothing to compare against is not agreement");
    }

    /// The staleness bounds are inclusive at both ends, which is what makes six
    /// hundred and two hundred thousand the stated range rather than the open one.
    function test_theStalenessBoundsAreInclusive() public {
        vm.startPrank(governor);
        oracle.setFeed(usdg, address(feed), 600, 200_000);

        vm.expectRevert(abi.encodeWithSelector(PriceOracle.StalenessOutOfRange.selector, uint32(599)));
        oracle.setFeed(usdg, address(feed), 599, 200_000);

        vm.expectRevert(abi.encodeWithSelector(PriceOracle.StalenessOutOfRange.selector, uint32(200_001)));
        oracle.setFeed(usdg, address(feed), 600, 200_001);
        vm.stopPrank();
    }

    /// A feed carrying more than eighteen decimals is scaled down rather than up.
    /// No allowlist feed does today, and the branch exists so that one arriving
    /// later is a configuration change rather than a silent factor of 1e4.
    function test_aFeedWithMoreThanEighteenDecimalsIsScaledDown() public {
        MockAggregator wide = new MockAggregator(20, "WIDE / USD");
        vm.prank(governor);
        oracle.setFeed(usdg, address(wide), STALENESS_OPEN, STALENESS_CLOSED);

        wide.push(200e20, DAY_OPEN);
        vm.warp(DAY_OPEN + 60);
        (uint256 price,,) = oracle.refPrice(usdg);
        assertEq(price, 200e18, "twenty decimals divides down to eighteen");
    }

    /// The opening reference walks at most sixteen rounds back. A feed that
    /// updated more often than that inside the window is answered from the most
    /// recent sixteen, not from all of them, and the bound has to be the number
    /// the contract actually stops at.
    function test_theOpenReferenceStopsAfterSixteenRounds() public {
        feed.push(100e8, DAY_OPEN - 10);
        // Twenty rounds fifteen seconds apart fill the whole five minute window.
        for (uint256 k = 0; k < 20; ++k) {
            feed.push(int256(200e8 + int256(k) * 1e8), DAY_OPEN + k * 15);
        }

        vm.warp(DAY_OPEN + 300);
        uint256 price = oracle.finalizeOpenReference(nvda, DAY_INDEX);
        // The window is three hundred seconds. The last sixteen rounds cover the
        // final two hundred and forty of them, and everything before that is
        // beyond the walk, so it contributes nothing at all.
        assertEq(price, 211.5e18, "the walk stopped at sixteen rounds");
    }
}
