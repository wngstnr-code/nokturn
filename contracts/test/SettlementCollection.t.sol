// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Settlement} from "../src/Settlement.sol";
import {Solution} from "../src/types/Types.sol";
import {SettlementFixture} from "./fixtures/SettlementFixture.sol";

/// @notice What happens when an owner makes their own side of a batch impossible
/// after the solution window has already closed.
///
/// The window is the whole of the problem. Once it shuts no other solution can be
/// submitted, and finalize only accepts the one solution already recorded, so a
/// single owner withdrawing their approval decides the outcome for everyone else
/// in the batch. Found by the torture suite, scenarios C2-20 and C2-21.
contract SettlementCollectionTest is SettlementFixture {
    function test_anOwnerWhoRevokesCannotGetTheSolverSlashed() public {
        Solution memory s = _submit(_nettedSolution());

        vm.prank(alice);
        usdg.approve(address(permit2), 0);

        vm.warp(BATCH_ID + settlement.SOLUTION_WINDOW() + 1);
        settlement.finalize(BATCH_ID, s);

        assertTrue(settlement.finalized(BATCH_ID), "the batch is retired, not stuck");
        assertEq(usdg.balanceOf(alice), 1000e6, "alice keeps what could not be collected");
        assertEq(nvda.balanceOf(bob), 10e18, "bob is made whole");
        assertEq(usdg.balanceOf(address(settlement)), 0, "settlement holds nothing");
        assertEq(registry.failedFinalizes(), 0, "the solver did nothing wrong");
    }

    /// The second owner in the batch is already collected when the first failure
    /// lands, so the unwind has real work to do rather than being a formality.
    function test_anOwnerAlreadyCollectedIsGivenBack() public {
        Solution memory s = _submit(_nettedSolution());

        vm.prank(bob);
        nvda.approve(address(permit2), 0);

        vm.warp(BATCH_ID + settlement.SOLUTION_WINDOW() + 1);
        settlement.finalize(BATCH_ID, s);

        assertEq(usdg.balanceOf(alice), 1000e6, "alice is given back");
        assertEq(nvda.balanceOf(bob), 10e18, "bob kept his");
        assertEq(registry.failedFinalizes(), 0, "the solver did nothing wrong");
    }

    function test_anOwnerWhoBurnsTheirNonceCannotGetTheSolverSlashed() public {
        Solution memory s = _submit(_nettedSolution());

        uint256 nonce = s.intents[0].nonce;
        vm.prank(alice);
        permit2.invalidateUnorderedNonces(nonce >> 8, 2 ** (nonce & 0xff));

        vm.warp(BATCH_ID + settlement.SOLUTION_WINDOW() + 1);
        settlement.finalize(BATCH_ID, s);

        assertEq(usdg.balanceOf(alice), 1000e6, "alice keeps what could not be collected");
        assertEq(nvda.balanceOf(bob), 10e18, "bob is made whole");
        assertEq(registry.failedFinalizes(), 0, "the solver did nothing wrong");
    }

    /// The other half of the rule. A nonce that is already spent when the solution
    /// is offered is the solver's own doing, and it never becomes a passthrough
    /// that quietly retires a batch at nobody's cost.
    function test_aSolutionBuiltOnASpentNonceIsRefusedAtSubmission() public {
        uint256 nonce = 1;
        vm.prank(alice);
        permit2.invalidateUnorderedNonces(nonce >> 8, 2 ** (nonce & 0xff));

        Solution memory s = _nettedSolution();
        s.claimedSavings = 0.01e18 * 200 + 2e18;
        vm.warp(BATCH_ID + 1);
        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(Settlement.IntentNonceUsed.selector, uint256(0)));
        settlement.submitSolution(s);
    }

    /// A winner who simply never turns up is still slashed. The fix must not cost
    /// the protocol the case it was built for.
    function test_aWinnerWhoNeverShowsUpIsStillSlashed() public {
        _submit(_nettedSolution());

        vm.warp(BATCH_ID + settlement.SOLUTION_WINDOW() + settlement.FINALIZE_DEADLINE() + 1);
        settlement.expireBatch(BATCH_ID);

        assertEq(registry.failedFinalizes(), 1, "slashed");
    }
}
