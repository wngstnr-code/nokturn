// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";
import {AuctionHouse} from "../../src/AuctionHouse.sol";
import {PriceOracle} from "../../src/PriceOracle.sol";
import {SessionManager} from "../../src/SessionManager.sol";
import {IPriceOracle} from "../../src/interfaces/IPriceOracle.sol";
import {ISessionManager} from "../../src/interfaces/ISessionManager.sol";
import {ISignatureTransfer} from "../../src/interfaces/IPermit2.sol";
import {ISolverRegistry} from "../../src/interfaces/ISolverRegistry.sol";
import {CalendarFixture} from "../../script/Calendar.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockPermit2} from "../mocks/MockPermit2.sol";
import {MockSolverRegistry} from "../mocks/MockSolverRegistry.sol";
import {MockSwapAdapter} from "../mocks/MockSwapAdapter.sol";
import {AuctionHandler} from "./AuctionHandler.sol";

/// @notice Invariants I10 and I13 from rencana-uji.md section 1. The auction is the
/// only place in the protocol that takes custody of anything for longer than one
/// transaction, so the escrow claim is the one that has to hold under every ending
/// the state machine can reach.
contract AuctionInvariants is Test {
    SessionManager sessions;
    PriceOracle oracle;
    AuctionHouse house;
    MockPermit2 permit2;
    MockSolverRegistry registry;
    MockSwapAdapter twapSource;

    MockERC20 usdg;
    MockERC20 nvda;
    MockAggregator usdgFeed;
    MockAggregator nvdaFeed;

    AuctionHandler handler;

    address governor = address(0x60174E);
    address treasury = address(0x7EA);
    address guardian = address(0x6A4D1A4);
    address solver = address(0x501E);
    address challenger = address(0xC4A11);

    uint64 constant BELL = 1_773_235_800;
    uint64 constant AUCTION_OPEN_AT = BELL - 1800;

    function setUp() public {
        sessions = new SessionManager(governor);
        vm.startPrank(governor);
        sessions.setDstBoundaries(CalendarFixture.loadDst());
        CalendarFixture.loadCalendar(sessions, CalendarFixture.loadDays());
        vm.stopPrank();

        usdg = new MockERC20("Global Dollar", "USDG", 6);
        nvda = new MockERC20("Nvidia", "NVDA", 18);
        usdgFeed = new MockAggregator(8, "USDG / USD");
        nvdaFeed = new MockAggregator(8, "RHNVDA / USD");

        twapSource = new MockSwapAdapter();
        twapSource.setRate(address(usdg), address(nvda), 1e18);
        twapSource.setRate(address(nvda), address(usdg), 200e18);

        oracle = new PriceOracle(ISessionManager(address(sessions)), governor);
        vm.startPrank(governor);
        oracle.setFeed(address(usdg), address(usdgFeed), 6000, 20_000);
        oracle.setFeed(address(nvda), address(nvdaFeed), 6000, 20_000);
        oracle.setTwapSource(address(usdg), address(twapSource), address(nvda), 1800);
        oracle.setTwapSource(address(nvda), address(twapSource), address(usdg), 1800);
        vm.stopPrank();

        registry = new MockSolverRegistry();
        registry.setActive(solver, true);
        permit2 = new MockPermit2();

        house = new AuctionHouse(
            ISessionManager(address(sessions)),
            IPriceOracle(address(oracle)),
            ISolverRegistry(address(registry)),
            ISignatureTransfer(address(permit2)),
            IERC20(address(usdg)),
            treasury,
            governor,
            guardian
        );
        vm.prank(governor);
        house.setAuctionTokenAllowed(address(nvda), true);

        vm.warp(AUCTION_OPEN_AT + 60);
        usdgFeed.push(1e8, block.timestamp);
        nvdaFeed.push(200e8, block.timestamp);

        uint256[5] memory keys =
            [uint256(0xA11CE), uint256(0xB0B), uint256(0xCA401), uint256(0xDA3E), uint256(0xE61)];

        handler = new AuctionHandler(
            house, sessions, oracle, permit2, usdg, nvda, usdgFeed, nvdaFeed, solver, challenger, keys
        );

        usdg.mint(solver, 1_000_000e6);
        usdg.mint(challenger, 1_000_000e6);
        vm.prank(solver);
        usdg.approve(address(house), type(uint256).max);
        vm.prank(challenger);
        usdg.approve(address(house), type(uint256).max);

        targetContract(address(handler));
    }

    /// I10. Whatever the auction did, the escrow that has not been filled and has
    /// not been refunded is still sitting here. An auction that could not cross must
    /// not be able to keep the money either, and the refund is open to anyone, so
    /// the balance is what has to carry the claim rather than anyone's good faith.
    function invariant_theHouseAlwaysHoldsEveryEscrowItHasNotPaidOut() public view {
        (uint256 quoteOwed, uint256 baseOwed) = _outstandingEscrow();
        assertGe(usdg.balanceOf(address(house)), quoteOwed, "quote escrow is not all here");
        assertGe(nvda.balanceOf(address(house)), baseOwed, "token escrow is not all here");
    }

    /// The refund path is idempotent by construction, and the ghost counter is what
    /// would catch it if the flag ever stopped being read.
    function invariant_noEscrowIsEverRefundedTwice() public view {
        assertEq(handler.doubleRefunds(), 0, "an escrow was refunded twice");
    }

    /// Nothing is ever filled beyond what its owner escrowed, on any path, including
    /// the one where a challenge rolled a cross back and a second cross replaced it.
    function invariant_noCommitmentIsFilledBeyondItsEscrow() public view {
        uint256 n = handler.committedCount();
        for (uint256 k = 0; k < n; ++k) {
            AuctionHandler.Committed memory rec = handler.committedAt(k);
            AuctionHouse.Commitment memory c = house.commitment(rec.intentHash);
            assertLe(c.filledSell, c.sellAmount, "a commitment was overfilled");
            assertEq(c.sellAmount, rec.sellAmount, "the escrow amount moved after the commit");
        }
    }

    /// An aborted auction has no fills left anywhere in its book, so the refund can
    /// hand every owner the whole amount back rather than a remainder.
    function invariant_anAbortedAuctionLeavesNothingHalfFilled() public view {
        uint256 n = handler.committedCount();
        for (uint256 k = 0; k < n; ++k) {
            AuctionHandler.Committed memory rec = handler.committedAt(k);
            (,, uint8 phase,,,) = house.auctionState(rec.auctionId);
            if (phase != uint8(5)) continue; // ABORTED
            AuctionHouse.Commitment memory c = house.commitment(rec.intentHash);
            assertEq(c.filledSell, 0, "an aborted auction kept a fill");
            assertEq(c.filledBuy, 0, "an aborted auction kept a delivery");
        }
    }

    /// I13. A print is published only above both floors, and the flag the Chainlink
    /// surface answers with is the same one. A consumer reading a thin cross as a
    /// closing price is the failure this whole surface exists to avoid.
    function invariant_noPrintIsPublishedBelowItsFloors() public view {
        uint256 n = handler.auctionCount();
        for (uint256 k = 0; k < n; ++k) {
            (address token,,, uint32 day,,) = house.auctionState(handler.auctionAt(k));
            if (token == address(0)) continue;
            (, uint256 volume, uint32 participants, bool sufficient) = house.closingPrice(token, day);
            if (!sufficient) continue;
            assertGe(volume, house.printMinVolume(), "a print published under the volume floor");
            assertGe(
                participants, house.PRINT_MIN_PARTICIPANTS(), "a print published under the participant floor"
            );
        }
    }

    /// The bond is quote denominated and sits in the same contract as the quote
    /// escrow, so the treasury only ever receives the losing half of a challenge.
    /// @dev A challenge takes half a bond to the protocol whichever way it goes.
    /// A wrong one forfeits what the challenger posted and a right one forfeits what
    /// the solver posted, and in both cases the other half pays whoever was right.
    /// The bound counts challenges for that reason. Leaving them out made this read
    /// as a claim about executions and aborts alone, and it held only until the
    /// campaign ran three challenges without an execution beside them.
    function invariant_theTreasuryOnlyGrowsFromDustAndLostBonds() public view {
        uint256 bondEvents = handler.crossesExecuted() + handler.auctionsAborted() + handler.challengesHeard();
        assertLe(
            usdg.balanceOf(treasury),
            house.bond() * (bondEvents + 1),
            "the treasury took more than the bonds that passed through"
        );
    }

    /// The campaign has to reach a cross and a refund for the escrow invariants to
    /// be about anything, so a fixed sequence pins that both are reachable.
    function test_theHandlerCrossesAndRefunds() public {
        handler.actRunAuction(0x200);
        assertGt(handler.crossesExecuted(), 0, "the handler never executed a cross");

        handler.actRunAuction(0);
        assertGt(handler.auctionsAborted(), 0, "the handler never aborted an auction");
        handler.actRefund(0);
        assertGt(handler.refundsPaid(), 0, "the handler never refunded an escrow");
        assertEq(handler.doubleRefunds(), 0, "and it refunded one of them twice");
    }

    /// I13 is about a print that must not be published, so the run has to be able
    /// to publish one. A close auction with five owners and enough volume behind it
    /// is the case the floors were written for.
    function test_aCloseAuctionThickEnoughDoesPublishItsPrint() public {
        handler.actRunAuction(0x201 | (uint256(40) << 32));
        assertGt(handler.printsPublished(), 0, "the handler never published a print");
    }

    function _outstandingEscrow() internal view returns (uint256 quoteOwed, uint256 baseOwed) {
        uint256 n = handler.committedCount();
        for (uint256 k = 0; k < n; ++k) {
            AuctionHandler.Committed memory rec = handler.committedAt(k);
            AuctionHouse.Commitment memory c = house.commitment(rec.intentHash);
            if (!c.escrowed || c.refunded) continue;
            uint256 owed = c.sellAmount - c.filledSell;
            if (rec.sellToken == address(usdg)) quoteOwed += owed;
            else baseOwed += owed;
        }
    }
}
