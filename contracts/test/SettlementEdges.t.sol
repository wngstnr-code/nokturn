// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {Settlement} from "../src/Settlement.sol";
import {ISettlement} from "../src/interfaces/ISettlement.sol";
import {Execution, Intent, Solution, VenueCall} from "../src/types/Types.sol";
import {IntentLib} from "../src/libraries/IntentLib.sol";
import {SettlementFixture} from "./fixtures/SettlementFixture.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockPermit2} from "./mocks/MockPermit2.sol";

/// @dev IntentLib hashes calldata, and a test builds its intents in memory. One
/// external hop is what turns one into the other.
contract IntentHasher {
    function hashOf(Intent calldata i) external pure returns (bytes32) {
        return IntentLib.hash(i);
    }
}

/// @notice The boundaries and the arithmetic, one assertion at a time. Mutation
/// testing put this file here. Every test below corresponds to a single operator
/// the suite could flip without a test noticing, which is the same thing as saying
/// the contract could have shipped with that operator the other way round.
contract SettlementEdgesTest is SettlementFixture {
    address carol = address(0xCA401);
    address second = address(0x5EC0D);
    IntentHasher hasher = new IntentHasher();

    bytes32 constant TRANSFER = keccak256("Transfer(address,address,uint256)");

    function _submitAt(Solution memory s, uint256 savings) internal {
        s.claimedSavings = savings;
        vm.warp(s.batchId + 1);
        vm.prank(solver);
        settlement.submitSolution(s);
    }

    /// @dev Counts ERC20 Transfer events on one token that landed on one address,
    /// zero value included. A zero value transfer is not harmless. It costs gas and
    /// it puts a fill in front of every indexer that reads these logs.
    function _transfersTo(Vm.Log[] memory logs, address token, address to)
        internal
        pure
        returns (uint256 count)
    {
        for (uint256 n = 0; n < logs.length; ++n) {
            if (logs[n].emitter != token) continue;
            if (logs[n].topics[0] != TRANSFER) continue;
            if (address(uint160(uint256(logs[n].topics[2]))) != to) continue;
            ++count;
        }
    }

    function test_theCollectionWindowStartsOneDurationBeforeTheBatch() public view {
        (uint64 collectStart, uint64 collectEnd, uint64 solveEnd) = settlement.batchWindow(BATCH_ID);
        assertEq(collectEnd, BATCH_ID, "collection closes on the batch mark itself");
        assertEq(collectStart, BATCH_ID - 10, "and it opened one open session duration earlier");
        assertEq(solveEnd, BATCH_ID + settlement.SOLUTION_WINDOW(), "solving runs past the mark");
    }

    function test_aSolutionOnTheCollectionMarkIsTooEarly() public {
        Solution memory s = _nettedSolution();
        s.claimedSavings = 0.01e18 * 200 + 2e18;
        vm.warp(BATCH_ID);
        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(ISettlement.SolutionWindowClosed.selector, BATCH_ID));
        settlement.submitSolution(s);
    }

    function test_aSolutionOnTheLastSecondOfTheWindowIsStillTaken() public {
        Solution memory s = _nettedSolution();
        s.claimedSavings = 0.01e18 * 200 + 2e18;
        vm.warp(BATCH_ID + settlement.SOLUTION_WINDOW());
        vm.prank(solver);
        settlement.submitSolution(s);

        (, uint256 savings, address winner) = settlement.bestSolution(BATCH_ID);
        assertEq(winner, solver, "the last second of the window is inside it");
        assertEq(savings, 0.01e18 * 200 + 2e18);
    }

    /// A solution that ties does not win. Otherwise the last solver in the window
    /// takes the batch from the first one for free, and every solver learns to
    /// copy rather than to search.
    function test_asGoodAsTheBestIsNotBetterThanIt() public {
        registry.setActive(second, true);
        Solution memory s = _nettedSolution();
        _submitAt(s, 0.01e18 * 200 + 2e18);

        vm.prank(second);
        settlement.submitSolution(s);

        (,, address winner) = settlement.bestSolution(BATCH_ID);
        assertEq(winner, solver, "the first to reach that number keeps it");
    }

    function test_finalizeOnTheLastSecondOfTheSolvingWindowIsTooEarly() public {
        Solution memory s = _nettedSolution();
        _submitAt(s, 0.01e18 * 200 + 2e18);

        vm.warp(BATCH_ID + settlement.SOLUTION_WINDOW());
        vm.expectRevert(abi.encodeWithSelector(ISettlement.SolutionWindowClosed.selector, BATCH_ID));
        settlement.finalize(BATCH_ID, s);
    }

    function test_expiryOnTheDeadlineItselfIsTooEarly() public {
        Solution memory s = _nettedSolution();
        _submitAt(s, 0.01e18 * 200 + 2e18);

        vm.warp(BATCH_ID + settlement.SOLUTION_WINDOW() + settlement.FINALIZE_DEADLINE());
        vm.expectRevert(abi.encodeWithSelector(ISettlement.SolutionWindowClosed.selector, BATCH_ID));
        settlement.expireBatch(BATCH_ID);
    }

    function test_anIntentThatOpensOnTheCollectionMarkIsStillInTheBatch() public {
        Solution memory s = _nettedSolution();
        s.intents[0].validAfter = uint32(BATCH_ID);
        _submitAt(s, 0.01e18 * 200 + 2e18);

        vm.warp(BATCH_ID + 20);
        settlement.finalize(BATCH_ID, s);
        assertEq(nvda.balanceOf(alice), 1e18, "valid from the close of collection means valid for it");
    }

    /// An intent has to stay valid through the solving window, not just the batch.
    /// The same number is the permit deadline and finalize runs after the mark, so
    /// such a solution can never be collected. It is turned away when it is offered
    /// rather than when it is settled, because a solution that is already dead on
    /// arrival is the solver's own doing and finalize no longer distinguishes.
    function test_anIntentExpiringOnTheCollectionMarkIsRefusedAtSubmission() public {
        Solution memory s = _nettedSolution();
        s.intents[0].validUntil = uint32(BATCH_ID);

        vm.warp(BATCH_ID + 1);
        s.claimedSavings = 0.01e18 * 200 + 2e18;
        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(ISettlement.IntentExpired.selector, uint256(0)));
        settlement.submitSolution(s);
    }

    /// Either leg leaving the allowlist between submission and finalize stops the
    /// batch. The pair is only as allowed as its less allowed side.
    function test_oneSideOfThePairLeavingTheAllowlistStopsTheBatch() public {
        Solution memory s = _nettedSolution();
        _submitAt(s, 0.01e18 * 200 + 2e18);

        vm.prank(governor);
        settlement.setTokenAllowed(address(nvda), false);

        vm.warp(BATCH_ID + 20);
        vm.expectRevert(abi.encodeWithSelector(ISettlement.TokenNotAllowed.selector, address(nvda)));
        settlement.finalize(BATCH_ID, s);
    }

    /// An intent that cleared nothing this batch is delivered nothing. Not zero
    /// tokens, nothing at all, because a zero value transfer is a fill as far as
    /// every log reader is concerned.
    function test_anUnfilledIntentGetsNoTransferAtAll() public {
        Solution memory s = _nettedSolution();

        Intent[] memory intents = new Intent[](3);
        intents[0] = s.intents[0];
        intents[1] = s.intents[1];
        intents[2] = _intent(alice, address(usdg), address(nvda), 100e6, 0.4e18, 3);
        intents[2].receiver = carol;
        intents[2].flags = 1; // partial fill, which is what lets the fill be none
        s.intents = intents;
        s.signatures = new bytes[](3);

        Execution[] memory executions = new Execution[](3);
        executions[0] = s.executions[0];
        executions[1] = s.executions[1];
        executions[2] = Execution({intentIndex: 2, executedSell: 0, executedBuy: 0});
        s.executions = executions;

        uint256[] memory baselines = new uint256[](3);
        baselines[0] = s.baselineQuotes[0];
        baselines[1] = s.baselineQuotes[1];
        s.baselineQuotes = baselines;

        _submitAt(s, 0.01e18 * 200 + 2e18);

        vm.warp(BATCH_ID + 20);
        vm.recordLogs();
        settlement.finalize(BATCH_ID, s);

        assertEq(_transfersTo(vm.getRecordedLogs(), address(nvda), carol), 0, "nothing was sent to carol");
        assertEq(nvda.balanceOf(carol), 0);
    }

    /// Tokens sent to the core outside a batch are not the fee wedge and are not
    /// paid out as one. They are also not recoverable, which is the price of a
    /// contract with no key that can move a balance.
    function test_aDonationToTheCoreIsNotMistakenForTheFeeWedge() public {
        usdg.mint(address(settlement), 500e6);

        Solution memory s = _nettedSolution();
        s.intents[0].minBuyAmount = 0.99e18;
        s.intents[1].minBuyAmount = 198e6;
        s.executions[0].executedBuy = 1e18 - 0.0003e18;
        s.executions[1].executedBuy = 200e6 - 0.06e6;

        uint256 savings =
            ((1e18 - 0.0003e18 - 0.99e18) * 200e18) / 1e18 + ((200e6 - 0.06e6 - 198e6) * 1e30) / 1e18;
        _submitAt(s, savings);

        vm.warp(BATCH_ID + 20);
        settlement.finalize(BATCH_ID, s);

        assertEq(usdg.balanceOf(solver), (0.06e6 * 7500) / 10_000, "the wedge is the only thing split");
        assertEq(usdg.balanceOf(address(settlement)), 500e6, "the donation stays exactly where it landed");
    }

    /// Below a certain surplus the share of it is the smaller of the two caps, and
    /// then withholding the full band is too much. The cap that binds has to be the
    /// share, not the notional, or a batch with no surplus could still charge.
    function test_theShareOfSurplusBindsBeforeTheNotionalCapDoes() public {
        Solution memory s = _nettedSolution();
        s.intents[0].minBuyAmount = 0.99e18;
        s.intents[1].minBuyAmount = 198e6;
        s.executions[0].executedBuy = 1e18 - 0.0003e18;
        s.executions[1].executedBuy = 200e6 - 0.06e6;
        // Twenty cents of surplus against twelve cents of wedge. Twenty percent of
        // thirty two cents is six point four, and twelve is more than that.
        s.baselineQuotes[0] = 1e18 - 0.0003e18 - 0.001e18;
        s.baselineQuotes[1] = 200e6 - 0.06e6;
        _submitAt(s, 0.2e18);

        vm.warp(BATCH_ID + 20);
        vm.expectRevert(abi.encodeWithSelector(Settlement.FeeExceedsCap.selector, 0.12e18, 0.064e18));
        settlement.finalize(BATCH_ID, s);
    }

    /// One basis point of notional is the threshold and it is reached, not passed.
    /// A batch sitting exactly on it pays, because the sentence is that you pay
    /// when we beat the market by a basis point.
    function test_savingsExactlyOnTheThresholdStillPay() public {
        Solution memory s = _nettedSolution();
        s.intents[0].minBuyAmount = 0.99e18;
        s.intents[1].minBuyAmount = 198e6;
        s.executions[1].executedBuy = 200e6 - 10_000;
        // Four hundred dollars of notional, so one basis point is four cents.
        s.baselineQuotes[0] = 1e18 - 0.0002e18;
        s.baselineQuotes[1] = 200e6 - 10_000;
        _submitAt(s, 0.04e18);

        vm.warp(BATCH_ID + 20);
        settlement.finalize(BATCH_ID, s);

        assertEq(usdg.balanceOf(solver), (10_000 * 7500) / 10_000, "the solver is paid at the threshold");
        assertEq(usdg.balanceOf(treasury), 10_000 - (10_000 * 7500) / 10_000);
    }

    /// Under the threshold the wedge goes to the treasury whole and the solver is
    /// sent nothing rather than sent zero.
    function test_aPassThroughSendsTheSolverNoTransferAtAll() public {
        Solution memory s = _nettedSolution();
        s.intents[0].minBuyAmount = 0.99e18;
        s.intents[1].minBuyAmount = 198e6;
        s.executions[1].executedBuy = 200e6 - 5000;
        s.baselineQuotes[0] = 1e18 - 0.0001e18;
        s.baselineQuotes[1] = 200e6 - 5000;
        _submitAt(s, 0.02e18);

        vm.warp(BATCH_ID + 20);
        vm.recordLogs();
        settlement.finalize(BATCH_ID, s);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(_transfersTo(logs, address(usdg), solver), 0, "no fee, and no empty transfer either");
        assertEq(usdg.balanceOf(treasury), 5000, "the wedge went to the treasury whole");
        assertEq(usdg.balanceOf(solver), 0);
    }

    /// The two fee numbers in the batch event are dollars, and an indexer reading
    /// them is the only way anyone outside sees what a settlement cost. They get
    /// asserted to the unit here because nothing else asserts them at all.
    function test_theBatchEventCarriesBothFeesInDollars() public {
        Solution memory s = _nettedSolution();
        s.intents[0].minBuyAmount = 0.99e18;
        s.intents[1].minBuyAmount = 198e6;
        s.executions[0].executedBuy = 1e18 - 0.0003e18;
        s.executions[1].executedBuy = 200e6 - 0.06e6;

        uint256 savings =
            ((1e18 - 0.0003e18 - 0.99e18) * 200e18) / 1e18 + ((200e6 - 0.06e6 - 198e6) * 1e30) / 1e18;
        _submitAt(s, savings);

        vm.warp(BATCH_ID + 20);
        vm.expectEmit(true, true, true, true);
        emit ISettlement.IntentSettled(
            BATCH_ID,
            alice,
            hasher.hashOf(s.intents[0]),
            address(usdg),
            address(nvda),
            200e6,
            1e18 - 0.0003e18,
            0.99e18,
            1.94e18
        );
        vm.expectEmit(true, true, true, true);
        emit ISettlement.IntentSettled(
            BATCH_ID,
            bob,
            hasher.hashOf(s.intents[1]),
            address(nvda),
            address(usdg),
            1e18,
            200e6 - 0.06e6,
            198e6,
            1.94e18
        );
        vm.expectEmit(true, true, true, true);
        emit ISettlement.BatchSettled(BATCH_ID, solver, 3, 2, 400e18, 0, 3.88e18, 0.09e18, 0.03e18);
        settlement.finalize(BATCH_ID, s);
    }

    /// Nothing netted, everything routed. The pair is what measures whether the
    /// network effect is working, so it has to be derived rather than claimed.
    function test_aFullyRoutedBatchReportsNoNetting() public {
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
        s.baselineQuotes[0] = 1e18;
        s.solver = solver;
        _submitAt(s, 0);

        vm.warp(BATCH_ID + 20);
        vm.expectEmit(true, true, true, true);
        emit ISettlement.BatchSettled(BATCH_ID, solver, 3, 1, 0, 200e18, 0, 0, 0);
        settlement.finalize(BATCH_ID, s);
    }

    function test_aBatchExactlyOnTheCapIsAllowedThrough() public {
        vm.prank(governor);
        settlement.setExposureCaps(400e18, 50_000e18, 200_000e18);

        Solution memory s = _submit(_nettedSolution());
        vm.warp(BATCH_ID + 20);
        settlement.finalize(BATCH_ID, s);
        assertEq(nvda.balanceOf(alice), 1e18, "four hundred dollars against a four hundred dollar cap");
    }

    function test_theGlobalDailyTotalAddsUpAcrossBatchesAndStopsOnTheCap() public {
        vm.prank(governor);
        settlement.setExposureCaps(5000e18, 50_000e18, 700e18);

        Solution memory first = _submit(_nettedSolution());
        vm.warp(BATCH_ID + 20);
        settlement.finalize(BATCH_ID, first);

        Solution memory secondBatch = _laterSameDayBatch();
        vm.warp(secondBatch.batchId + 20);
        vm.expectRevert(
            abi.encodeWithSelector(
                ISettlement.ExposureCapExceeded.selector, bytes32("global"), 800e18, 700e18
            )
        );
        settlement.finalize(secondBatch.batchId, secondBatch);
    }

    function test_theGlobalDailyTotalMayLandExactlyOnTheCap() public {
        vm.prank(governor);
        settlement.setExposureCaps(5000e18, 50_000e18, 800e18);

        Solution memory first = _submit(_nettedSolution());
        vm.warp(BATCH_ID + 20);
        settlement.finalize(BATCH_ID, first);

        Solution memory secondBatch = _laterSameDayBatch();
        vm.warp(secondBatch.batchId + 20);
        settlement.finalize(secondBatch.batchId, secondBatch);
        assertEq(nvda.balanceOf(alice), 2e18, "eight hundred dollars against an eight hundred dollar cap");
    }

    function test_aTokenDayMayLandExactlyOnItsCap() public {
        vm.prank(governor);
        settlement.setExposureCaps(5000e18, 400e18, 200_000e18);

        Solution memory first = _submit(_nettedSolution());
        vm.warp(BATCH_ID + 20);
        settlement.finalize(BATCH_ID, first);

        Solution memory secondBatch = _laterSameDayBatch();
        vm.warp(secondBatch.batchId + 20);
        settlement.finalize(secondBatch.batchId, secondBatch);
        assertEq(usdg.balanceOf(bob), 400e6, "two hundred dollars a batch against a four hundred cap");
    }

    /// Saturday halves every cap. A wider price band and an unchanged cap would
    /// raise the worst case loss exactly when the price is least certain.
    function test_theWeekendHalvesTheBatchCap() public {
        uint64 saturday = 1_773_495_000;
        _frozenSessionRates();
        vm.prank(governor);
        settlement.setExposureCaps(798e18, 50_000e18, 200_000e18);

        Solution memory s = _nettedSolution();
        s.batchId = saturday;
        _submitAt(s, 0.01e18 * 200 + 2e18);

        vm.warp(saturday + 20);
        vm.expectRevert(
            abi.encodeWithSelector(ISettlement.ExposureCapExceeded.selector, bytes32("batch"), 400e18, 399e18)
        );
        settlement.finalize(saturday, s);
    }

    /// Good Friday, 3 April 2026. A holiday is halved for the same reason a
    /// weekend is, and the two are separate branches of the same test.
    function test_aHolidayHalvesTheBatchCap() public {
        uint64 goodFriday = 1_775_223_000;
        _frozenSessionRates();
        vm.prank(governor);
        settlement.setExposureCaps(798e18, 50_000e18, 200_000e18);

        Solution memory s = _nettedSolution();
        s.batchId = goodFriday;
        _submitAt(s, 0.01e18 * 200 + 2e18);

        vm.warp(goodFriday + 20);
        vm.expectRevert(
            abi.encodeWithSelector(ISettlement.ExposureCapExceeded.selector, bytes32("batch"), 400e18, 399e18)
        );
        settlement.finalize(goodFriday, s);
    }

    /// A solution whose intent names a token the solution never listed cannot be
    /// priced at all, so it is refused rather than priced at whatever sits one slot
    /// past the end of the array.
    function test_aSolutionNamingATokenItNeverListedIsRefused() public {
        MockERC20 aapl = new MockERC20("Apple", "AAPL", 18);
        vm.prank(governor);
        settlement.setTokenAllowed(address(aapl), true);

        Solution memory s = _nettedSolution();
        s.intents[0].sellToken = address(aapl);
        s.claimedSavings = 0;

        vm.warp(BATCH_ID + 1);
        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(ISettlement.TokenNotAllowed.selector, address(aapl)));
        settlement.submitSolution(s);
    }

    /// Half the flow crossed inside the batch and half of it went to the venue.
    /// The netted number is the difference between the two, so a batch that routes
    /// everything is not the only shape that has to come out right.
    function test_aPartlyRoutedBatchReportsTheRestAsNetted() public {
        Solution memory s;
        s.batchId = BATCH_ID;
        s.intents = new Intent[](2);
        s.intents[0] = _intent(alice, address(usdg), address(nvda), 200e6, 0.99e18, 1);
        s.intents[1] = _intent(bob, address(nvda), address(usdg), 0.5e18, 100e6, 2);
        s.signatures = new bytes[](2);
        s.tokens = new address[](2);
        s.tokens[0] = address(usdg);
        s.tokens[1] = address(nvda);
        s.prices = new uint256[](2);
        s.prices[0] = 1e30;
        s.prices[1] = 200e18;
        s.executions = new Execution[](2);
        s.executions[0] = Execution({intentIndex: 0, executedSell: 200e6, executedBuy: 1e18});
        s.executions[1] = Execution({intentIndex: 1, executedSell: 0.5e18, executedBuy: 100e6});
        s.venueCalls = new VenueCall[](1);
        s.venueCalls[0] = VenueCall({
            adapter: address(adapter),
            tokenIn: address(usdg),
            tokenOut: address(nvda),
            amountIn: 100e6,
            minOut: 0.5e18
        });
        s.baselineQuotes = new uint256[](2);
        s.baselineQuotes[0] = 1e18;
        s.baselineQuotes[1] = 100e6;
        s.solver = solver;
        _submitAt(s, 0);

        vm.warp(BATCH_ID + 20);
        vm.expectEmit(true, true, true, true);
        emit ISettlement.BatchSettled(BATCH_ID, solver, 3, 2, 200e18, 100e18, 0, 0, 0);
        settlement.finalize(BATCH_ID, s);
    }

    /// The global daily total is the one cap that is not keyed by day, so it is the
    /// one that has to be cleared by hand when the day turns over. A total that is
    /// never cleared is a lifetime quota on an immutable contract.
    function test_theGlobalDailyTotalStartsOverOnTheNextDay() public {
        vm.prank(governor);
        settlement.setExposureCaps(5000e18, 50_000e18, 700e18);

        Solution memory first = _submit(_nettedSolution());
        vm.warp(BATCH_ID + 20);
        settlement.finalize(BATCH_ID, first);

        uint64 nextDay = BATCH_ID + 1 days;
        usdg.mint(alice, 200e6);
        nvda.mint(bob, 1e18);

        vm.warp(nextDay - 60);
        usdgFeed.push(1e8, uint64(block.timestamp));
        nvdaFeed.push(200e8, uint64(block.timestamp));

        Solution memory secondDay = _nettedSolution();
        secondDay.batchId = nextDay;
        secondDay.intents[0].nonce = 21;
        secondDay.intents[1].nonce = 22;
        _submitAt(secondDay, 0.01e18 * 200 + 2e18);

        vm.warp(nextDay + 20);
        settlement.finalize(nextDay, secondDay);
        assertEq(nvda.balanceOf(alice), 2e18, "eight hundred dollars, but over two days rather than one");
    }

    /// @dev A second batch on the same day, already submitted, ready to finalize.
    function _laterSameDayBatch() internal returns (Solution memory s) {
        uint64 later = BATCH_ID + 600;
        usdg.mint(alice, 200e6);
        nvda.mint(bob, 1e18);

        vm.warp(later - 60);
        usdgFeed.push(1e8, uint64(block.timestamp));
        nvdaFeed.push(200e8, uint64(block.timestamp));

        s = _nettedSolution();
        s.batchId = later;
        s.intents[0].nonce = 11;
        s.intents[1].nonce = 12;
        _submitAt(s, 0.01e18 * 200 + 2e18);
    }

    /// @dev Weekends and holidays freeze the feeds, so the oracle answers from the
    /// pool TWAP instead. The venue rates in the fixture are raw swap rates, and
    /// this is the same pair expressed the way a price feed expresses it.
    /// Only the oracle side. Touching the quote rates here would move the venue
    /// baseline as well, and these tests are about the cap, not about the venue.
    function _frozenSessionRates() internal {
        adapter.setTwapRate(address(usdg), address(nvda), 1e18);
        adapter.setTwapRate(address(nvda), address(usdg), 200e18);
    }
}
