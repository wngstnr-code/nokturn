// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {AuctionHouse} from "../src/AuctionHouse.sol";
import {IAuctionHouse} from "../src/interfaces/IAuctionHouse.sol";
import {Execution, Intent, IntentKind, SessionMask} from "../src/types/Types.sol";
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
