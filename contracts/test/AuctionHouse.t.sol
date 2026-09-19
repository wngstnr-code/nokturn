// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AuctionHouse} from "../src/AuctionHouse.sol";
import {ClosingPrintFeed} from "../src/ClosingPrintFeed.sol";
import {PriceOracle} from "../src/PriceOracle.sol";
import {SessionManager} from "../src/SessionManager.sol";
import {IAuctionHouse} from "../src/interfaces/IAuctionHouse.sol";
import {IPriceOracle} from "../src/interfaces/IPriceOracle.sol";
import {ISessionManager} from "../src/interfaces/ISessionManager.sol";
import {ISignatureTransfer} from "../src/interfaces/IPermit2.sol";
import {ISolverRegistry} from "../src/interfaces/ISolverRegistry.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IntentLib} from "../src/libraries/IntentLib.sol";
import {Permit2Witness} from "../src/libraries/Permit2Witness.sol";
import {Execution, Intent, IntentFlags, IntentKind, SessionMask} from "../src/types/Types.sol";
import {CalendarFixture} from "./fixtures/CalendarFixture.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockPermit2} from "./mocks/MockPermit2.sol";
import {MockSolverRegistry} from "./mocks/MockSolverRegistry.sol";
import {MockSwapAdapter} from "./mocks/MockSwapAdapter.sol";
import {AuctionFixture} from "./fixtures/AuctionFixture.sol";

contract AuctionHouseTest is AuctionFixture {
    function test_openCrossClearsBothSidesAtOneUniformPrice() public {
        _buyMoo(alice, 400e6, 1);
        _sellMoo(bob, 2e18, 2);
        uint64 id = _openAndFreeze();
        _passOpeningReference(200e8);

        Execution[] memory e = new Execution[](2);
        e[0] = _exec(0, 400e6, 2e18);
        e[1] = _exec(1, 2e18, 400e6);

        vm.prank(solver);
        house.submitCross(id, 200e6, e);

        vm.warp(block.timestamp + 121);
        vm.expectEmit(true, true, false, true);
        emit IAuctionHouse.CrossExecuted(id, address(nvda), 200e6, 400e6, 2);
        house.executeCross(id);

        assertEq(nvda.balanceOf(alice), 2e18, "the buyer got the shares");
        assertEq(usdg.balanceOf(bob), 400e6, "the seller got the cash");
        assertEq(usdg.balanceOf(solver), 10_000e6, "the cross bond came back");
    }

    /// The whole point of the disclosure phase. Nothing is escrowed yet and the
    /// number still has to be published, because it is the invitation.
    function test_indicativePublishesTheImbalanceBeforeAnythingIsEscrowed() public {
        _buyMoo(alice, 1000e6, 1);
        _sellMoo(bob, 1e18, 2);
        uint64 id = house.auctionIdOf(address(nvda), DAY, kindOpen);
        house.openAuction(address(nvda), kindOpen);

        (uint256 price, uint256 matched, int256 imbalance) = house.indicative(id);
        assertEq(price, 200e6, "no limit in the book, so the reference clears it");
        assertEq(matched, 1e18, "one share is all that can trade");
        assertEq(imbalance, int256(4e18), "five wanted, one offered");

        vm.expectEmit(true, true, false, true);
        emit IAuctionHouse.IndicativePublished(id, address(nvda), 200e6, int256(4e18), 1e18);
        house.publishIndicative(id);
    }

    /// The commit checks that the funds are there, but funds can still leave before
    /// the freeze. The auction says so out loud instead of carrying a number it
    /// cannot back.
    function test_freezeDropsACommitmentWhoseFundsLeft() public {
        bytes32 gone = _buyMoo(alice, 400e6, 1);
        _sellMoo(bob, 2e18, 2);
        uint64 id = house.auctionIdOf(address(nvda), DAY, kindOpen);
        house.openAuction(address(nvda), kindOpen);

        uint256 aliceBalance = usdg.balanceOf(alice);
        vm.prank(alice);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        usdg.transfer(carol, aliceBalance);

        vm.warp(FREEZE_AT);
        _pushFeeds(200e8, uint64(block.timestamp));
        vm.expectEmit(true, true, false, true);
        emit IAuctionHouse.CommitmentDropped(id, gone, "escrow pull failed");
        house.freeze(id);

        (, uint256 matched,) = house.indicative(id);
        assertEq(matched, 0, "the frozen book has one side only");
        assertFalse(house.commitment(gone).escrowed);
    }

    function test_cancelBeforeFreezeIsTheOwnersOnlyAndTheDeadlineIsReal() public {
        bytes32 hash = _buyMoo(alice, 400e6, 1);
        uint64 id = house.auctionIdOf(address(nvda), DAY, kindOpen);
        house.openAuction(address(nvda), kindOpen);

        vm.expectRevert(abi.encodeWithSelector(AuctionHouse.NotCommitmentOwner.selector, hash));
        house.cancelBeforeFreeze(hash);

        vm.prank(alice);
        house.cancelBeforeFreeze(hash);
        assertTrue(house.commitment(hash).cancelled);

        bytes32 second = _sellMoo(bob, 1e18, 2);
        vm.warp(FREEZE_AT);
        _pushFeeds(200e8, uint64(block.timestamp));
        house.freeze(id);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(AuctionHouse.WrongPhase.selector, id, uint8(2)));
        house.cancelBeforeFreeze(second);
    }

    function test_commitNeedsFundsThatPermit2CanAlreadyReach() public {
        Intent memory i = _intent(alice, true, 400e6, 0, IntentKind.MOO, 0, SessionMask.AUCTION_OPEN, 1);
        vm.prank(alice);
        usdg.approve(address(permit2), 0);

        vm.expectRevert(
            abi.encodeWithSelector(AuctionHouse.NotCoveredByPermit2.selector, alice, address(usdg))
        );
        house.commitAuctionIntent(i, hex"00");
    }

    function test_onlyAnActiveSolverCanSubmitACross() public {
        _buyMoo(alice, 400e6, 1);
        _sellMoo(bob, 2e18, 2);
        uint64 id = _openAndFreeze();
        _passOpeningReference(200e8);

        Execution[] memory e = new Execution[](2);
        e[0] = _exec(0, 400e6, 2e18);
        e[1] = _exec(1, 2e18, 400e6);

        vm.expectRevert(abi.encodeWithSelector(AuctionHouse.SolverNotActive.selector, address(this)));
        house.submitCross(id, 200e6, e);
    }

    function test_executionWaitsOutTheChallengeWindow() public {
        _buyMoo(alice, 400e6, 1);
        _sellMoo(bob, 2e18, 2);
        uint64 id = _openAndFreeze();
        _passOpeningReference(200e8);

        Execution[] memory e = new Execution[](2);
        e[0] = _exec(0, 400e6, 2e18);
        e[1] = _exec(1, 2e18, 400e6);
        vm.prank(solver);
        house.submitCross(id, 200e6, e);

        uint64 opensAt = uint64(block.timestamp) + 120;
        vm.expectRevert(abi.encodeWithSelector(AuctionHouse.TooEarly.selector, opensAt + 1));
        house.executeCross(id);

        vm.warp(opensAt + 1);
        house.executeCross(id);
    }

    function _buyLoo(address owner, uint256 usdgAmount, uint256 minToken, uint256 nonce)
        internal
        returns (bytes32)
    {
        return _commit(
            _intent(owner, true, usdgAmount, minToken, IntentKind.LOO, 0, SessionMask.AUCTION_OPEN, nonce)
        );
    }

    function _sellLoo(address owner, uint256 tokenAmount, uint256 minQuote, uint256 nonce)
        internal
        returns (bytes32)
    {
        return _commit(
            _intent(owner, false, tokenAmount, minQuote, IntentKind.LOO, 0, SessionMask.AUCTION_OPEN, nonce)
        );
    }

    /// One buyer who takes any price, and two sellers who do not. The higher price
    /// brings the second seller out, so it trades twice the volume. This is the
    /// book every challenge test below runs on.
    function _twoTieredBook() internal returns (uint64 id) {
        _buyMoo(alice, 900e6, 1);
        _sellLoo(bob, 2e18, 400e6, 2);
        _sellLoo(carol, 2e18, 404e6, 3);
        id = _openAndFreeze();
        _passOpeningReference(200e8);
    }

    function _thinCross(uint64 id) internal {
        Execution[] memory e = new Execution[](2);
        e[0] = _exec(0, 400e6, 2e18);
        e[1] = _exec(1, 2e18, 400e6);
        vm.prank(solver);
        house.submitCross(id, 200e6, e);
    }

    function test_limitOnOpenIsNeverFilledThroughItsLimit() public {
        _buyLoo(alice, 402e6, 2e18, 1);
        _sellMoo(bob, 2e18, 2);
        uint64 id = _openAndFreeze();
        _passOpeningReference(201e8);

        Execution[] memory e = new Execution[](2);
        e[0] = _exec(0, 402e6, 2e18);
        e[1] = _exec(1, 2e18, 402e6);

        vm.prank(solver);
        vm.expectRevert(
            abi.encodeWithSelector(AuctionHouse.LimitNotRespected.selector, uint256(0), 201e6, 202e6)
        );
        house.submitCross(id, 202e6, e);

        e[0] = _exec(0, 402e6, 2e18);
        e[1] = _exec(1, 2e18, 402e6);
        vm.prank(solver);
        house.submitCross(id, 201e6, e);
    }

    /// The opening reference is a time weighted feed over the first 300 seconds of
    /// the session. When the feed does not move twice inside it there is no
    /// reference, and a relative limit with nothing to be relative to is dropped
    /// rather than guessed at.
    function test_referenceOnOpenIsDroppedWhenTheReferenceNeverForms() public {
        bytes32 roo = _commit(_intent(alice, true, 400e6, 0, IntentKind.ROO, 50, SessionMask.AUCTION_OPEN, 1));
        _buyMoo(carol, 400e6, 2);
        _sellMoo(bob, 2e18, 3);
        uint64 id = _openAndFreeze();
        _passOpeningReferenceWithoutUpdates();

        Execution[] memory bad = new Execution[](2);
        bad[0] = _exec(0, 400e6, 2e18);
        bad[1] = _exec(2, 2e18, 400e6);
        vm.prank(solver);
        vm.expectRevert(
            abi.encodeWithSelector(AuctionHouse.LimitNotRespected.selector, uint256(0), uint256(0), 200e6)
        );
        house.submitCross(id, 200e6, bad);

        Execution[] memory e = new Execution[](2);
        e[0] = _exec(1, 400e6, 2e18);
        e[1] = _exec(2, 2e18, 400e6);
        vm.prank(solver);
        house.submitCross(id, 200e6, e);

        vm.warp(block.timestamp + 121);
        house.executeCross(id);

        house.refundEscrow(roo);
        assertEq(usdg.balanceOf(alice), 100_000e6, "the dropped intent got everything back");
    }

    function test_collarHoldsUntilAnExtensionWidensIt() public {
        _buyMoo(alice, 410e6, 1);
        _sellMoo(bob, 2e18, 2);
        uint64 id = _openAndFreeze();
        _passOpeningReference(200e8);

        Execution[] memory e = new Execution[](2);
        e[0] = _exec(0, 410e6, 2e18);
        e[1] = _exec(1, 2e18, 410e6);

        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(AuctionHouse.PriceOutsideCollar.selector, 205e6, 196e6, 204e6));
        house.submitCross(id, 205e6, e);

        vm.expectRevert(abi.encodeWithSelector(AuctionHouse.TooEarly.selector, REFERENCE_AT + 300));
        house.extend(id);

        vm.warp(REFERENCE_AT + 300);
        vm.expectEmit(true, false, false, true);
        emit IAuctionHouse.AuctionExtended(id, 1, 250);
        house.extend(id);

        vm.prank(solver);
        house.submitCross(id, 205e6, e);
    }

    /// Maximum volume first, which is the same hierarchy a real exchange uses. The
    /// higher price is worse for the buyer and better for the auction, and the
    /// auction is what the rule serves.
    function test_aChallengeThatTradesMoreVolumeReplacesTheCross() public {
        uint64 id = _twoTieredBook();
        _thinCross(id);

        address challenger = address(0xC4A11);
        usdg.mint(challenger, 1000e6);
        vm.prank(challenger);
        usdg.approve(address(house), type(uint256).max);

        vm.expectEmit(true, true, false, true);
        emit IAuctionHouse.CrossChallenged(id, challenger, 200e6, 202e6, true);
        vm.prank(challenger);
        house.challenge(id, 202e6);

        assertEq(usdg.balanceOf(challenger), 1250e6, "bond back plus half the solver bond");
        assertEq(usdg.balanceOf(treasury), 250e6, "the other half is the protocol share");
        assertEq(house.commitment(house.bookAt(id, 0)).filledSell, 0, "the fills were rolled back");

        Execution[] memory e = new Execution[](3);
        e[0] = _exec(0, 808e6, 4e18);
        e[1] = _exec(1, 2e18, 404e6);
        e[2] = _exec(2, 2e18, 404e6);
        vm.prank(solver);
        house.submitCross(id, 202e6, e);

        vm.warp(block.timestamp + 121);
        house.executeCross(id);
        assertEq(nvda.balanceOf(alice), 4e18, "twice the volume of the cross it replaced");
    }

    function test_aChallengeThatIsNotBetterLosesItsBond() public {
        uint64 id = _twoTieredBook();
        _thinCross(id);

        address challenger = address(0xC4A11);
        usdg.mint(challenger, 1000e6);
        vm.prank(challenger);
        usdg.approve(address(house), type(uint256).max);

        vm.prank(challenger);
        house.challenge(id, 198e6);

        assertEq(usdg.balanceOf(challenger), 500e6, "the bond is gone");
        assertEq(usdg.balanceOf(treasury), 250e6, "half of it to the protocol");
        assertEq(usdg.balanceOf(solver), 9750e6, "the solver took the other half and nothing else");
        assertEq(house.commitment(house.bookAt(id, 0)).filledSell, 400e6, "the cross still stands");
    }

    /// The solver bond stays in the contract across a failed challenge, because
    /// executeCross is what hands it back. Paying it at the challenge as well would
    /// have taken the second one out of the escrow, and the escrow is what every
    /// owner in the book is still owed.
    function test_aFailedChallengeDoesNotPayTheSolverBondEarly() public {
        uint64 id = _twoTieredBook();
        _thinCross(id);

        address challenger = address(0xC4A11);
        usdg.mint(challenger, 1000e6);
        vm.prank(challenger);
        usdg.approve(address(house), type(uint256).max);
        vm.prank(challenger);
        house.challenge(id, 198e6);

        uint256 owed = 900e6 - 400e6;
        assertEq(usdg.balanceOf(address(house)), 900e6 + BOND, "the solver bond is still held");

        vm.warp(block.timestamp + 121);
        house.executeCross(id);

        assertEq(usdg.balanceOf(solver), 10_250e6, "bond back once, plus the seized half");
        assertEq(usdg.balanceOf(address(house)), owed, "and the unfilled escrow is untouched");

        house.refundEscrow(house.bookAt(id, 0));
        assertEq(usdg.balanceOf(address(house)), 0, "which the owner can take back in full");
    }

    /// A cross may not leave matchable volume on the table. Without this an intent
    /// priced well through the clearing price could simply be skipped, which is the
    /// one thing a uniform price auction must never do.
    function test_aCrossMustClearEverythingItsOwnBookCanMatch() public {
        uint64 id = _twoTieredBook();

        Execution[] memory e = new Execution[](2);
        e[0] = _exec(0, 404e6, 2e18);
        e[1] = _exec(1, 2e18, 404e6);
        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(AuctionHouse.VolumeBelowMatchable.selector, 2e18, 4e18));
        house.submitCross(id, 202e6, e);
    }

    /// Phase one of the design. Someone signs on Saturday for a cross that has no
    /// contract behind it yet, and the first commit is what creates the auction.
    function test_accumulationReachesAcrossTheWeekend() public {
        vm.warp(1_772_890_200); // Saturday 7 March 2026, 13:30 UTC
        _buyMoo(alice, 400e6, 1);

        uint64 id = house.auctionIdOf(address(nvda), 20_260_309, kindOpen);
        assertGt(id, 0, "the weekend commit created Monday's auction");
        (uint64 freezeAt, uint64 crossAt,) = house.auctionTiming(id);
        assertEq(crossAt, 1_773_063_000, "Monday 9 March, 09:30 New York");
        assertEq(freezeAt, crossAt - 300);
    }

    /// The closing print is the one number this protocol publishes to the outside
    /// world, so it carries the volume and the participant count that produced it.
    function test_closingPrintCarriesTheVolumeAndTheCountThatProducedIt() public {
        address dave = vm.addr(DAVE_KEY);
        address erin = vm.addr(ERIN_KEY);
        _fund(dave, DAVE_KEY);
        _fund(erin, ERIN_KEY);
        _enterClosingAuction();

        _commitClose(alice, true, 400e6, 1);
        _commitClose(carol, true, 400e6, 2);
        _commitClose(dave, true, 400e6, 3);
        _commitClose(bob, false, 3e18, 4);
        _commitClose(erin, false, 3e18, 5);
        uint64 id = _closeAuctionFrozen();

        Execution[] memory e = new Execution[](5);
        e[0] = _exec(0, 400e6, 2e18);
        e[1] = _exec(1, 400e6, 2e18);
        e[2] = _exec(2, 400e6, 2e18);
        e[3] = _exec(3, 3e18, 600e6);
        e[4] = _exec(4, 3e18, 600e6);
        vm.prank(solver);
        house.submitCross(id, 200e6, e);

        vm.warp(block.timestamp + 121);
        vm.expectEmit(true, true, false, true);
        emit IAuctionHouse.ClosingPrintPublished(address(nvda), DAY, 200e18, 1200e6, 5, true);
        house.executeCross(id);

        (uint256 price, uint256 volume, uint32 participants, bool sufficient) =
            house.closingPrice(address(nvda), DAY);
        assertEq(price, 200e18);
        assertEq(volume, 1200e6);
        assertEq(participants, 5);
        assertTrue(sufficient);

        (, uint64 ts,) = house.lastClose(address(nvda));
        assertEq(ts, CLOSE_BELL, "the print is stamped with the cross, not with now");
        assertEq(house.latestPrintDay(address(nvda)), DAY);

        // The point of the second surface. A consumer already written against
        // Chainlink changes one address and reads this without touching its code.
        ClosingPrintFeed feed =
            new ClosingPrintFeed(IAuctionHouse(address(house)), address(nvda), "Nokturn NVDA / USD");
        (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt,) = feed.latestRoundData();
        assertEq(roundId, DAY);
        assertEq(answer, 200e8, "eight decimals, the same as the feeds on this chain");
        assertEq(startedAt, CLOSE_BELL - 300);
        assertEq(updatedAt, CLOSE_BELL);
    }

    /// Refusing to publish is the feature. A thin auction produces no round at all,
    /// so a consumer staleness check rejects the day on its own terms.
    function test_aThinAuctionPublishesNothingAtAll() public {
        _enterClosingAuction();
        _commitClose(alice, true, 1200e6, 1);
        _commitClose(bob, false, 6e18, 2);
        uint64 id = _closeAuctionFrozen();

        Execution[] memory e = new Execution[](2);
        e[0] = _exec(0, 1200e6, 6e18);
        e[1] = _exec(1, 6e18, 1200e6);
        vm.prank(solver);
        house.submitCross(id, 200e6, e);

        vm.warp(block.timestamp + 121);
        vm.expectEmit(true, true, false, true);
        emit IAuctionHouse.ClosingPrintWithheld(address(nvda), DAY, "too few participants", 1200e6, 2);
        house.executeCross(id);

        assertEq(house.latestPrintDay(address(nvda)), 0, "no round was created");
        (,,, bool sufficient) = house.closingPrice(address(nvda), DAY);
        assertFalse(sufficient);
    }

    function test_aQuietAuctionIsWithheldOnVolumeBeforeAnythingElse() public {
        _enterClosingAuction();
        _commitClose(alice, true, 900e6, 1);
        _commitClose(bob, false, 4.5e18, 2);
        uint64 id = _closeAuctionFrozen();

        Execution[] memory e = new Execution[](2);
        e[0] = _exec(0, 900e6, 4.5e18);
        e[1] = _exec(1, 4.5e18, 900e6);
        vm.prank(solver);
        house.submitCross(id, 200e6, e);

        vm.warp(block.timestamp + 121);
        vm.expectEmit(true, true, false, true);
        emit IAuctionHouse.ClosingPrintWithheld(address(nvda), DAY, "volume below minimum", 900e6, 2);
        house.executeCross(id);
    }

    /// A corporate action between the freeze and the cross changes what every
    /// intent in the book meant, so the auction is abandoned rather than crossed
    /// on terms nobody agreed to.
    function test_aMultiplierThatMovesBeforeTheCrossAbortsTheAuction() public {
        bytes32 hash = _buyMoo(alice, 400e6, 1);
        _sellMoo(bob, 2e18, 2);
        uint64 id = _openAndFreeze();

        nvda.setUiMultiplier(1.000775e18);
        vm.expectEmit(true, false, false, true);
        emit IAuctionHouse.AuctionAborted(id, "multiplier moved");
        house.abortAuction(id);

        house.refundEscrow(hash);
        assertEq(usdg.balanceOf(alice), 100_000e6, "escrow is never trapped by an abort");
    }

    function test_aMultiplierThatMovesAfterTheCrossStopsExecution() public {
        _buyMoo(alice, 400e6, 1);
        _sellMoo(bob, 2e18, 2);
        uint64 id = _openAndFreeze();
        _passOpeningReference(200e8);

        Execution[] memory e = new Execution[](2);
        e[0] = _exec(0, 400e6, 2e18);
        e[1] = _exec(1, 2e18, 400e6);
        vm.prank(solver);
        house.submitCross(id, 200e6, e);

        nvda.setUiMultiplier(1.000775e18);
        vm.warp(block.timestamp + 121);
        vm.expectRevert(abi.encodeWithSelector(AuctionHouse.MultiplierChanged.selector, address(nvda)));
        house.executeCross(id);
    }

    function test_anAuctionNobodyCrossesIsRetiredAndTheEscrowComesBack() public {
        bytes32 hash = _buyMoo(alice, 400e6, 1);
        _sellMoo(bob, 2e18, 2);
        uint64 id = _openAndFreeze();
        _passOpeningReference(200e8);

        vm.expectRevert(abi.encodeWithSelector(AuctionHouse.EscrowNotRefundable.selector, hash));
        house.refundEscrow(hash);

        vm.expectRevert(abi.encodeWithSelector(AuctionHouse.AuctionStillLive.selector, id));
        house.abortAuction(id);

        vm.warp(REFERENCE_AT + 4 * 300 + 1);
        vm.expectEmit(true, false, false, true);
        emit IAuctionHouse.AuctionAborted(id, "no cross in time");
        house.abortAuction(id);

        house.refundEscrow(hash);
        assertEq(usdg.balanceOf(alice), 100_000e6);
        vm.expectRevert(abi.encodeWithSelector(AuctionHouse.EscrowNotRefundable.selector, hash));
        house.refundEscrow(hash);
    }

    function test_unfilledEscrowComesBackAfterAPartialCross() public {
        bytes32 hash = _buyMoo(alice, 600e6, 1);
        _sellMoo(bob, 2e18, 2);
        uint64 id = _openAndFreeze();
        _passOpeningReference(200e8);

        Execution[] memory e = new Execution[](2);
        e[0] = _exec(0, 400e6, 2e18);
        e[1] = _exec(1, 2e18, 400e6);
        vm.prank(solver);
        house.submitCross(id, 200e6, e);

        vm.warp(block.timestamp + 121);
        house.executeCross(id);

        house.refundEscrow(hash);
        assertEq(usdg.balanceOf(alice), 100_000e6 - 400e6, "only the filled part was spent");
        assertEq(nvda.balanceOf(alice), 2e18);
    }

    function test_theOnlyPairAnAuctionQuotesIsAgainstTheQuoteToken() public {
        MockERC20 tsla = new MockERC20("Tesla", "TSLA", 18);
        Intent memory i = _intent(bob, false, 1e18, 0, IntentKind.MOO, 0, SessionMask.AUCTION_OPEN, 1);
        i.buyToken = address(tsla);

        vm.expectRevert(
            abi.encodeWithSelector(
                AuctionHouse.PairMustQuoteAgainstQuoteToken.selector, address(nvda), address(tsla)
            )
        );
        house.commitAuctionIntent(i, hex"00");
    }

    function test_anIntentMustNameExactlyOneOfTheTwoCrosses() public {
        Intent memory both = _intent(
            alice, true, 400e6, 0, IntentKind.MOO, 0, SessionMask.AUCTION_OPEN | SessionMask.AUCTION_CLOSE, 1
        );
        vm.expectRevert(
            abi.encodeWithSelector(AuctionHouse.AmbiguousAuctionSession.selector, both.allowedSessions)
        );
        house.commitAuctionIntent(both, hex"00");

        Intent memory neither = _intent(alice, true, 400e6, 0, IntentKind.MOO, 0, SessionMask.OPEN, 2);
        vm.expectRevert(
            abi.encodeWithSelector(AuctionHouse.AmbiguousAuctionSession.selector, neither.allowedSessions)
        );
        house.commitAuctionIntent(neither, hex"00");
    }

    function test_anOrdinaryIntentIsNotAnAuctionIntent() public {
        Intent memory i = _intent(alice, true, 400e6, 0, IntentKind.MOO, 0, SessionMask.AUCTION_OPEN, 1);
        i.flags = 0;
        bytes32 hash = hasher.hashOf(i);
        vm.expectRevert(abi.encodeWithSelector(AuctionHouse.NotAnAuctionIntent.selector, hash));
        house.commitAuctionIntent(i, hex"00");

        Intent memory spot = _intent(alice, true, 400e6, 0, IntentKind.SPOT, 0, SessionMask.AUCTION_OPEN, 2);
        vm.expectRevert(abi.encodeWithSelector(AuctionHouse.NotAnAuctionIntent.selector, hasher.hashOf(spot)));
        house.commitAuctionIntent(spot, hex"00");
    }

    function test_theSameIntentCannotBeCommittedTwice() public {
        Intent memory i = _intent(alice, true, 400e6, 0, IntentKind.MOO, 0, SessionMask.AUCTION_OPEN, 1);
        bytes memory sig = _commitSignature(i);
        house.commitAuctionIntent(i, sig);
        vm.expectRevert(abi.encodeWithSelector(AuctionHouse.AlreadyCommitted.selector, hasher.hashOf(i)));
        house.commitAuctionIntent(i, sig);
    }

    function test_aPermitThatExpiresBeforeTheCrossIsRefused() public {
        Intent memory i = _intent(alice, true, 400e6, 0, IntentKind.MOO, 0, SessionMask.AUCTION_OPEN, 1);
        // forge-lint: disable-next-line(unsafe-typecast)
        i.validUntil = uint32(BELL - 1);
        vm.expectRevert(
            abi.encodeWithSelector(AuctionHouse.IntentExpiresBeforeCross.selector, i.validUntil, BELL)
        );
        house.commitAuctionIntent(i, hex"00");
    }

    function test_aTokenOutsideTheAllowlistHasNoAuction() public {
        MockERC20 tsla = new MockERC20("Tesla", "TSLA", 18);
        Intent memory i = _intent(alice, true, 400e6, 0, IntentKind.MOO, 0, SessionMask.AUCTION_OPEN, 1);
        i.buyToken = address(tsla);
        vm.expectRevert(abi.encodeWithSelector(AuctionHouse.TokenNotAllowed.selector, address(tsla)));
        house.commitAuctionIntent(i, hex"00");

        vm.expectRevert(AuctionHouse.NotGovernor.selector);
        house.setAuctionTokenAllowed(address(tsla), true);
    }

    function test_theBookIsClosedOnceItIsFrozen() public {
        _buyMoo(alice, 400e6, 1);
        uint64 id = _openAndFreeze();

        Intent memory late = _intent(carol, true, 400e6, 0, IntentKind.MOO, 0, SessionMask.AUCTION_OPEN, 2);
        vm.expectRevert(abi.encodeWithSelector(AuctionHouse.WrongPhase.selector, id, uint8(2)));
        house.commitAuctionIntent(late, hex"00");

        vm.expectRevert(abi.encodeWithSelector(AuctionHouse.WrongPhase.selector, id, uint8(2)));
        house.freeze(id);
    }

    function test_theFreezeHasAWindowOfItsOwn() public {
        _buyMoo(alice, 400e6, 1);
        uint64 id = house.auctionIdOf(address(nvda), DAY, kindOpen);
        house.openAuction(address(nvda), kindOpen);

        vm.expectRevert(abi.encodeWithSelector(AuctionHouse.TooEarly.selector, FREEZE_AT));
        house.freeze(id);

        vm.warp(BELL);
        _pushFeeds(200e8, uint64(block.timestamp));
        vm.expectRevert(abi.encodeWithSelector(AuctionHouse.TooLate.selector, BELL));
        house.freeze(id);
    }

    function test_openingAnAuctionNeedsTheSessionItBelongsTo() public {
        vm.warp(BELL + 60);
        vm.expectRevert(abi.encodeWithSelector(AuctionHouse.NotInAuctionSession.selector, kindOpen, uint8(3)));
        house.openAuction(address(nvda), kindOpen);

        vm.warp(AUCTION_OPEN_AT + 60);
        uint64 id = house.openAuction(address(nvda), kindOpen);
        vm.expectRevert(abi.encodeWithSelector(AuctionHouse.WrongPhase.selector, id, uint8(1)));
        house.openAuction(address(nvda), kindOpen);
    }

    function test_indicativeIsOnlyPublishedWhileThereIsAnAuctionToPublishFor() public {
        vm.expectRevert(abi.encodeWithSelector(AuctionHouse.WrongPhase.selector, uint64(1), uint8(0)));
        house.publishIndicative(1);
    }

    /// An oracle that is not healthy produces no indicative price. Publishing one
    /// anyway would be inventing the number the whole phase exists to make real.
    function test_noIndicativePriceWithoutAHealthyOracle() public {
        _buyMoo(alice, 400e6, 1);
        uint64 id = _openAndFreeze();

        vm.warp(BELL + 7000);
        vm.expectRevert(abi.encodeWithSelector(AuctionHouse.OracleUnhealthy.selector, address(nvda)));
        house.publishIndicative(id);
    }

    function test_extensionsRunOut() public {
        _buyMoo(alice, 410e6, 1);
        _sellMoo(bob, 2e18, 2);
        uint64 id = _openAndFreeze();
        _passOpeningReference(200e8);

        for (uint256 n = 1; n <= 3; ++n) {
            vm.warp(REFERENCE_AT + 300 * n);
            house.extend(id);
        }
        vm.warp(REFERENCE_AT + 1500);
        vm.expectRevert(abi.encodeWithSelector(AuctionHouse.ExtensionsExhausted.selector, id));
        house.extend(id);
    }

    function test_aCrossNeedsTwoSides() public {
        _buyMoo(alice, 400e6, 1);
        _buyMoo(carol, 400e6, 2);
        uint64 id = _openAndFreeze();
        _passOpeningReference(200e8);

        Execution[] memory e = new Execution[](0);
        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(AuctionHouse.NothingMatched.selector, id));
        house.submitCross(id, 200e6, e);
    }

    function test_aCrossCannotHandOutMoreThanItCollected() public {
        _buyMoo(alice, 400e6, 1);
        _sellMoo(bob, 2e18, 2);
        uint64 id = _openAndFreeze();
        _passOpeningReference(200e8);

        Execution[] memory e = new Execution[](2);
        e[0] = _exec(0, 400e6, 2e18);
        e[1] = _exec(1, 1e18, 200e6);
        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(AuctionHouse.ValueNotConserved.selector, 1e18, 2e18));
        house.submitCross(id, 200e6, e);
    }

    function test_aFillCannotExceedTheEscrowBehindIt() public {
        _buyMoo(alice, 400e6, 1);
        _sellMoo(bob, 2e18, 2);
        uint64 id = _openAndFreeze();
        _passOpeningReference(200e8);

        Execution[] memory e = new Execution[](1);
        e[0] = _exec(0, 500e6, 2.5e18);
        vm.prank(solver);
        vm.expectRevert(
            abi.encodeWithSelector(AuctionHouse.FillExceedsEscrow.selector, uint256(0), 500e6, 400e6)
        );
        house.submitCross(id, 200e6, e);
    }

    function test_everyFillIsPricedAtTheOnePrice() public {
        _buyMoo(alice, 400e6, 1);
        _sellMoo(bob, 2e18, 2);
        uint64 id = _openAndFreeze();
        _passOpeningReference(200e8);

        Execution[] memory e = new Execution[](2);
        e[0] = _exec(0, 400e6, 2e18 + 1);
        e[1] = _exec(1, 2e18, 400e6);
        vm.prank(solver);
        vm.expectRevert(
            abi.encodeWithSelector(AuctionHouse.UniformPriceViolated.selector, uint256(0), 2e18, 2e18 + 1)
        );
        house.submitCross(id, 200e6, e);
    }

    function test_executionsAreOrderedAndEachIntentAppearsOnce() public {
        _buyMoo(alice, 400e6, 1);
        _sellMoo(bob, 2e18, 2);
        uint64 id = _openAndFreeze();
        _passOpeningReference(200e8);

        Execution[] memory e = new Execution[](2);
        e[0] = _exec(1, 2e18, 400e6);
        e[1] = _exec(0, 400e6, 2e18);
        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(AuctionHouse.ExecutionsNotAscending.selector, uint256(1)));
        house.submitCross(id, 200e6, e);

        Execution[] memory tooMany = new Execution[](129);
        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(AuctionHouse.TooManyExecutions.selector, uint256(129)));
        house.submitCross(id, 200e6, tooMany);
    }

    /// Five intents from two people is not five participants. The print gate would
    /// be trivial to walk around otherwise.
    function test_onePersonWithTwoIntentsIsStillOneParticipant() public {
        _buyMoo(alice, 200e6, 1);
        _buyMoo(alice, 200e6, 2);
        _sellMoo(bob, 2e18, 3);
        uint64 id = _openAndFreeze();
        _passOpeningReference(200e8);

        Execution[] memory e = new Execution[](3);
        e[0] = _exec(0, 200e6, 1e18);
        e[1] = _exec(1, 200e6, 1e18);
        e[2] = _exec(2, 2e18, 400e6);
        vm.prank(solver);
        house.submitCross(id, 200e6, e);

        (,,,, uint32 participants,) = house.auctionResult(id);
        assertEq(participants, 2, "two people, three intents");
    }

    /// The indicative price is not the oracle price. It is the price that trades
    /// the most, and here that is above the reference because the higher price is
    /// what brings the second seller out.
    function test_theIndicativePriceIsTheOneThatTradesTheMost() public {
        _buyMoo(alice, 900e6, 1);
        _sellLoo(bob, 2e18, 400e6, 2);
        _sellLoo(carol, 2e18, 404e6, 3);
        uint64 id = house.auctionIdOf(address(nvda), DAY, kindOpen);
        house.openAuction(address(nvda), kindOpen);

        (uint256 price, uint256 matched,) = house.indicative(id);
        assertEq(price, 202e6, "not the reference, the volume");
        assertEq(matched, 4e18);

        assertEq(house.bookLength(id), 3);
        (address token,, uint8 phase, uint32 day, uint16 collar,) = house.auctionState(id);
        assertEq(token, address(nvda));
        assertEq(phase, 1);
        assertEq(day, DAY);
        assertEq(collar, 200);
    }

    /// A relative limit means what the reference says it means, and the reference
    /// is the opening one, not the last feed price before the bell.
    function test_aRelativeLimitIsMeasuredAgainstTheOpeningReference() public {
        _commit(_intent(alice, true, 402e6, 0, IntentKind.ROO, 50, SessionMask.AUCTION_OPEN, 1));
        _sellMoo(bob, 2e18, 2);
        uint64 id = _openAndFreeze();
        _passOpeningReference(200e8);

        Execution[] memory e = new Execution[](2);
        e[0] = _exec(0, 402e6, 2e18);
        e[1] = _exec(1, 2e18, 402e6);
        vm.prank(solver);
        vm.expectRevert(
            abi.encodeWithSelector(AuctionHouse.LimitNotRespected.selector, uint256(0), 201e6, 202e6)
        );
        house.submitCross(id, 202e6, e);

        Execution[] memory ok = new Execution[](2);
        ok[0] = _exec(0, 402e6, 2e18);
        ok[1] = _exec(1, 2e18, 402e6);
        vm.prank(solver);
        house.submitCross(id, 201e6, ok);
        (, uint256 clearing,,,,) = house.auctionResult(id);
        assertEq(clearing, 201e6, "fifty basis points above the opening reference");
    }

    /// USDG has no uiMultiplier and neither will every token added later, so the
    /// read has to survive a token that simply does not implement it.
    function test_aTokenWithoutAMultiplierStillCrosses() public {
        vm.mockCallRevert(address(nvda), abi.encodeWithSignature("uiMultiplier()"), "");
        _buyMoo(alice, 400e6, 1);
        _sellMoo(bob, 2e18, 2);
        uint64 id = _openAndFreeze();
        _passOpeningReference(200e8);

        Execution[] memory e = new Execution[](2);
        e[0] = _exec(0, 400e6, 2e18);
        e[1] = _exec(1, 2e18, 400e6);
        vm.prank(solver);
        house.submitCross(id, 200e6, e);
        vm.warp(block.timestamp + 121);
        house.executeCross(id);
        assertEq(nvda.balanceOf(alice), 2e18);
    }

    /// An unscheduled closure is the case the calendar cannot predict. The auction
    /// was already frozen when the day turned into a holiday, and the escrow still
    /// has to come back.
    function test_anAuctionForADayTheMarketNeverOpenedIsAborted() public {
        bytes32 hash = _buyMoo(alice, 400e6, 1);
        _sellMoo(bob, 2e18, 2);
        uint64 id = _openAndFreeze();

        _declareHoliday();
        vm.expectEmit(true, false, false, true);
        emit IAuctionHouse.AuctionAborted(id, "market did not open");
        house.abortAuction(id);

        house.refundEscrow(hash);
        assertEq(usdg.balanceOf(alice), 100_000e6);
    }

    function test_abortingAfterACrossReturnsTheSolverBond() public {
        _buyMoo(alice, 400e6, 1);
        _sellMoo(bob, 2e18, 2);
        uint64 id = _openAndFreeze();
        _passOpeningReference(200e8);

        Execution[] memory e = new Execution[](2);
        e[0] = _exec(0, 400e6, 2e18);
        e[1] = _exec(1, 2e18, 400e6);
        vm.prank(solver);
        house.submitCross(id, 200e6, e);

        _declareHoliday();
        house.abortAuction(id);

        assertEq(usdg.balanceOf(solver), 10_000e6, "the bond is not forfeit for a market closure");
        assertEq(house.commitment(house.bookAt(id, 0)).filledSell, 0);

        vm.expectRevert(abi.encodeWithSelector(AuctionHouse.WrongPhase.selector, id, uint8(5)));
        house.abortAuction(id);
    }

    function test_aChallengeLivesInsideItsWindowOnly() public {
        uint64 id = _twoTieredBook();

        address challenger = address(0xC4A11);
        usdg.mint(challenger, 1000e6);
        vm.prank(challenger);
        usdg.approve(address(house), type(uint256).max);

        vm.prank(challenger);
        vm.expectRevert(abi.encodeWithSelector(AuctionHouse.WrongPhase.selector, id, uint8(2)));
        house.challenge(id, 202e6);

        _thinCross(id);
        uint64 closesAt = uint64(block.timestamp) + 120;
        vm.warp(closesAt + 1);
        vm.prank(challenger);
        vm.expectRevert(abi.encodeWithSelector(AuctionHouse.TooLate.selector, closesAt));
        house.challenge(id, 202e6);
    }

    /// Past the last DST boundary the session engine answers PROTECTIVE rather than
    /// guessing an offset, so there is no next cross to commit to either.
    function test_thereIsNoCrossBeyondTheCalendar() public {
        vm.warp(sessions.coveredUntil() + 1);
        Intent memory i = _intent(alice, true, 400e6, 0, IntentKind.MOO, 0, SessionMask.AUCTION_OPEN, 1);
        vm.expectRevert(abi.encodeWithSelector(AuctionHouse.NoAuctionSessionAhead.selector, kindOpen));
        house.commitAuctionIntent(i, hex"00");
    }

    function test_refundingSomethingNobodyCommittedIsRefused() public {
        vm.expectRevert(abi.encodeWithSelector(AuctionHouse.CommitmentUnknown.selector, bytes32(0)));
        house.refundEscrow(bytes32(0));

        vm.expectRevert(abi.encodeWithSelector(AuctionHouse.CommitmentUnknown.selector, bytes32(0)));
        house.cancelBeforeFreeze(bytes32(0));
    }

    function _declareHoliday() internal {
        uint32[] memory dates = new uint32[](1);
        uint8[] memory kinds = new uint8[](1);
        uint32[] memory closeTimes = new uint32[](1);
        // forge-lint: disable-next-line(unsafe-typecast)
        dates[0] = uint32(BELL / 1 days);
        kinds[0] = 1;
        vm.prank(governor);
        sessions.setCalendarEntries(dates, kinds, closeTimes);
    }

    /// Anyone may relay a commitment, which is what makes signing on Saturday
    /// worth anything. The signature is what stops that from meaning anyone can
    /// fill the book with entries nobody agreed to.
    function test_aCommitmentTheOwnerNeverSignedIsRefused() public {
        Intent memory i = _intent(alice, true, 400e6, 0, IntentKind.MOO, 0, SessionMask.AUCTION_OPEN, 1);
        bytes32 hash = hasher.hashOf(i);
        bytes memory wrongSigner = _sign(CAROL_KEY, i, hash);

        vm.expectRevert(abi.encodeWithSelector(AuctionHouse.BadSignature.selector, hash));
        house.commitAuctionIntent(i, wrongSigner);

        vm.expectRevert(abi.encodeWithSelector(AuctionHouse.BadSignature.selector, hash));
        house.commitAuctionIntent(i, hex"00");
    }

    /// The digest covers the amount and the terms, so a signature cannot be lifted
    /// from one commitment onto a larger one.
    function test_aSignatureDoesNotCarryOverToADifferentAmount() public {
        Intent memory small = _intent(alice, true, 400e6, 0, IntentKind.MOO, 0, SessionMask.AUCTION_OPEN, 1);
        bytes memory sig = _commitSignature(small);

        Intent memory large = _intent(alice, true, 800e6, 0, IntentKind.MOO, 0, SessionMask.AUCTION_OPEN, 1);
        vm.expectRevert(abi.encodeWithSelector(AuctionHouse.BadSignature.selector, hasher.hashOf(large)));
        house.commitAuctionIntent(large, sig);
    }

    /// A relayed commitment is the normal case, not the exception.
    function test_aRelayerCanCommitOnSomebodyElsesBehalf() public {
        Intent memory i = _intent(alice, true, 400e6, 0, IntentKind.MOO, 0, SessionMask.AUCTION_OPEN, 1);
        bytes memory sig = _commitSignature(i);

        vm.prank(address(0xBE1A4));
        house.commitAuctionIntent(i, sig);
        assertEq(house.commitment(hasher.hashOf(i)).owner, alice);
    }
}
