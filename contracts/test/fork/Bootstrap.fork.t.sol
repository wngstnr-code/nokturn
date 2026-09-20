// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {AuctionHouse} from "../../src/AuctionHouse.sol";
import {PriceOracle} from "../../src/PriceOracle.sol";
import {SessionManager} from "../../src/SessionManager.sol";
import {Settlement} from "../../src/Settlement.sol";
import {SolverRegistry} from "../../src/SolverRegistry.sol";
import {Session} from "../../src/types/Types.sol";

import {Addresses} from "../../script/Addresses.sol";
import {Bootstrap} from "../../script/Bootstrap.s.sol";
import {Deploy} from "../../script/Deploy.s.sol";
import {ForkFixture} from "../fixtures/ForkFixture.sol";

/// @notice The deploy and its bootstrap against the real chain, which is the only
/// place the stock token gate and the pool registration mean anything. In memory
/// there is nothing at those addresses to check, so a passing test there would be
/// checking that nothing is nothing.
contract BootstrapForkTest is Test {
    Deploy internal deployScript;
    Bootstrap internal bootstrapScript;

    /// The address forge broadcasts from when no sender is given, which is what
    /// both scripts use under test. It holds the timelock roles here for the same
    /// reason a real operator would hold them, which is that scheduling and
    /// executing a batch at a delay of zero is one person doing two things.
    address internal signer = DEFAULT_SENDER;
    address internal treasury = address(0x7EA);
    address internal guardian = address(0x6A4D1A4);

    Deploy.Deployment internal d;

    function setUp() public {
        ForkFixture.selectMainnet();

        deployScript = new Deploy();
        bootstrapScript = new Bootstrap();

        // Every value Deploy reads is set here rather than left to the environment.
        // A fork test that borrows a developer dotenv passes on that laptop and
        // fails in CI, which is how the guardian went missing for a night.
        vm.setEnv("NOKTURN_TREASURY", vm.toString(treasury));
        vm.setEnv("NOKTURN_GUARDIAN", vm.toString(guardian));
        vm.setEnv("NOKTURN_TIMELOCK_PROPOSERS", vm.toString(signer));
        vm.setEnv("NOKTURN_TIMELOCK_EXECUTORS", vm.toString(signer));

        d = deployScript.run();

        bootstrapScript.runWith(d.timelock, d.sessions, d.settlement, d.auctionHouse, d.solvers, d.adapter);
    }

    /// Every allowlist token passed the beacon and multiplier gate on the way in,
    /// because the bootstrap refuses to build the batch otherwise.
    function test_theAllowlistIsAllowedInBothVenues() public view {
        address[] memory tokens = Addresses.allowlist();
        for (uint256 k = 0; k < tokens.length; ++k) {
            assertTrue(Settlement(d.settlement).tokenAllowed(tokens[k]), "settlement");
            assertTrue(AuctionHouse(d.auctionHouse).auctionTokenAllowed(tokens[k]), "auction house");
        }
        assertTrue(Settlement(d.settlement).tokenAllowed(Addresses.USDG), "usdg is the quote side");
        assertTrue(Settlement(d.settlement).adapterAllowed(d.adapter), "adapter");
    }

    /// The registry learns the settlement address once and refuses to learn it
    /// again, which is why it is in the batch rather than left to a later call.
    function test_theRegistryKnowsTheSettlementAndWillNotBeToldTwice() public {
        assertEq(SolverRegistry(d.solvers).settlement(), d.settlement, "wired");
        vm.prank(d.timelock);
        vm.expectRevert(SolverRegistry.SettlementAlreadySet.selector);
        SolverRegistry(d.solvers).setSettlement(address(0xdead));
    }

    /// The calendar answers for a real holiday and a real trading day, which is
    /// the only way to tell a loaded table from an empty one.
    function test_theCalendarIsLoadedAndAnswersForRealDays() public view {
        SessionManager sessions = SessionManager(d.sessions);
        // Noon New York on Christmas Day 2026, a Friday the table calls a holiday.
        assertEq(uint8(sessions.sessionAt(1_798_218_000)), uint8(Session.HOLIDAY), "christmas 2026");
        // Ten in the morning New York on the Monday after it, an ordinary day.
        assertEq(uint8(sessions.sessionAt(1_798_470_000)), uint8(Session.OPEN), "ordinary monday");
    }

    /// Stated as a test rather than as a comment, because the one thing that must
    /// not be quietly true after a bootstrap is a configured oracle. parameter.md
    /// section 7.1 says not to lock these before P6-1 is answered.
    function test_theFeedsAreDeliberatelyLeftUnset() public {
        vm.expectRevert(abi.encodeWithSelector(PriceOracle.FeedNotSet.selector, Addresses.NVDA));
        PriceOracle(d.oracle).stalenessLimit(Addresses.NVDA);
    }

    function test_theBootstrapWindowIsStillOpenAfterwards() public view {
        assertEq(TimelockController(payable(d.timelock)).getMinDelay(), 0, "lock is a later step");
    }
}
