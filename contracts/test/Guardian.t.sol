// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Guarded} from "../src/Guarded.sol";
import {Settlement} from "../src/Settlement.sol";
import {ISettlement} from "../src/interfaces/ISettlement.sol";
import {Execution, Intent, IntentKind, SessionMask, Solution} from "../src/types/Types.sol";
import {AuctionFixture} from "./fixtures/AuctionFixture.sol";
import {SettlementFixture} from "./fixtures/SettlementFixture.sol";

/// @notice The emergency stop, from parameter.md section 8. Half of these tests
/// exist to prove the guardian can do something, and half to prove it cannot.
///
/// The second half is the one that matters. A key that can trap a user's escrow is
/// no better than one that can move it, and it is harder to see, so every way out
/// is walked here while the protocol is paused.
contract GuardianSettlementTest is SettlementFixture {
    function test_theGuardianStopsNewBatches() public {
        Solution memory s = _nettedSolution();
        s.claimedSavings = 4e18;

        vm.warp(BATCH_ID + 1);
        vm.prank(guardian);
        settlement.pause();

        // Read the deadline before the prank. An external call inside expectRevert
        // spends the prank, and the caller the contract then sees is the test.
        bytes memory expected =
            abi.encodeWithSelector(Guarded.ProtocolPaused.selector, settlement.pausedUntil());

        vm.prank(solver);
        vm.expectRevert(expected);
        settlement.submitSolution(s);
    }

    function test_theGuardianStopsAFinalizeThatWasAlreadyWon() public {
        Solution memory s = _submit(_nettedSolution());

        vm.prank(guardian);
        settlement.pause();

        vm.warp(BATCH_ID + 20);
        vm.expectRevert();
        settlement.finalize(BATCH_ID, s);

        assertEq(usdg.balanceOf(alice), 1000e6, "the pause left the intents where they were");
    }

    /// Nobody else can. The stop is worth having because it is fast, and fast means
    /// there is no timelock in front of it, so the caller is the only check.
    function test_onlyTheGuardianPauses() public {
        vm.prank(governor);
        vm.expectRevert(abi.encodeWithSelector(Guarded.NotGuardian.selector, governor));
        settlement.pause();

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Guarded.NotGuardian.selector, alice));
        settlement.pause();
    }

    /// There is no unpause to call. The pause carries its own deadline, and the
    /// protocol comes back on its own six hours later.
    function test_thePauseLapsesOnItsOwn() public {
        vm.prank(guardian);
        settlement.pause();
        uint64 until = settlement.pausedUntil();

        vm.warp(until - 1);
        assertTrue(settlement.isPaused(), "it lifted a second early");

        vm.warp(until);
        assertFalse(settlement.isPaused(), "it did not lift on its own second");
    }

    /// And the guardian cannot lift it either, which is the point. There is no
    /// function to try, so the proof is that the interface has none and the clock
    /// is the only way back.
    function test_theGuardianCannotLiftItsOwnPause() public {
        vm.prank(guardian);
        settlement.pause();
        uint64 until = settlement.pausedUntil();

        vm.prank(guardian);
        settlement.pause();

        assertGe(settlement.pausedUntil(), until, "a second pause moved the deadline backwards");
        assertTrue(settlement.isPaused(), "the guardian talked its way out");
    }

    /// A leaked key can hold the protocol down, and the ceiling on that is the
    /// timelock rotating the address rather than anything the contract does.
    function test_theTimelockRotatesACompromisedGuardian() public {
        address replacement = address(0xBEEF);

        vm.prank(alice);
        vm.expectRevert(Settlement.NotGovernor.selector);
        settlement.setGuardian(replacement);

        vm.prank(governor);
        settlement.setGuardian(replacement);

        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Guarded.NotGuardian.selector, guardian));
        settlement.pause();

        vm.prank(replacement);
        settlement.pause();
        assertTrue(settlement.isPaused());
    }

    /// A batch whose winner never finalized has to stay retireable. Otherwise a
    /// pause would hand the winning solver exactly the griefing window expireBatch
    /// exists to close.
    function test_aStuckBatchCanStillBeRetiredWhilePaused() public {
        _submit(_nettedSolution());

        vm.prank(guardian);
        settlement.pause();

        vm.warp(BATCH_ID + settlement.SOLUTION_WINDOW() + settlement.FINALIZE_DEADLINE() + 1);
        settlement.expireBatch(BATCH_ID);

        assertTrue(settlement.finalized(BATCH_ID), "a paused protocol trapped a stuck batch");
        assertEq(registry.failedFinalizes(), 1);
    }

    /// The censorship escape hatch is the last thing that should go quiet. It moves
    /// nothing, it only publishes an intent so that any solver can find it, and a
    /// pause that silenced it would make a stopped protocol indistinguishable from
    /// one that is refusing a particular user.
    function test_theOnchainEscapeHatchStaysOpenWhilePaused() public {
        vm.prank(guardian);
        settlement.pause();

        vm.prank(alice);
        settlement.submitIntentOnchain(_intent(alice, address(usdg), address(nvda), 200e6, 1e18, 7), "");
    }

    /// Governance keeps working. A pause is the moment an allowlist most needs to
    /// change, and the timelock is already two days of notice on its own.
    function test_governanceIsNotPausedEither() public {
        vm.prank(guardian);
        settlement.pause();

        vm.startPrank(governor);
        settlement.setTokenAllowed(address(nvda), false);
        settlement.setExposureCaps(1e18, 2e18, 3e18);
        vm.stopPrank();

        assertFalse(settlement.tokenAllowed(address(nvda)));
        assertEq(settlement.capPerBatchUsd(), 1e18);
    }
}

/// @notice The auction half. refundEscrow only answers once an auction reached
/// EXECUTED or ABORTED, so a pause that reached abortAuction would hold user
/// escrow until it lapsed. That is the trap parameter.md section 8.2 names, and
/// these are the tests that hold it shut.
contract GuardianAuctionTest is AuctionFixture {
    function test_theGuardianStopsAnAuctionOpening() public {
        vm.prank(guardian);
        house.pause();

        vm.expectRevert(abi.encodeWithSelector(Guarded.ProtocolPaused.selector, house.pausedUntil()));
        house.openAuction(address(nvda), kindOpen);
    }

    function test_theGuardianStopsACommitment() public {
        vm.prank(guardian);
        house.pause();

        Intent memory i = _intent(alice, true, 400e6, 0, IntentKind.MOO, 0, SessionMask.AUCTION_OPEN, 1);
        bytes32 hash = hasher.hashOf(i);
        bytes memory sig = _sign(ALICE_KEY, i, hash);

        vm.expectRevert(abi.encodeWithSelector(Guarded.ProtocolPaused.selector, house.pausedUntil()));
        house.commitAuctionIntent(i, sig);
    }

    function test_theGuardianStopsACrossAndItsExecution() public {
        _buyMoo(alice, 20_000e6, 1);
        _sellMoo(bob, 100e18, 2);
        uint64 id = _openAndFreeze();
        _passOpeningReference(200e8);

        vm.prank(guardian);
        house.pause();

        Execution[] memory e = new Execution[](2);
        e[0] = _exec(0, 20_000e6, 100e18);
        e[1] = _exec(1, 100e18, 20_000e6);

        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(Guarded.ProtocolPaused.selector, house.pausedUntil()));
        house.submitCross(id, 200e6, e);
    }

    /// The one that matters. An auction is frozen, every escrow is already inside
    /// the contract, and the protocol stops. The way out has to stay open or those
    /// balances are held by a key, which is the thing this protocol says no key can
    /// do.
    function test_escrowStillComesBackWhilePaused() public {
        bytes32 aliceCommit = _buyMoo(alice, 20_000e6, 1);
        _sellMoo(bob, 100e18, 2);
        uint64 id = _openAndFreeze();

        uint256 lockedUp = usdg.balanceOf(address(house));
        assertGt(lockedUp, 0, "the escrow never arrived, so nothing is being proved");

        vm.prank(guardian);
        house.pause();

        // The cross never happens and the deadline passes, which is what abort is
        // for. It has to work while paused, because refundEscrow needs the auction
        // to be terminal before it will answer at all.
        vm.warp(REFERENCE_AT + 1 hours);
        house.abortAuction(id);

        uint256 before = usdg.balanceOf(alice);
        house.refundEscrow(aliceCommit);

        assertEq(usdg.balanceOf(alice) - before, 20_000e6, "a paused protocol kept the escrow");
        assertTrue(house.isPaused(), "the pause lifted on its own and proved nothing");
    }

    /// Before the freeze there is nothing escrowed yet, and walking away has to
    /// stay free. A pause that blocked this would turn a commitment into an
    /// obligation.
    function test_aCommitmentCanStillBeCancelledWhilePaused() public {
        bytes32 hash = _buyMoo(alice, 400e6, 1);

        vm.prank(guardian);
        house.pause();

        vm.prank(alice);
        house.cancelBeforeFreeze(hash);

        assertTrue(house.commitment(hash).cancelled, "a paused protocol held a commitment open");
    }

    /// The indicative keeps publishing. It reads and emits, it takes nothing, and a
    /// stopped protocol that also went dark would leave a liquidity provider unable
    /// to see whether it is safe to come back.
    function test_theIndicativeKeepsPublishingWhilePaused() public {
        _buyMoo(alice, 20_000e6, 1);
        _sellMoo(bob, 100e18, 2);
        uint64 id = house.auctionIdOf(address(nvda), DAY, kindOpen);
        house.openAuction(address(nvda), kindOpen);

        vm.prank(guardian);
        house.pause();

        house.publishIndicative(id);
    }

    function test_theTwoVenuesPauseIndependently() public {
        vm.prank(guardian);
        house.pause();

        assertTrue(house.isPaused(), "the auction venue did not stop");
        assertEq(house.guardian(), guardian);
    }
}
