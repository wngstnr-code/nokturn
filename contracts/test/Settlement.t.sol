// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {ClearingVerifier} from "../src/ClearingVerifier.sol";
import {PriceOracle} from "../src/PriceOracle.sol";
import {SessionManager} from "../src/SessionManager.sol";
import {Settlement} from "../src/Settlement.sol";
import {IClearingVerifier} from "../src/interfaces/IClearingVerifier.sol";
import {IPriceOracle} from "../src/interfaces/IPriceOracle.sol";
import {ISessionManager} from "../src/interfaces/ISessionManager.sol";
import {ISettlement} from "../src/interfaces/ISettlement.sol";
import {ISignatureTransfer} from "../src/interfaces/IPermit2.sol";
import {ISolverRegistry} from "../src/interfaces/ISolverRegistry.sol";
import {Execution, Intent, Session, SessionMask, Solution, VenueCall} from "../src/types/Types.sol";
import {SettlementFixture} from "./fixtures/SettlementFixture.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockPermit2} from "./mocks/MockPermit2.sol";
import {MockSolverRegistry} from "./mocks/MockSolverRegistry.sol";
import {MockAdapter} from "./mocks/MockAdapter.sol";
import {MockSwapAdapter} from "./mocks/MockSwapAdapter.sol";

contract SettlementTest is SettlementFixture {
    function test_nettedBatchSettlesWithNoVenueCall() public {
        Solution memory s = _submit(_nettedSolution());

        vm.warp(BATCH_ID + 20);
        vm.expectEmit(true, true, false, false);
        emit ISettlement.BatchSettled(BATCH_ID, solver, 3, 2, 0, 0, 0, 0, 0);
        settlement.finalize(BATCH_ID, s);

        assertEq(nvda.balanceOf(alice), 1e18, "alice got her NVDA");
        assertEq(usdg.balanceOf(bob), 200e6, "bob got his USDG");
        assertEq(usdg.balanceOf(alice), 800e6, "alice spent exactly her sell amount");
        assertTrue(settlement.finalized(BATCH_ID));
    }

    function test_theSameBatchCannotSettleTwice() public {
        Solution memory s = _submit(_nettedSolution());
        vm.warp(BATCH_ID + 20);
        settlement.finalize(BATCH_ID, s);

        vm.expectRevert(abi.encodeWithSelector(Settlement.AlreadyFinalized.selector, BATCH_ID));
        settlement.finalize(BATCH_ID, s);
    }

    function test_onlyBondedSolversMaySubmit() public {
        Solution memory s = _nettedSolution();
        s.claimedSavings = 4e18;
        vm.warp(BATCH_ID + 1);
        vm.expectRevert(abi.encodeWithSelector(Settlement.SolverNotActive.selector, address(this)));
        settlement.submitSolution(s);
    }

    function test_claimedSavingsMustMatchTheComputedOnes() public {
        Solution memory s = _nettedSolution();
        s.claimedSavings = 100e18;
        vm.warp(BATCH_ID + 1);
        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(ISettlement.SavingsMismatch.selector, 100e18, 4e18));
        settlement.submitSolution(s);
    }

    function test_solutionsOutsideTheWindowAreRejected() public {
        Solution memory s = _nettedSolution();
        s.claimedSavings = 4e18;

        vm.warp(BATCH_ID - 1);
        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(ISettlement.SolutionWindowClosed.selector, BATCH_ID));
        settlement.submitSolution(s);

        vm.warp(BATCH_ID + 11);
        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(ISettlement.SolutionWindowClosed.selector, BATCH_ID));
        settlement.submitSolution(s);
    }

    function test_finalizeWaitsForTheSolutionWindowToClose() public {
        Solution memory s = _submit(_nettedSolution());
        vm.warp(BATCH_ID + 5);
        vm.expectRevert(abi.encodeWithSelector(ISettlement.SolutionWindowClosed.selector, BATCH_ID));
        settlement.finalize(BATCH_ID, s);
    }

    function test_finalizeRejectsAPayloadThatIsNotTheWinner() public {
        Solution memory s = _submit(_nettedSolution());
        s.baselineQuotes[0] = 0.5e18; // same batch, different payload
        vm.warp(BATCH_ID + 20);
        vm.expectRevert(abi.encodeWithSelector(Settlement.SolutionHashMismatch.selector, BATCH_ID));
        settlement.finalize(BATCH_ID, s);
    }

    /// A corporate action landing between submit and finalize changes the meaning
    /// of every amount in the batch. Three of the four measured multiplier moves
    /// happened inside the OPEN session, so this is not a theoretical window.
    function test_multiplierChangingMidBatchStopsTheSettlement() public {
        Solution memory s = _submit(_nettedSolution());
        nvda.setUiMultiplier(1.000775e18);

        vm.warp(BATCH_ID + 20);
        vm.expectRevert();
        settlement.finalize(BATCH_ID, s);
    }

    function test_batchIdMustAlignToTheSessionDuration() public {
        uint64 misaligned = BATCH_ID + 3;
        vm.expectRevert(abi.encodeWithSelector(Settlement.BatchMisaligned.selector, misaligned, uint32(10)));
        settlement.batchWindow(misaligned);
    }

    function test_unallowlistedTokenCannotBeSettled() public {
        vm.prank(governor);
        settlement.setTokenAllowed(address(nvda), false);

        Solution memory s = _nettedSolution();
        s.claimedSavings = 4e18;
        vm.warp(BATCH_ID + 1);
        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(ISettlement.TokenNotAllowed.selector, address(nvda)));
        settlement.submitSolution(s);
    }

    function test_anUnhealthyOracleStopsTheBatch() public {
        vm.warp(BATCH_ID + 1);
        vm.warp(DAY_OPEN + 6001 + 10);
        Solution memory s = _nettedSolution();
        // Snap to the 10 second OPEN batch grid.
        // forge-lint: disable-next-line(divide-before-multiply)
        s.batchId = uint64((block.timestamp / 10) * 10);
        s.claimedSavings = 4e18;
        vm.prank(solver);
        vm.expectRevert();
        settlement.submitSolution(s);
    }

    /// The escape hatch has to be usable, so it publishes the signature too.
    function test_escapeHatchPublishesTheWholeIntent() public {
        Intent memory i = _intent(alice, address(usdg), address(nvda), 200e6, 1e18, 9);
        vm.recordLogs();
        settlement.submitIntentOnchain(i, hex"1234");
        assertEq(vm.getRecordedLogs().length, 1);
    }

    function test_nonceUsedReadsThroughToPermit2() public {
        assertFalse(settlement.nonceUsed(alice, 1));
        Solution memory s = _submit(_nettedSolution());
        vm.warp(BATCH_ID + 20);
        settlement.finalize(BATCH_ID, s);
        assertTrue(settlement.nonceUsed(alice, 1));
        assertFalse(settlement.nonceUsed(alice, 3));
    }

    /// The imbalance goes to the venue. The adapter allowance is granted for the
    /// exact amount and taken back in the same transaction.
    function test_unmatchedFlowRoutesToTheVenue() public {
        Solution memory s;
        s.batchId = BATCH_ID;
        s.intents = new Intent[](1);
        s.intents[0] = _intent(alice, address(usdg), address(nvda), 200e6, 0.99e18, 1);
        s.signatures = new bytes[](1);
        s.tokens = new address[](2);
        s.tokens[0] = address(usdg);
        s.tokens[1] = address(nvda);
        s.prices = new uint256[](2);
        s.prices[0] = 1e30;
        s.prices[1] = 200e18;
        s.executions = new Execution[](1);
        s.executions[0] = Execution({intentIndex: 0, executedSell: 200e6, executedBuy: 1e18});
        s.venueCalls = new VenueCall[](1);
        s.venueCalls[0] = VenueCall({
            adapter: address(adapter),
            tokenIn: address(usdg),
            tokenOut: address(nvda),
            amountIn: 200e6,
            minOut: 1e18
        });
        s.baselineQuotes = new uint256[](1);
        s.baselineQuotes[0] = 1e18; // the venue is the baseline here, so no savings
        s.claimedSavings = 0;
        s.solver = solver;

        vm.warp(BATCH_ID + 1);
        vm.prank(solver);
        settlement.submitSolution(s);

        vm.warp(BATCH_ID + 20);
        settlement.finalize(BATCH_ID, s);

        assertEq(nvda.balanceOf(alice), 1e18);
        assertEq(usdg.balanceOf(address(adapter)), 200e6, "the venue took the flow");
        assertEq(usdg.allowance(address(settlement), address(adapter)), 0, "allowance taken back");
    }

    function test_venueCallsMustUseAnAllowlistedAdapter() public {
        MockSwapAdapter rogue = new MockSwapAdapter();
        rogue.setRate(address(usdg), address(nvda), 0.005e18);

        Solution memory s = _nettedSolution();
        s.venueCalls = new VenueCall[](1);
        s.venueCalls[0] = VenueCall({
            adapter: address(rogue), tokenIn: address(usdg), tokenOut: address(nvda), amountIn: 1, minOut: 0
        });
        s.claimedSavings = 4e18;

        vm.warp(BATCH_ID + 1);
        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(ISettlement.AdapterNotAllowed.selector, address(rogue)));
        settlement.submitSolution(s);
    }

    /// An adapter that cannot compute a baseline from state cannot back a fee, so
    /// it is refused outright. This is the V4 case, and it is why v1.0 ships one
    /// adapter rather than a longer list.
    function test_unquotableAdapterIsRefused() public {
        adapter.setQuotable(false);

        Solution memory s = _nettedSolution();
        s.venueCalls = new VenueCall[](1);
        s.venueCalls[0] = VenueCall({
            adapter: address(adapter), tokenIn: address(usdg), tokenOut: address(nvda), amountIn: 1, minOut: 0
        });
        s.claimedSavings = 4e18;

        vm.warp(BATCH_ID + 1);
        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(ISettlement.AdapterNotQuotable.selector, address(adapter)));
        settlement.submitSolution(s);
    }

    /// The solver keeps 15 of the 20, the protocol 5, and the user keeps the rest.
    /// Withholding is only possible inside the 3 bps tolerance, so the cap is not
    /// a policy that someone has to honour, it is arithmetic.
    function test_feeSplitsSeventyFiveTwentyFiveAndIsCappedByArithmetic() public {
        Solution memory s = _nettedSolution();
        // Limits sit below the clearing price, which is what a real limit does.
        // Without that there is no room for a fee, and the user's own limit is the
        // first thing that stops one.
        s.intents[0].minBuyAmount = 0.99e18;
        s.intents[1].minBuyAmount = 198e6;
        // Both sides give up 3 bps, which is the most the uniform price check allows.
        s.executions[0].executedBuy = 1e18 - 0.0003e18;
        s.executions[1].executedBuy = 200e6 - 0.06e6;
        s.baselineQuotes[0] = 0.99e18;
        s.baselineQuotes[1] = 198e6;

        uint256 savings =
            ((1e18 - 0.0003e18 - 0.99e18) * 200e18) / 1e18 + ((200e6 - 0.06e6 - 198e6) * 1e30) / 1e18;
        s.claimedSavings = savings;

        vm.warp(BATCH_ID + 1);
        vm.prank(solver);
        settlement.submitSolution(s);

        vm.warp(BATCH_ID + 20);
        settlement.finalize(BATCH_ID, s);

        assertEq(nvda.balanceOf(solver), (0.0003e18 * 7500) / 10_000, "solver takes 75 percent of the fee");
        assertEq(nvda.balanceOf(treasury), 0.0003e18 - (0.0003e18 * 7500) / 10_000, "protocol takes the rest");
        assertEq(usdg.balanceOf(solver), (0.06e6 * 7500) / 10_000);
        assertEq(nvda.balanceOf(address(settlement)), 0, "nothing is left behind");
    }

    /// Below one basis point of savings nobody is paid. You only pay when we beat
    /// the market, and the contract is where that sentence is enforced.
    function test_belowThresholdNobodyIsPaid() public {
        // The venue would have done almost exactly as well, so there is nothing to
        // share and nothing is withheld either. Withholding without savings is
        // refused outright by the fee cap, which this test relies on staying true.
        Solution memory s = _nettedSolution();
        s.baselineQuotes[0] = 1e18 - 1;
        s.baselineQuotes[1] = 200e6;
        s.claimedSavings = 200;

        vm.warp(BATCH_ID + 1);
        vm.prank(solver);
        settlement.submitSolution(s);

        vm.warp(BATCH_ID + 20);
        vm.recordLogs();
        settlement.finalize(BATCH_ID, s);

        bytes32 wanted = keccak256("BatchPassthrough(uint64,uint256,string)");
        bool found;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 n = 0; n < logs.length; ++n) {
            if (logs[n].topics[0] == wanted) found = true;
        }
        assertTrue(found, "the batch reports itself as a pass through");

        assertEq(nvda.balanceOf(solver), 0, "no savings, no fee");
        assertEq(usdg.balanceOf(solver), 0);
    }

    function test_exposureCapStopsAnOversizedBatch() public {
        vm.prank(governor);
        settlement.setExposureCaps(100e18, 50_000e18, 200_000e18);

        Solution memory s = _submit(_nettedSolution());
        vm.warp(BATCH_ID + 20);
        vm.expectRevert();
        settlement.finalize(BATCH_ID, s);
    }

    /// Two hundred dollars of USDG against two hundred dollars of NVDA is four
    /// hundred dollars of notional, and the cap is what that number is for. USDG
    /// has six decimals, so a price per whole token would have made its half of
    /// this batch read as two ten billionths of a dollar and the cap would have
    /// stopped binding on the asset that quotes nearly every pair.
    function test_aSixDecimalLegIsMeasuredInDollarsLikeEveryOtherLeg() public {
        vm.prank(governor);
        settlement.setExposureCaps(399e18, 50_000e18, 200_000e18);

        Solution memory s = _submit(_nettedSolution());
        vm.warp(BATCH_ID + 20);
        vm.expectRevert(
            abi.encodeWithSelector(ISettlement.ExposureCapExceeded.selector, bytes32("batch"), 400e18, 399e18)
        );
        settlement.finalize(BATCH_ID, s);
    }

    function test_bestSolutionReportsTheWinner() public {
        Solution memory s = _submit(_nettedSolution());
        (bytes32 hash, uint256 savings, address winner) = settlement.bestSolution(BATCH_ID);
        assertEq(hash, keccak256(abi.encode(s)));
        assertEq(savings, 4e18);
        assertEq(winner, solver);
    }

    /// A second solver with a worse solution is rejected by event, not by revert.
    /// Monitoring needs the negative signal as much as the positive one.
    function test_aWorseSecondSolutionLosesWithoutReverting() public {
        Solution memory winner = _submit(_nettedSolution());

        address rival = address(0x21BA1);
        registry.setActive(rival, true);
        Solution memory worse = _nettedSolution();
        worse.baselineQuotes[0] = 0.995e18;
        worse.baselineQuotes[1] = 199e6;
        worse.claimedSavings = (0.005e18 * 200e18) / 1e18 + ((200e6 - 199e6) * 1e30) / 1e18;

        vm.prank(rival);
        settlement.submitSolution(worse);

        (, uint256 savings, address held) = settlement.bestSolution(BATCH_ID);
        assertEq(held, solver, "the better solution still holds the batch");
        assertEq(savings, winner.claimedSavings);
    }

    function test_aSolverCannotSpamMoreThanThreeSolutions() public {
        Solution memory s = _nettedSolution();
        s.claimedSavings = 4e18;
        vm.warp(BATCH_ID + 1);
        vm.startPrank(solver);
        settlement.submitSolution(s);
        settlement.submitSolution(s);
        settlement.submitSolution(s);
        vm.expectRevert(abi.encodeWithSelector(Settlement.TooManySolutions.selector, solver));
        settlement.submitSolution(s);
        vm.stopPrank();
    }

    function test_aFinalizedBatchAcceptsNoMoreSolutions() public {
        Solution memory s = _submit(_nettedSolution());
        vm.warp(BATCH_ID + 20);
        settlement.finalize(BATCH_ID, s);

        vm.warp(BATCH_ID + 1);
        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(Settlement.AlreadyFinalized.selector, BATCH_ID));
        settlement.submitSolution(s);
    }

    /// An intent that did not opt into this session never executes, even though
    /// everything else about it is valid.
    function test_anIntentThatBarredThisSessionIsRefused() public {
        Solution memory s = _nettedSolution();
        s.intents[0].allowedSessions = SessionMask.CLOSED_WEEKEND;
        s.claimedSavings = 4e18;

        vm.warp(BATCH_ID + 1);
        vm.prank(solver);
        settlement.submitSolution(s);

        vm.warp(BATCH_ID + 20);
        vm.expectRevert(
            abi.encodeWithSelector(ISettlement.SessionNotAllowed.selector, 0, uint8(Session.OPEN))
        );
        settlement.finalize(BATCH_ID, s);
    }

    /// An expired intent is refused when the solution is offered. The permit behind
    /// it carries the same deadline, so a solution built on one could never have
    /// been collected, and there is nothing to learn by waiting until finalize to
    /// say so.
    function test_anExpiredIntentIsRefusedAtSubmission() public {
        Solution memory s = _nettedSolution();
        // forge-lint: disable-next-line(unsafe-typecast)
        s.intents[0].validUntil = uint32(BATCH_ID - 1);
        s.claimedSavings = 4e18;

        vm.warp(BATCH_ID + 1);
        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(ISettlement.IntentExpired.selector, 0));
        settlement.submitSolution(s);

        (bytes32 hash,,) = settlement.bestSolution(BATCH_ID);
        assertEq(hash, bytes32(0), "and it leaves no winner behind");
    }

    function test_dailyTokenCapAccumulatesAcrossBatches() public {
        vm.prank(governor);
        settlement.setExposureCaps(5000e18, 150e18, 200_000e18);

        Solution memory s = _submit(_nettedSolution());
        vm.warp(BATCH_ID + 20);
        vm.expectRevert();
        settlement.finalize(BATCH_ID, s);
    }

    /// The word in the name of the cap is daily. Two hundred dollars of each token
    /// on Wednesday must not count against Thursday, or the cap stops being an
    /// exposure limit and becomes a lifetime quota that eventually retires the
    /// token for good. Settlement is immutable, so there is no second chance.
    function test_theDailyTokenCapStartsOverOnTheNextDay() public {
        vm.prank(governor);
        settlement.setExposureCaps(5000e18, 300e18, 200_000e18);

        Solution memory first = _submit(_nettedSolution());
        vm.warp(BATCH_ID + 20);
        settlement.finalize(BATCH_ID, first);

        uint64 nextDay = BATCH_ID + 1 days;
        usdg.mint(alice, 200e6);
        nvda.mint(bob, 1e18);

        vm.warp(nextDay - 60);
        usdgFeed.push(1e8, block.timestamp);
        nvdaFeed.push(200e8, block.timestamp);

        Solution memory second = _nettedSolution();
        second.batchId = nextDay;
        second.intents[0].nonce = 11;
        second.intents[1].nonce = 12;
        second.claimedSavings = 0.01e18 * 200 + 2e18;

        vm.warp(nextDay + 1);
        vm.prank(solver);
        settlement.submitSolution(second);

        vm.warp(nextDay + 20);
        settlement.finalize(nextDay, second);

        assertEq(nvda.balanceOf(alice), 2e18, "two days of settlement, both of them cleared");
    }

    /// USDG has no uiMultiplier at all, so the read has to survive a token that
    /// simply does not implement it rather than assuming every token is a Stock
    /// Token.
    function test_aTokenWithoutAMultiplierIsStillSettleable() public {
        MockERC20 plain = new MockERC20("Plain", "PLN", 18);
        assertEq(plain.uiMultiplier(), 1e18);
        Solution memory s = _submit(_nettedSolution());
        vm.warp(BATCH_ID + 20);
        settlement.finalize(BATCH_ID, s);
        assertTrue(settlement.finalized(BATCH_ID));
    }

    /// A winner that never finalizes blocks every other solution for that batch.
    /// No funds move before finalize, so nothing is stuck, but the block is real
    /// and anyone can make the consequence land.
    function test_aBatchTheWinnerAbandonedCanBeRetiredByAnyone() public {
        _submit(_nettedSolution());

        vm.warp(BATCH_ID + 20);
        vm.expectRevert(abi.encodeWithSelector(ISettlement.SolutionWindowClosed.selector, BATCH_ID));
        settlement.expireBatch(BATCH_ID);

        vm.warp(BATCH_ID + 10 + 301);
        settlement.expireBatch(BATCH_ID);

        assertTrue(settlement.finalized(BATCH_ID), "the batch is retired, not left hanging");
        assertEq(registry.failedFinalizes(), 1, "and the winner is reported for it");
    }

    function test_anExpiredBatchCannotThenBeFinalized() public {
        Solution memory s = _submit(_nettedSolution());
        vm.warp(BATCH_ID + 10 + 301);
        settlement.expireBatch(BATCH_ID);

        vm.expectRevert(abi.encodeWithSelector(Settlement.AlreadyFinalized.selector, BATCH_ID));
        settlement.finalize(BATCH_ID, s);
    }

    function test_aBatchNobodySolvedHasNothingToExpire() public {
        vm.warp(BATCH_ID + 10 + 301);
        vm.expectRevert(abi.encodeWithSelector(Settlement.NoWinningSolution.selector, BATCH_ID));
        settlement.expireBatch(BATCH_ID);
    }

    function test_theWinnerIsCreditedOnASuccessfulSettlement() public {
        Solution memory s = _submit(_nettedSolution());
        vm.warp(BATCH_ID + 20);
        settlement.finalize(BATCH_ID, s);

        assertEq(registry.lastWinner(), solver);
        assertEq(registry.lastSavings(), 4e18);
    }

    function test_governorOnlyControlsTheAllowlists() public {
        vm.expectRevert(Settlement.NotGovernor.selector);
        settlement.setTokenAllowed(address(nvda), false);

        vm.expectRevert(Settlement.NotGovernor.selector);
        settlement.setAdapterAllowed(address(adapter), false);

        vm.expectRevert(Settlement.NotGovernor.selector);
        settlement.setExposureCaps(1, 2, 3);
    }

    /// parameter.md section 4C. Nothing on chain used to check the baseline a solver
    /// claimed, and savings is what picks the winner and sets the fee cap. These
    /// four hold the floor that closes it.
    function test_aBaselineBelowTheVenueIsRefused() public {
        Solution memory s = _nettedSolution();
        s.baselineQuotes[0] = 0;
        s.baselineQuotes[1] = 0;
        s.claimedSavings = (1e18 * 200e18) / 1e18 + (200e6 * 1e30) / 1e18;

        vm.warp(BATCH_ID + 1);
        vm.prank(solver);
        vm.expectRevert(
            abi.encodeWithSelector(
                ISettlement.BaselineBelowVenue.selector, address(usdg), address(nvda), 0, 0.99e18
            )
        );
        settlement.submitSolution(s);
    }

    /// The floor is a floor, not a target. Claiming exactly what the venue quotes
    /// is allowed, and one unit under it is not.
    function test_theFloorBitesAtExactlyOneUnitBelow() public {
        Solution memory s = _nettedSolution();
        s.baselineQuotes[0] = 0.99e18 - 1;
        _submitExpectingFloor(s, 0.99e18 - 1);

        Solution memory atTheFloor = _nettedSolution();
        atTheFloor.baselineQuotes[0] = 0.99e18;
        atTheFloor.claimedSavings = 0.01e18 * 200 + 2e18;
        vm.warp(BATCH_ID + 1);
        vm.prank(solver);
        settlement.submitSolution(atTheFloor);
    }

    /// A venue that cannot be read is not an excuse to trust the solver's number.
    /// The batch still settles and the users still get their fills, but there is no
    /// surplus to share, so nobody is paid.
    function test_anUnreadableVenueMakesTheBatchAPassThrough() public {
        // MockAdapter answers isQuotable but reverts on the quote itself, which is
        // what a pool past MAX_TICK_CROSSINGS or behind a dynamic fee looks like.
        MockAdapter blind = new MockAdapter();
        vm.startPrank(governor);
        settlement.setAdapterAllowed(address(blind), true);
        settlement.setBaselineAdapter(address(blind));
        vm.stopPrank();

        Solution memory s = _nettedSolution();
        s.claimedSavings = 0;

        vm.warp(BATCH_ID + 1);
        vm.prank(solver);
        settlement.submitSolution(s);

        vm.warp(BATCH_ID + 20);
        settlement.finalize(BATCH_ID, s);

        assertEq(nvda.balanceOf(alice), 1e18, "the user is filled either way");
        assertEq(usdg.balanceOf(solver), 0, "and nobody is paid for an unchecked claim");
    }

    function test_onlyTheGovernorNamesTheBaselineAdapter() public {
        vm.expectRevert(Settlement.NotGovernor.selector);
        settlement.setBaselineAdapter(address(venueQuotes));

        MockSwapAdapter stranger = new MockSwapAdapter();
        vm.prank(governor);
        vm.expectRevert(abi.encodeWithSelector(ISettlement.AdapterNotAllowed.selector, address(stranger)));
        settlement.setBaselineAdapter(address(stranger));
    }

    function _submitExpectingFloor(Solution memory s, uint256 claimed) internal {
        s.claimedSavings = ((1e18 - claimed) * 200e18) / 1e18 + ((200e6 - 198e6) * 1e30) / 1e18;
        vm.warp(BATCH_ID + 1);
        vm.prank(solver);
        vm.expectRevert(
            abi.encodeWithSelector(
                ISettlement.BaselineBelowVenue.selector, address(usdg), address(nvda), claimed, 0.99e18
            )
        );
        settlement.submitSolution(s);
    }
}
