// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {AuctionHouse} from "../src/AuctionHouse.sol";
import {IAuctionHouse} from "../src/interfaces/IAuctionHouse.sol";
import {Execution, Intent, IntentKind, SessionMask} from "../src/types/Types.sol";
import {stdError} from "forge-std/StdError.sol";
import {Vm} from "forge-std/Vm.sol";
import {AuctionFixture} from "./fixtures/AuctionFixture.sol";

/// @notice One test per operator the auction suite could flip without noticing.
/// The cases here are the inclusive bounds and the arithmetic the happy paths walk
/// straight past, so each one names the single character it is holding in place.
contract AuctionHouseEdgesTest is AuctionFixture {
    uint256 internal constant DAVE_KEY_LOCAL = 0xDA3E;

    address internal dave = vm.addr(DAVE_KEY_LOCAL);
    address internal challenger = address(0xC0FFEE);

    function _fundChallenger() internal {
        usdg.mint(challenger, 10_000e6);
        vm.prank(challenger);
        usdg.approve(address(house), type(uint256).max);
    }

    /// The cross is the last moment an intent can still be worth something, so an
    /// intent that expires on it is in time rather than late.
    function test_anIntentExpiringExactlyOnTheCrossIsStillInTime() public {
        Intent memory i = _intent(alice, true, 400e6, 0, IntentKind.MOO, 0, SessionMask.AUCTION_OPEN, 1);
        // forge-lint: disable-next-line(unsafe-typecast)
        i.validUntil = uint32(BELL);

        bytes32 hash = _commit(i);
        assertEq(house.commitment(hash).owner, alice, "it joined the book");
    }

    /// The commit refuses an intent the escrow could not cover, and an allowance
    /// equal to the amount covers it exactly.
    function test_anAllowanceEqualToTheAmountCoversTheCommitment() public {
        keyOf[dave] = DAVE_KEY_LOCAL;
        usdg.mint(dave, 400e6);
        vm.prank(dave);
        usdg.approve(address(permit2), 400e6);

        bytes32 hash = _buyMoo(dave, 400e6, 1);
        assertEq(house.commitment(hash).owner, dave, "exactly enough is enough");
    }

    /// Extending stretches the wait by one whole period each time. The first
    /// extension cannot tell a product from a quotient, because both leave one
    /// period, so this asks for the second one.
    function test_theSecondExtensionWaitsTwoWholePeriods() public {
        _buyMoo(alice, 400e6, 1);
        _sellMoo(bob, 2e18, 2);
        uint64 id = _openAndFreeze();
        _passOpeningReference(200e8);

        vm.warp(REFERENCE_AT + 300);
        house.extend(id);

        vm.warp(REFERENCE_AT + 599);
        vm.expectRevert(abi.encodeWithSelector(AuctionHouse.TooEarly.selector, REFERENCE_AT + 600));
        house.extend(id);

        vm.warp(REFERENCE_AT + 600);
        house.extend(id);
        (,,,,, uint8 extensions) = house.auctionState(id);
        assertEq(extensions, 2, "two periods bought two extensions");
    }

    /// The challenge window closes on its last second rather than before it.
    function test_aChallengeOnTheClosingSecondIsStillHeard() public {
        _fundChallenger();
        uint64 id = _crossedAuction();
        uint64 closesAt = uint64(block.timestamp) + house.CHALLENGE_WINDOW();

        vm.warp(closesAt);
        vm.expectEmit(true, true, false, true);
        emit IAuctionHouse.CrossChallenged(id, challenger, 200e6, 200e6, false);
        vm.prank(challenger);
        house.challenge(id, 200e6);
    }

    /// And the execution opens on the second after it, not on the second itself.
    /// A cross that could be executed in the same second a challenge is still
    /// allowed would make the window a race rather than a window.
    function test_executionWaitsForTheSecondAfterTheWindowCloses() public {
        uint64 id = _crossedAuction();
        uint64 opensAt = uint64(block.timestamp) + house.CHALLENGE_WINDOW();

        vm.warp(opensAt);
        vm.expectRevert(abi.encodeWithSelector(AuctionHouse.TooEarly.selector, opensAt + 1));
        house.executeCross(id);

        vm.warp(opensAt + 1);
        house.executeCross(id);
    }

    /// The abort deadline is every extension the auction could ever have taken,
    /// which is four whole periods, and it has not passed while the clock is still
    /// standing on it.
    function test_theAbortDeadlineIsFourWholePeriodsAndIsNotPastOnIt() public {
        _buyMoo(alice, 400e6, 1);
        _sellMoo(bob, 2e18, 2);
        uint64 id = _openAndFreeze();
        _passOpeningReference(200e8);

        vm.warp(REFERENCE_AT + 1200);
        vm.expectRevert(abi.encodeWithSelector(AuctionHouse.AuctionStillLive.selector, id));
        house.abortAuction(id);

        vm.warp(REFERENCE_AT + 1201);
        house.abortAuction(id);
    }

    /// Dust only exists when the two sides did not divide evenly, and a cross that
    /// divided evenly must not hand the treasury a transfer of nothing. A zero
    /// value transfer is a real call on a real token, and some tokens revert on it.
    function test_anEvenCrossSendsTheTreasuryNoDustTransfer() public {
        uint64 id = _crossedAuction();
        vm.warp(block.timestamp + 121);

        vm.recordLogs();
        house.executeCross(id);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(_transfersTo(logs, address(nvda), treasury), 0, "no token dust, no token transfer");
        assertEq(_transfersTo(logs, address(usdg), treasury), 0, "no quote dust, no quote transfer");
    }

    /// The same on the refund path. A commitment the cross filled entirely has
    /// nothing left to send back, and sending zero anyway would say it did.
    function test_aFullyFilledCommitmentRefundsWithoutATransfer() public {
        bytes32 hash = _buyMoo(alice, 400e6, 1);
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

        vm.recordLogs();
        house.refundEscrow(hash);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(_transfersTo(logs, address(usdg), alice), 0, "nothing was left to refund");
    }

    /// A token nobody has crossed at the close has no print, and the surface has to
    /// say so rather than hand out a zero that reads like a price.
    function test_aTokenWithNoClosingPrintSaysSo() public view {
        (uint256 price, uint64 ts, bool sufficient) = house.lastClose(address(nvda));
        assertEq(price, 0);
        assertEq(ts, 0);
        assertFalse(sufficient, "nothing has printed here yet");
    }

    /// The volume floor is a floor. An auction that traded exactly a thousand
    /// dollars is at the minimum rather than under it, so it prints.
    function test_anAuctionExactlyOnTheVolumeFloorStillPrints() public {
        address dave2 = vm.addr(DAVE_KEY);
        address erin = vm.addr(ERIN_KEY);
        _fund(dave2, DAVE_KEY);
        _fund(erin, ERIN_KEY);
        _enterClosingAuction();

        _commitClose(alice, true, 400e6, 1);
        _commitClose(carol, true, 300e6, 2);
        _commitClose(dave2, true, 300e6, 3);
        _commitClose(bob, false, 2.5e18, 4);
        _commitClose(erin, false, 2.5e18, 5);
        uint64 id = _closeAuctionFrozen();

        Execution[] memory e = new Execution[](5);
        e[0] = _exec(0, 400e6, 2e18);
        e[1] = _exec(1, 300e6, 1.5e18);
        e[2] = _exec(2, 300e6, 1.5e18);
        e[3] = _exec(3, 2.5e18, 500e6);
        e[4] = _exec(4, 2.5e18, 500e6);
        vm.prank(solver);
        house.submitCross(id, 200e6, e);

        vm.warp(block.timestamp + 121);
        vm.expectEmit(true, true, false, true);
        emit IAuctionHouse.ClosingPrintPublished(address(nvda), DAY, 200e18, 1000e6, 5, true);
        house.executeCross(id);

        assertEq(house.printMinVolume(), 1000e6, "the floor is a thousand dollars in quote units");
    }

    /// The collar is inclusive on both edges. A price sitting exactly on the bound
    /// is inside it, and refusing it would narrow every collar in the protocol by
    /// one unit without anything saying so.
    function test_aCrossOnEitherCollarEdgeIsInsideIt() public {
        _buyMoo(alice, 500e6, 1);
        _sellMoo(bob, 2e18, 2);
        uint64 id = _openAndFreeze();
        _passOpeningReference(200e8);

        uint256 low = (200e6 * (10_000 - 200)) / 10_000;
        uint256 high = (200e6 * (10_000 + 200)) / 10_000;

        uint256 snapshot = vm.snapshotState();
        _crossAt(id, low);
        vm.revertToState(snapshot);
        _crossAt(id, high);
    }

    /// The length guard names a maximum, and a cross of exactly that length is at
    /// it rather than over it. The second submission fails on the book instead,
    /// which is the whole point. It got past the length check to fail there.
    function test_aCrossOfExactlyTheMaximumLengthIsNotTooLong() public {
        _buyMoo(alice, 400e6, 1);
        _sellMoo(bob, 2e18, 2);
        uint64 id = _openAndFreeze();
        _passOpeningReference(200e8);

        uint256 max = house.MAX_CROSS_EXECUTIONS();

        Execution[] memory tooMany = new Execution[](max + 1);
        for (uint256 k = 0; k < tooMany.length; ++k) {
            tooMany[k] = _exec(k, 0, 0);
        }
        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(AuctionHouse.TooManyExecutions.selector, max + 1));
        house.submitCross(id, 200e6, tooMany);

        Execution[] memory exactly = new Execution[](max);
        for (uint256 k = 0; k < exactly.length; ++k) {
            exactly[k] = _exec(k, 0, 0);
        }
        vm.prank(solver);
        vm.expectRevert(stdError.indexOOBError);
        house.submitCross(id, 200e6, exactly);
    }

    /// A seller who named a limit is not filled under it. The buy side has its own
    /// clause, and the two can be broken one at a time.
    function test_aCrossUnderASellLimitIsRefused() public {
        _buyMoo(alice, 800e6, 1);
        _commit(_intent(bob, false, 2e18, 420e6, IntentKind.LOO, 0, SessionMask.AUCTION_OPEN, 2));
        uint64 id = _openAndFreeze();
        _passOpeningReference(200e8);

        Execution[] memory e = new Execution[](2);
        e[0] = _exec(0, 400e6, 2e18);
        e[1] = _exec(1, 2e18, 400e6);

        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(AuctionHouse.LimitNotRespected.selector, 1, 210e6, 200e6));
        house.submitCross(id, 200e6, e);
    }

    /// Executions are indexed strictly upward, so the same commitment cannot be
    /// filled twice inside one cross.
    function test_theSameCommitmentCannotAppearTwiceInOneCross() public {
        _buyMoo(alice, 400e6, 1);
        _sellMoo(bob, 2e18, 2);
        uint64 id = _openAndFreeze();
        _passOpeningReference(200e8);

        Execution[] memory e = new Execution[](2);
        e[0] = _exec(0, 200e6, 1e18);
        e[1] = _exec(0, 200e6, 1e18);

        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(AuctionHouse.ExecutionsNotAscending.selector, 1));
        house.submitCross(id, 200e6, e);
    }

    /// A limit sitting exactly on the bottom of the collar is a price the auction
    /// is allowed to clear at, so the search has to consider it. Skipping it would
    /// leave two shares untraded that the book says can trade.
    function test_aLimitOnTheBottomOfTheCollarIsStillACandidate() public {
        _commit(_intent(alice, true, 392e6, 2e18, IntentKind.LOO, 0, SessionMask.AUCTION_OPEN, 1));
        _sellMoo(bob, 3e18, 2);

        (uint256 price, uint256 matched,) = house.indicative(_openId());
        assertEq(price, 196e6, "the bottom of the collar clears more than the reference");
        assertEq(matched, 2e18);
    }

    /// And the same on the top.
    function test_aLimitOnTheTopOfTheCollarIsStillACandidate() public {
        _buyMoo(alice, 1000e6, 1);
        _commit(_intent(bob, false, 2e18, 408e6, IntentKind.LOO, 0, SessionMask.AUCTION_OPEN, 2));

        (uint256 price, uint256 matched,) = house.indicative(_openId());
        assertEq(price, 204e6, "the top of the collar clears more than the reference");
        assertEq(matched, 2e18);
    }

    /// A limit outside the collar is not a price this auction may clear at, however
    /// much volume it would trade. The collar is the whole reason the search is
    /// bounded, and a book can always name a better price outside it.
    function test_aLimitOutsideTheCollarIsNotACandidateHoweverGoodItLooks() public {
        _commit(_intent(alice, true, 380e6, 2e18, IntentKind.LOO, 0, SessionMask.AUCTION_OPEN, 1));
        _sellMoo(bob, 3e18, 2);

        (uint256 price, uint256 matched,) = house.indicative(_openId());
        assertEq(price, 200e6, "the reference stands");
        assertEq(matched, 0, "and nothing trades, because the only bid is out of bounds");
    }

    /// First rule of the hierarchy, on a book where it disagrees with the second.
    /// The candidate trades five times the volume and leaves a worse imbalance
    /// behind, and volume is what the exchanges settle it on.
    function test_volumeWinsEvenWhenItLeavesTheWorseImbalance() public {
        _buyMoo(alice, 200e6, 1);
        _commit(_intent(carol, true, 3724e6, 19e18, IntentKind.LOO, 0, SessionMask.AUCTION_OPEN, 2));
        _sellMoo(bob, 5e18, 3);

        (uint256 price, uint256 matched, int256 imbalance) = house.indicative(_openId());
        assertEq(price, 196e6, "five shares beat one");
        assertEq(matched, 5e18);
        assertGt(imbalance, int256(15e18), "and it leaves the larger imbalance behind");
    }

    /// Second rule, on a book where it disagrees with the third. Both prices trade
    /// the same five shares, the candidate leaves less unfilled, and it is the one
    /// further from the reference.
    function test_theSmallerImbalanceWinsEvenFromFurtherAway() public {
        _buyMoo(alice, 980e6, 1);
        _commit(_intent(carol, true, 1020e6, 5e18, IntentKind.LOO, 0, SessionMask.AUCTION_OPEN, 2));
        _sellMoo(bob, 5e18, 3);

        (uint256 price, uint256 matched,) = house.indicative(_openId());
        assertEq(price, 204e6, "four dollars away and still the better price");
        assertEq(matched, 5e18);
    }

    /// The matchable check allows one unit of rounding per fill and not a unit
    /// more. This book is short by exactly that allowance, which is the only place
    /// the tolerance can be told apart from no tolerance at all.
    function test_aCrossShortByExactlyTheRoundingAllowanceIsStillEnough() public {
        _buyMoo(alice, 500e6, 1);
        _sellMoo(bob, 2e18 + 2, 2);
        uint64 id = _openAndFreeze();
        _passOpeningReference(200e8);

        Execution[] memory e = new Execution[](2);
        e[0] = _exec(0, 400e6, 2e18);
        e[1] = _exec(1, 2e18, 400e6);

        vm.prank(solver);
        house.submitCross(id, 200e6, e);
        (,, uint8 phase,,,) = house.auctionState(id);
        assertEq(phase, 3, "two units of rounding over two fills is the allowance");
    }

    /// The reference resolves on the second it is due, not on the one after. An
    /// auction that waited for the opening reference has to be crossing against it
    /// by then, because that is the second the collar moves.
    function test_theReferenceResolvesOnTheSecondItIsDue() public {
        _buyMoo(alice, 500e6, 1);
        _sellMoo(bob, 2e18, 2);
        uint64 id = _openAndFreeze();

        vm.warp(BELL + 1);
        _pushFeeds(220e8, uint64(block.timestamp));
        vm.warp(BELL + 150);
        _pushFeeds(220e8, uint64(block.timestamp));
        vm.warp(REFERENCE_AT);
        // forge-lint: disable-next-line(unsafe-typecast)
        uint32 day = uint32(BELL / 1 days);
        oracle.finalizeOpenReference(address(nvda), day);

        (uint256 openRef,) = oracle.openReference(address(nvda), day);
        uint256 crossPrice = (openRef * 1e6) / 1e18;
        assertGt(crossPrice, 204e6, "the opening reference is outside the collar the freeze drew");

        uint256 quoteLeg = (2e18 * crossPrice) / 1e18;
        Execution[] memory e = new Execution[](2);
        e[0] = _exec(0, quoteLeg, (quoteLeg * 1e18) / crossPrice);
        e[1] = _exec(1, 2e18, quoteLeg);

        vm.prank(solver);
        house.submitCross(id, crossPrice, e);

        (uint256 refPrice,,,,,) = house.auctionResult(id);
        assertEq(refPrice, crossPrice, "the opening reference, not the price at the freeze");
    }

    /// And it resolves once. A reference that moved every time someone touched the
    /// auction would let the collar drift under a book that already committed to it.
    function test_theReferenceIsResolvedOnlyOnce() public {
        _enterClosingAuction();
        _commitClose(alice, true, 400e6, 1);
        _commitClose(bob, false, 2e18, 2);
        uint64 id = _closeAuctionFrozen();

        vm.warp(CLOSE_BELL + 300);
        house.extend(id);

        vm.warp(CLOSE_BELL + 400);
        _pushFeeds(300e8, uint64(block.timestamp));
        vm.warp(CLOSE_BELL + 600);
        house.extend(id);

        (uint256 price,,) = house.indicative(id);
        assertEq(price, 200e6, "the reference the book was frozen against");
    }

    /// A relative order names a band around the reference, and the band opens
    /// downward for a seller. A cross inside it clears.
    function test_aSellerInsideItsRelativeBandIsFilled() public {
        _buyMoo(alice, 500e6, 1);
        _commit(_intent(bob, false, 2e18, 0, IntentKind.ROO, 100, SessionMask.AUCTION_OPEN, 2));
        uint64 id = _openAndFreeze();
        _passOpeningReference(200e8);

        Execution[] memory e = new Execution[](2);
        e[0] = _exec(0, 398e6, 2e18);
        e[1] = _exec(1, 2e18, 398e6);

        vm.prank(solver);
        house.submitCross(id, 199e6, e);
        (,, uint8 phase,,,) = house.auctionState(id);
        assertEq(phase, 3, "one percent below the reference is inside a one percent band");
    }

    /// And a cross below the band does not, at the exact limit the band names.
    function test_aSellerBelowItsRelativeBandIsRefusedAtTheBandItself() public {
        _buyMoo(alice, 500e6, 1);
        _commit(_intent(bob, false, 2e18, 0, IntentKind.ROO, 100, SessionMask.AUCTION_OPEN, 2));
        uint64 id = _openAndFreeze();
        _passOpeningReference(200e8);

        Execution[] memory e = new Execution[](2);
        e[0] = _exec(0, 394e6, 2e18);
        e[1] = _exec(1, 2e18, 394e6);

        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(AuctionHouse.LimitNotRespected.selector, 1, 198e6, 197e6));
        house.submitCross(id, 197e6, e);
    }

    /// The book cap is a cap. An auction holding exactly the maximum is full, and
    /// the entry that would make it one too many is the one refused.
    function test_aBookHoldingExactlyTheMaximumIsFull() public {
        uint256 max = house.MAX_AUCTION_INTENTS();
        for (uint256 k = 0; k < max; ++k) {
            _buyMoo(alice, 1e6, k + 1);
        }

        uint64 id = _openId();
        Intent memory one = _intent(alice, true, 1e6, 0, IntentKind.MOO, 0, SessionMask.AUCTION_OPEN, max + 1);
        bytes memory sig = _commitSignature(one);

        vm.expectRevert(abi.encodeWithSelector(AuctionHouse.BookFull.selector, id));
        house.commitAuctionIntent(one, sig);
    }

    /// Third rule of the hierarchy, reached through a challenge, which is the only
    /// path where the price being compared against is not the reference itself.
    /// Both prices trade the same hundred shares and leave the same share unfilled,
    /// so the nearer one wins.
    function test_theNearerPriceWinsAClearTieFromBelow() public {
        _fundChallenger();
        uint64 id = _tiedBook(199_980_000, 19_998e6);
        _crossFor(id, 198e6, 19_800e6);

        vm.expectEmit(true, true, false, true);
        emit IAuctionHouse.CrossChallenged(id, challenger, 198e6, 199_980_000, true);
        vm.prank(challenger);
        house.challenge(id, 199_980_000);

        (,, uint8 phase,,,) = house.auctionState(id);
        assertEq(phase, 2, "the cross was rolled back");
    }

    /// The same tie from the other side of the reference.
    function test_theNearerPriceWinsAClearTieFromAbove() public {
        _fundChallenger();
        uint64 id = _tiedBook(203_010_000, 20_301e6);
        _crossFor(id, 203_010_000, 20_301e6);

        vm.expectEmit(true, true, false, true);
        emit IAuctionHouse.CrossChallenged(id, challenger, 203_010_000, 201e6, true);
        vm.prank(challenger);
        house.challenge(id, 201e6);

        (,, uint8 phase,,,) = house.auctionState(id);
        assertEq(phase, 2, "the cross was rolled back");
    }

    /// And the further price loses the same tie. A challenge that names a price the
    /// hierarchy does not prefer keeps its bond seized rather than reverting, so
    /// the phase is what says it failed.
    function test_theFurtherPriceLosesTheSameTie() public {
        _fundChallenger();
        uint64 id = _tiedBook(203_010_000, 20_301e6);
        _crossFor(id, 201e6, 20_100e6);

        vm.expectEmit(true, true, false, true);
        emit IAuctionHouse.CrossChallenged(id, challenger, 201e6, 203_010_000, false);
        vm.prank(challenger);
        house.challenge(id, 203_010_000);

        (,, uint8 phase,,,) = house.auctionState(id);
        assertEq(phase, 3, "the cross stands");
    }

    /// A book that ties on volume and on imbalance at two prices at once. The
    /// hundred share offer is the whole supply below the limit price, and the one
    /// share above it is what makes the two imbalances the same size on opposite
    /// sides.
    function _tiedBook(uint256 limitPrice, uint256 buyQuote) internal returns (uint64 id) {
        _buyMoo(alice, buyQuote, 1);
        _sellMoo(bob, 100e18, 2);
        _commit(_intent(carol, false, 1e18, limitPrice, IntentKind.LOO, 0, SessionMask.AUCTION_OPEN, 3));
        id = _openAndFreeze();
        _passOpeningReference(200e8);
    }

    function _crossFor(uint64 id, uint256 price, uint256 quoteLeg) internal {
        Execution[] memory e = new Execution[](2);
        e[0] = _exec(0, quoteLeg, (quoteLeg * 1e18) / price);
        e[1] = _exec(1, 100e18, (100e18 * price) / 1e18);
        vm.prank(solver);
        house.submitCross(id, price, e);
    }

    function _openId() internal view returns (uint64) {
        return house.auctionIdOf(address(nvda), DAY, kindOpen);
    }

    function _crossAt(uint64 id, uint256 price) internal {
        Execution[] memory e = new Execution[](2);
        uint256 quote = (2e18 * price) / 1e18;
        e[0] = _exec(0, quote, (quote * 1e18) / price);
        e[1] = _exec(1, 2e18, quote);
        vm.prank(solver);
        house.submitCross(id, price, e);
        (,, uint8 phase,,,) = house.auctionState(id);
        assertEq(phase, 3, "the collar edge cleared");
    }

    function _transfersTo(Vm.Log[] memory logs, address token, address to) internal pure returns (uint256 n) {
        bytes32 sig = keccak256("Transfer(address,address,uint256)");
        for (uint256 k = 0; k < logs.length; ++k) {
            if (logs[k].emitter != token) continue;
            if (logs[k].topics.length != 3 || logs[k].topics[0] != sig) continue;
            if (address(uint160(uint256(logs[k].topics[2]))) != to) continue;
            n += 1;
        }
    }

    function _crossedAuction() internal returns (uint64 id) {
        _buyMoo(alice, 400e6, 1);
        _sellMoo(bob, 2e18, 2);
        id = _openAndFreeze();
        _passOpeningReference(200e8);

        Execution[] memory e = new Execution[](2);
        e[0] = _exec(0, 400e6, 2e18);
        e[1] = _exec(1, 2e18, 400e6);

        vm.prank(solver);
        house.submitCross(id, 200e6, e);
    }
}
