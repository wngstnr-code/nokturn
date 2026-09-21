// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {AggregatorV3Interface} from "../../src/interfaces/AggregatorV3Interface.sol";
import {PriceOracle} from "../../src/PriceOracle.sol";

import {Addresses} from "../../script/Addresses.sol";
import {Bootstrap} from "../../script/Bootstrap.s.sol";
import {Deploy} from "../../script/Deploy.s.sol";
import {Lock} from "../../script/Lock.s.sol";
import {SetFeeds} from "../../script/SetFeeds.s.sol";
import {ForkFixture} from "../fixtures/ForkFixture.sol";

/// @notice The feed proposal against the real chain, run the way it will be run,
/// which is after the delay is already forty eight hours.
///
/// It belongs on a fork rather than in memory because the thing worth checking is
/// that the four addresses in Addresses are the four Chainlink proxies for the four
/// tokens in the allowlist. A mock aggregator would answer whatever it was built to
/// answer and prove nothing about that.
contract SetFeedsForkTest is Test {
    address internal signer = DEFAULT_SENDER;
    address internal treasury = address(0x7EA);
    address internal guardian = address(0x6A4D1A4);

    Deploy.Deployment internal d;
    SetFeeds internal script;

    function setUp() public {
        ForkFixture.selectMainnet();

        // Every value Deploy reads is set here rather than left to the environment.
        // A fork test that borrows a developer dotenv passes on that laptop and
        // fails in CI, which is how the guardian went missing for a night.
        vm.setEnv("NOKTURN_TREASURY", vm.toString(treasury));
        vm.setEnv("NOKTURN_GUARDIAN", vm.toString(guardian));
        vm.setEnv("NOKTURN_TIMELOCK_PROPOSERS", vm.toString(signer));
        vm.setEnv("NOKTURN_TIMELOCK_EXECUTORS", vm.toString(signer));

        d = new Deploy().run();
        new Bootstrap().runWith(d.timelock, d.sessions, d.settlement, d.auctionHouse, d.solvers, d.adapter);
        new Lock().runWith(d.timelock);

        script = new SetFeeds();
    }

    /// Each proxy describes the Robinhood token rather than the ordinary share, and
    /// each carries the eight decimals PriceOracle assumes. Reading description is
    /// the only way to tell one from the other, since both families quote the same
    /// ticker at addresses that look alike.
    function test_everyFeedIsTheRobinhoodOneAndEightDecimals() public view {
        address[] memory aggregators = Addresses.feeds();
        string[5] memory expected = [
            "RHNVDA / USD",
            "Robinhood AAPL / USD",
            "RHTSLA / USD",
            "Robinhood GOOGL / USD",
            "Robinhood GME / USD"
        ];

        for (uint256 k = 0; k < aggregators.length; ++k) {
            AggregatorV3Interface feed = AggregatorV3Interface(aggregators[k]);
            assertEq(feed.description(), expected[k], "wrong feed for this slot");
            assertEq(feed.decimals(), 8, "decimals");
            (, int256 answer,,,) = feed.latestRoundData();
            assertGt(answer, 0, "feed answers");
        }
    }

    /// The proposal cannot be rushed. Scheduling it is one transaction and executing
    /// it is another, two days later, and that is the whole point of holding the
    /// feeds back out of the bootstrap.
    function test_theProposalHasToWaitOutTheFullDelay() public {
        script.runWith(d.timelock, d.oracle, d.adapter);

        (address[] memory targets, uint256[] memory values, bytes[] memory payloads) =
            script.batch(d.oracle, d.adapter);
        TimelockController timelock = TimelockController(payable(d.timelock));
        // Read into a local before the expectRevert below. A call inside the
        // argument list is the call expectRevert binds to, and this has bitten
        // this repo twice already.
        bytes32 salt = script.SALT();
        bytes32 id = timelock.hashOperationBatch(targets, values, payloads, bytes32(0), salt);

        assertTrue(timelock.isOperationPending(id), "scheduled");
        assertFalse(timelock.isOperationReady(id), "not ready on the same day");

        vm.expectRevert();
        timelock.executeBatch(targets, values, payloads, bytes32(0), salt);

        vm.warp(block.timestamp + 48 hours);
        assertTrue(timelock.isOperationReady(id), "ready after the delay");
    }

    /// The values that land on chain are the values parameter.md section 7.1 holds,
    /// per token and in the right order. A feed table that drifts out of step with
    /// the token table configures the wrong token against the wrong price and
    /// nothing reverts, so the order is asserted rather than assumed.
    function test_whatLandsIsWhatTheParameterDocSays() public {
        script.runWith(d.timelock, d.oracle, d.adapter);
        vm.warp(block.timestamp + 48 hours);
        script.runWith(d.timelock, d.oracle, d.adapter);

        PriceOracle oracle = PriceOracle(d.oracle);
        address[] memory tokens = Addresses.allowlist();
        address[] memory aggregators = Addresses.feeds();
        uint32[] memory open = Addresses.stalenessOpen();
        uint32[] memory closed = Addresses.stalenessClosed();

        for (uint256 k = 0; k < tokens.length; ++k) {
            (address aggregator, uint32 stalenessOpen, uint32 stalenessClosed) = oracle.feeds(tokens[k]);
            assertEq(aggregator, aggregators[k], "aggregator");
            assertEq(stalenessOpen, open[k], "staleness open");
            assertEq(stalenessClosed, closed[k], "staleness closed");

            (address adapter, address quoteToken, uint32 window) = oracle.twapSources(tokens[k]);
            assertEq(adapter, d.adapter, "twap adapter");
            assertEq(quoteToken, Addresses.USDG, "twap quote side");
            assertEq(window, Addresses.TWAP_WINDOW, "twap window");
        }

        // The quote asset is priced too, and deliberately without a twap source.
        // Settlement reads refPrice for every token in a solution and USDG is always
        // one of them, so an oracle that cannot answer for USDG settles nothing in
        // any session. It has no pool against itself to read a twap from, which is
        // what the frozen branch checks for before it looks. parameter.md 7.1.
        (address quoteAggregator, uint32 quoteOpen, uint32 quoteClosed) = oracle.feeds(Addresses.quote());
        assertEq(quoteAggregator, Addresses.FEED_USDG, "usdg aggregator");
        assertEq(quoteOpen, Addresses.STALENESS_USDG, "usdg staleness open");
        assertEq(quoteClosed, Addresses.STALENESS_USDG, "usdg staleness closed");

        (address quoteTwap,,) = oracle.twapSources(Addresses.quote());
        assertEq(quoteTwap, address(0), "usdg must have no twap source");
    }

    /// Both sources arrive together. An oracle holding a feed and no TWAP has no
    /// second opinion on a weekday and no price at all on a weekend, which is the
    /// one shape section 7.3 cannot survive.
    function test_neitherSourceCanArriveWithoutTheOther() public {
        (address[] memory targets,,) = script.batch(d.oracle, d.adapter);
        // One feed and one twap source per allowlisted token, plus the feed for the
        // quote asset. USDG gets no twap source because it has no pool against
        // itself, which is the whole reason the frozen branch checks for one.
        // parameter.md section 7.1.
        assertEq(
            targets.length, Addresses.allowlist().length * 2 + 1, "one feed and one twap per token, plus usdg"
        );
    }
}
