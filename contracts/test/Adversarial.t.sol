// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Guarded} from "../src/Guarded.sol";
import {Settlement} from "../src/Settlement.sol";
import {ISettlement} from "../src/interfaces/ISettlement.sol";
import {ISessionManager} from "../src/interfaces/ISessionManager.sol";
import {Execution, Intent, Session, Solution, VenueCall} from "../src/types/Types.sol";
import {IAuctionHouse} from "../src/interfaces/IAuctionHouse.sol";
import {IntentKind, SessionMask} from "../src/types/Types.sol";
import {Vm} from "forge-std/Vm.sol";
import {AuctionFixture} from "./fixtures/AuctionFixture.sol";
import {SettlementFixture} from "./fixtures/SettlementFixture.sol";
import {FeeOnTransferERC20} from "./mocks/FeeOnTransferERC20.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";
import {PausableERC20} from "./mocks/PausableERC20.sol";
import {ReentrantAdapter} from "./mocks/ReentrantAdapter.sol";

/// @notice The settlement half of the fifteen scenarios in rencana-uji.md section
/// 7. Every test is named for its row so the table and the suite can be read
/// against each other without guessing. The auction rows live in
/// AdversarialAuctionTest and the mandate row lives in AgentMandate.t.sol.
contract AdversarialSettlementTest is SettlementFixture {
    address internal constant FEE_TOKEN_SELLER = address(0xC0FFEE);

    /// A1. The claim is checked against a recomputation before anything is stored,
    /// so an inflated number never becomes the best solution.
    function test_A1_solverClaimingSavingsItDidNotProduce() public {
        Solution memory s = _nettedSolution();
        s.claimedSavings = 40e18;

        vm.warp(BATCH_ID + 1);
        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(ISettlement.SavingsMismatch.selector, 40e18, 4e18));
        settlement.submitSolution(s);

        (bytes32 hash,,) = settlement.bestSolution(BATCH_ID);
        assertEq(hash, bytes32(0), "a rejected claim leaves no winner behind");
    }

    /// A2. Winning and then sitting on the batch is griefing, so anyone can retire
    /// it once the deadline passes and the registry hears about the failure.
    function test_A2_winnerNeverFinalizes() public {
        _submit(_nettedSolution());

        vm.warp(BATCH_ID + settlement.SOLUTION_WINDOW() + settlement.FINALIZE_DEADLINE() + 1);
        vm.prank(address(0xDEAD));
        settlement.expireBatch(BATCH_ID);

        assertTrue(settlement.finalized(BATCH_ID), "the batch is retired, not stuck");
        assertEq(registry.failedFinalizes(), 1, "the winner is reported");
        assertEq(usdg.balanceOf(alice), 1000e6, "no intent was ever collected");
        assertEq(nvda.balanceOf(bob), 10e18);
    }

    /// A3. An adapter reaches the allowlist through a timelock, so the question is
    /// what a mistake at that gate can do from inside a batch. It can do nothing,
    /// because finalize holds the guard for the whole call.
    function test_A3_maliciousAdapterAttemptsReentrancy() public {
        ReentrantAdapter rogue = new ReentrantAdapter();
        rogue.setRate(5e27);
        vm.prank(governor);
        settlement.setAdapterAllowed(address(rogue), true);

        Solution memory s = _routedThrough(address(rogue));

        vm.warp(BATCH_ID + 1);
        vm.prank(solver);
        settlement.submitSolution(s);

        rogue.armFor(address(settlement), abi.encodeCall(ISettlement.finalize, (BATCH_ID, s)));

        vm.warp(BATCH_ID + 20);
        settlement.finalize(BATCH_ID, s);

        assertTrue(rogue.fired(), "the callback was attempted");
        assertFalse(rogue.reentered(), "and it failed");
        assertEq(nvda.balanceOf(alice), 1e18, "the honest path still delivered");
        assertEq(usdg.balanceOf(address(settlement)), 0, "nothing was left behind");
    }

    /// A4. A brief 500 bps push shows up as disagreement between the feed and the
    /// TWAP. Detection is onchain, the reaction is a governor call, and what the
    /// reaction buys is a tighter band and a slower batch.
    function test_A4_oracleManipulatedForOneBlock() public {
        // The fixture quotes the venue in raw USDG units. Disagreement is measured
        // against the WAD price, so the TWAP has to speak the same convention.
        adapter.setTwapRate(address(nvda), address(usdg), 200e18);

        (,, bool agreeBefore) = oracle.dualCheck(address(nvda));
        assertTrue(agreeBefore, "the two sources start together");

        nvdaFeed.push(210e8, block.timestamp); // 500 bps above the TWAP
        (uint256 feed, uint256 twapPrice, bool agree) = oracle.dualCheck(address(nvda));
        assertEq(feed, 210e18);
        assertEq(twapPrice, 200e18);
        assertFalse(agree, "500 bps is past the 50 bps open session limit");

        vm.prank(governor);
        sessions.setProtective(address(nvda), "oracle disagreement");

        assertEq(uint8(sessions.tokenSession(address(nvda))), uint8(Session.PROTECTIVE));
        assertEq(sessions.maxDeviationBps(Session.PROTECTIVE), 20, "the band tightens");
        assertEq(sessions.batchDuration(Session.PROTECTIVE), 180, "and the batch slows down");
    }

    /// A5. A stale feed is not a price. The batch is refused at submission, before
    /// a single intent is collected.
    function test_A5_bothOraclesStaleDuringOpen() public {
        Solution memory s = _nettedSolution();
        s.claimedSavings = 4e18;

        vm.warp(BATCH_ID + 1 + 7000); // past the 6000 second open session limit
        (,, bool healthy) = oracle.refPrice(address(nvda));
        assertFalse(healthy);

        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(ISettlement.SolutionWindowClosed.selector, BATCH_ID));
        settlement.submitSolution(s);

        uint64 later = BATCH_ID + 7000;
        Solution memory fresh = _nettedSolution();
        fresh.batchId = later;
        fresh.claimedSavings = 4e18;
        vm.warp(later + 1);
        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(Settlement.OracleUnhealthy.selector, address(usdg)));
        settlement.submitSolution(fresh);
    }

    /// A8. The multiplier is hashed at submission and read again at settlement.
    /// Three of the four mainnet moves so far landed inside an open session, so
    /// this is the ordinary case rather than the exotic one.
    function test_A8_uiMultiplierMovesBetweenSubmitAndFinalize() public {
        Solution memory s = _submit(_nettedSolution());

        nvda.setUiMultiplier(1.02e18);

        vm.warp(BATCH_ID + 20);
        vm.expectRevert(
            abi.encodeWithSelector(
                ISettlement.MultiplierChanged.selector,
                address(usdg),
                uint256(_multipliers(1e18, 1e18)),
                uint256(_multipliers(1e18, 1.02e18))
            )
        );
        settlement.finalize(BATCH_ID, s);

        assertFalse(settlement.finalized(BATCH_ID), "and the batch stays open to nobody");
        assertEq(usdg.balanceOf(alice), 1000e6, "no funds moved");
    }

    /// A9, first half. A token that keeps one percent of every transfer cannot
    /// clear at all, because the uniform price band is three basis points wide and
    /// the shortfall is a hundred. The batch reverts whole.
    function test_A9_feeOnTransferTokenAboveTheBandCannotClear() public {
        FeeOnTransferERC20 fot = _allowlistFeeToken(100);
        Solution memory s =
            _feeTokenSolution(address(fot), [uint256(0.9998e18), 199_960_000, 0.9988e18, 199_760_000]);

        vm.warp(BATCH_ID + 1);
        vm.prank(solver);
        settlement.submitSolution(s);

        vm.warp(BATCH_ID + 20);
        vm.expectRevert();
        settlement.finalize(BATCH_ID, s);

        assertEq(fot.balanceOf(address(settlement)), 0, "nothing is stranded in the contract");
        assertEq(usdg.balanceOf(alice), 1000e6);
    }

    /// A9, second half. Under the band the batch settles, and the fee the protocol
    /// keeps is read from its own balance delta rather than from the amounts the
    /// solver wrote down. The token that shrinks in flight leaves no residue.
    function test_A9_feeOnTransferTokenWithinTheBandKeepsAccountingHonest() public {
        FeeOnTransferERC20 fot = _allowlistFeeToken(2);
        Solution memory s =
            _feeTokenSolution(address(fot), [uint256(0.9998e18), 199_960_000, 0.9988e18, 199_760_000]);

        vm.warp(BATCH_ID + 1);
        vm.prank(solver);
        settlement.submitSolution(s);

        vm.warp(BATCH_ID + 20);
        settlement.finalize(BATCH_ID, s);

        assertEq(fot.balanceOf(address(settlement)), 0, "no phantom balance is kept");
        assertEq(fot.balanceOf(treasury), 0, "and none is swept as a fee either");
        assertEq(usdg.balanceOf(FEE_TOKEN_SELLER), 199_960_000, "the seller was paid the quote side in full");
        // The forty thousand units withheld on the quote side split three to one.
        assertEq(usdg.balanceOf(solver), 30_000, "solver share");
        assertEq(usdg.balanceOf(treasury), 10_000, "protocol share");
        assertEq(usdg.balanceOf(address(settlement)), 0);
    }

    /// A10. P0-1 proved there is no KYC gate on transfer today, but the token is a
    /// beacon proxy and an issuer pause is one upgrade away. The batch has to fail
    /// whole rather than halfway.
    function test_A10_stockTokenTransferRevertsDuringFinalize() public {
        PausableERC20 stock = new PausableERC20("Nvidia", "RHNVDA", 18);
        _allowlistToken(address(stock), FEE_TOKEN_SELLER, 10e18);

        Solution memory s =
            _feeTokenSolution(address(stock), [uint256(1e18), 199_960_000, 0.999e18, 199_760_000]);

        vm.warp(BATCH_ID + 1);
        vm.prank(solver);
        settlement.submitSolution(s);

        stock.setPaused(true);

        vm.warp(BATCH_ID + 20);
        vm.expectRevert(PausableERC20.TransferPaused.selector);
        settlement.finalize(BATCH_ID, s);

        assertEq(stock.balanceOf(FEE_TOKEN_SELLER), 10e18, "the seller keeps everything");
        assertEq(usdg.balanceOf(alice), 1000e6, "the buyer keeps everything");
        assertEq(stock.balanceOf(address(settlement)), 0);
        assertEq(usdg.balanceOf(address(settlement)), 0);
    }

    /// A11. The stop lands between the winning solution and its settlement. The
    /// batch cannot finalize while paused, so it is retired instead, and nothing
    /// any user signed was ever collected.
    ///
    /// The auction half of this row, where escrow is already inside the contract
    /// when the protocol stops, is in Guardian.t.sol.
    function test_A11_guardianPausesMidSolutionWindow() public {
        Solution memory s = _submit(_nettedSolution());

        vm.prank(guardian);
        settlement.pause();

        vm.warp(BATCH_ID + 20);
        vm.expectRevert(abi.encodeWithSelector(Guarded.ProtocolPaused.selector, settlement.pausedUntil()));
        settlement.finalize(BATCH_ID, s);

        vm.warp(BATCH_ID + settlement.SOLUTION_WINDOW() + settlement.FINALIZE_DEADLINE() + 1);
        settlement.expireBatch(BATCH_ID);

        assertTrue(settlement.finalized(BATCH_ID), "the paused batch could not be retired");
        assertEq(usdg.balanceOf(alice), 1000e6, "an intent was collected while paused");
        assertEq(nvda.balanceOf(bob), 10e18);
        assertEq(usdg.balanceOf(address(settlement)), 0, "the contract kept something");
        assertTrue(settlement.isPaused(), "the pause lapsed and the test proved nothing");
    }

    /// A12. The cap is a number the timelock owns, and a batch above it cannot
    /// settle. The whole call reverts, so no transfer inside it survives.
    function test_A12_exposureCapExceeded() public {
        vm.prank(governor);
        settlement.setExposureCaps(100e18, 50_000e18, 200_000e18);

        Solution memory s = _submit(_nettedSolution());

        vm.warp(BATCH_ID + 20);
        vm.expectRevert(
            abi.encodeWithSelector(ISettlement.ExposureCapExceeded.selector, bytes32("batch"), 400e18, 100e18)
        );
        settlement.finalize(BATCH_ID, s);

        assertEq(usdg.balanceOf(alice), 1000e6, "the revert took the transfers with it");
        assertEq(nvda.balanceOf(bob), 10e18);
        assertFalse(settlement.finalized(BATCH_ID));
    }

    /// A13. If every solver agrees to hand back the venue price, there is no
    /// surplus to share and the protocol takes nothing. Pass through is the floor
    /// of the mechanism, not a failure of it.
    function test_A13_everySolverCollusesOnAWorthlessSolution() public {
        Solution memory s = _nettedSolution();
        s.baselineQuotes[0] = 1e18; // exactly what the user got
        s.baselineQuotes[1] = 200e6;
        s.claimedSavings = 0;

        vm.warp(BATCH_ID + 1);
        vm.prank(solver);
        settlement.submitSolution(s);

        vm.warp(BATCH_ID + 20);
        vm.expectEmit(true, false, false, true, address(settlement));
        emit ISettlement.BatchPassthrough(BATCH_ID, 2, "savings below threshold");
        settlement.finalize(BATCH_ID, s);

        assertEq(usdg.balanceOf(solver), 0, "no fee on a worthless solution");
        assertEq(nvda.balanceOf(solver), 0);
        assertEq(usdg.balanceOf(treasury), 0);
        assertEq(nvda.balanceOf(alice), 1e18, "the users still got their fills");
        assertEq(usdg.balanceOf(bob), 200e6);
    }

    /// A16. Understating the baseline is the one lie the verifier used to accept,
    /// because it only ever checked that the fill beat the claim. Savings picks the
    /// winner and sets the fee cap, so the lie paid twice. parameter.md 4C.
    function test_A16_solverUnderstatesTheBaselineToInflateSavings() public {
        Solution memory honest = _nettedSolution();
        honest.claimedSavings = 4e18;
        vm.warp(BATCH_ID + 1);
        vm.prank(solver);
        settlement.submitSolution(honest);

        Solution memory shaded = _nettedSolution();
        shaded.baselineQuotes[0] = 0;
        shaded.baselineQuotes[1] = 0;
        shaded.claimedSavings = (1e18 * 200e18) / 1e18 + (200e6 * 1e30) / 1e18;

        vm.prank(solver);
        vm.expectRevert(
            abi.encodeWithSelector(
                ISettlement.BaselineBelowVenue.selector, address(usdg), address(nvda), 0, 0.99e18
            )
        );
        settlement.submitSolution(shaded);

        (, uint256 savings, address winner) = settlement.bestSolution(BATCH_ID);
        assertEq(savings, 4e18, "the honest solution is still the one to beat");
        assertEq(winner, solver);
    }

    /// A14. A batch whose identifier sits on a session boundary is refused rather
    /// than assigned to whichever side the sequencer clock happened to pick.
    function test_A14_batchLandsExactlyOnASessionBoundary() public {
        assertTrue(sessions.inGuardBand(DAY_OPEN), "the bell is inside the band");

        vm.expectRevert(abi.encodeWithSelector(Settlement.BatchInGuardBand.selector, DAY_OPEN));
        settlement.batchWindow(DAY_OPEN);

        uint64 clear = DAY_OPEN + sessions.GUARD_BAND() + 10;
        assertFalse(sessions.inGuardBand(clear));
        (uint64 start, uint64 end, uint64 solveEnd) = settlement.batchWindow(clear);
        assertEq(end, clear);
        assertEq(end - start, sessions.batchDuration(Session.OPEN), "and it runs at open session pace");
        assertEq(solveEnd, clear + settlement.SOLUTION_WINDOW());
    }

    function _multipliers(uint256 quote, uint256 base) internal pure returns (bytes32) {
        uint256[] memory values = new uint256[](2);
        values[0] = quote;
        values[1] = base;
        return keccak256(abi.encode(values));
    }

    function _routedThrough(address venue) internal view returns (Solution memory s) {
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
            adapter: venue, tokenIn: address(usdg), tokenOut: address(nvda), amountIn: 200e6, minOut: 1e18
        });
        s.baselineQuotes = new uint256[](1);
        s.baselineQuotes[0] = 1e18;
        s.claimedSavings = 0;
        s.solver = solver;
    }

    function _allowlistFeeToken(uint16 feeBps) internal returns (FeeOnTransferERC20 token) {
        token = new FeeOnTransferERC20("Nvidia", "RHNVDA", 18, feeBps);
        _allowlistToken(address(token), FEE_TOKEN_SELLER, 10e18);
    }

    function _allowlistToken(address token, address holder, uint256 amount) internal {
        MockAggregator feed = new MockAggregator(8, "RHNVDA / USD");
        feed.push(200e8, DAY_OPEN);

        vm.startPrank(governor);
        oracle.setFeed(token, address(feed), 6000, 20_000);
        oracle.setTwapSource(token, address(adapter), address(usdg), 1800);
        settlement.setTokenAllowed(token, true);
        vm.stopPrank();

        adapter.setRate(token, address(usdg), 200e6);
        adapter.setRate(address(usdg), token, 5e27);

        (bool ok,) = token.call(abi.encodeWithSignature("mint(address,uint256)", holder, amount));
        require(ok, "mint");
        vm.prank(holder);
        IERC20(token).approve(address(permit2), type(uint256).max);
    }

    /// Alice buys the base token with 200 USDG, the holder sells one unit of it.
    /// The executed amounts sit just inside the three basis point band so the
    /// protocol withholds a real fee on the quote side. The four amounts travel as
    /// one array because the helper is compiled without the optimizer under the
    /// coverage gate, and five separate locals do not fit the stack there.
    function _feeTokenSolution(address token, uint256[4] memory amounts)
        internal
        view
        returns (Solution memory s)
    {
        s.batchId = BATCH_ID;
        s.intents = new Intent[](2);
        s.intents[0] = _intent(alice, address(usdg), token, 200e6, amounts[0], 1);
        s.intents[1] = _intent(FEE_TOKEN_SELLER, token, address(usdg), 1e18, amounts[1], 2);

        s.signatures = new bytes[](2);
        s.tokens = new address[](2);
        s.tokens[0] = address(usdg);
        s.tokens[1] = token;
        s.prices = new uint256[](2);
        s.prices[0] = 1e30;
        s.prices[1] = 200e18;

        s.executions = new Execution[](2);
        s.executions[0] = Execution({intentIndex: 0, executedSell: 200e6, executedBuy: amounts[0]});
        s.executions[1] = Execution({intentIndex: 1, executedSell: 1e18, executedBuy: amounts[1]});

        s.venueCalls = new VenueCall[](0);
        s.baselineQuotes = new uint256[](2);
        s.baselineQuotes[0] = amounts[2];
        s.baselineQuotes[1] = amounts[3];
        s.solver = solver;
        s.claimedSavings = _savingsOf(amounts);
    }

    function _savingsOf(uint256[4] memory amounts) internal pure returns (uint256) {
        return ((amounts[0] - amounts[2]) * 200e18) / 1e18 + ((amounts[1] - amounts[3]) * 1e30) / 1e18;
    }
}

/// @notice The auction half of rencana-uji.md section 7. Both rows here turn on
/// the same idea, which is that an intent only counts once its funds have moved.
contract AdversarialAuctionTest is AuctionFixture {
    uint256 internal constant MALLORY_KEY = 0x3A110471;

    address internal mallory = vm.addr(MALLORY_KEY);
    address internal challenger = address(0xC0FFEE);

    /// A6. A large commitment moves the published indicative, which is the whole
    /// point of publishing it. What it cannot do is reach the cross, because freeze
    /// pulls every escrow and drops whatever does not arrive.
    function test_A6_phantomAuctionIntentShiftsTheIndicativeThenLeaves() public {
        _fund(mallory, MALLORY_KEY);

        _buyMoo(alice, 20_000e6, 1);
        _sellMoo(bob, 100e18, 2);
        bytes32 phantom =
            _commit(_intent(mallory, true, 80_000e6, 0, IntentKind.MOO, 0, SessionMask.AUCTION_OPEN, 3));

        uint64 id = house.auctionIdOf(address(nvda), DAY, kindOpen);
        house.openAuction(address(nvda), kindOpen);

        vm.recordLogs();
        house.publishIndicative(id);
        (, int256 imbalanceWithPhantom,) = _lastIndicative();

        // Mallory never intended to pay. The allowance goes before the freeze.
        vm.prank(mallory);
        usdg.approve(address(permit2), 0);

        vm.warp(FREEZE_AT);
        _pushFeeds(200e8, uint64(block.timestamp));

        vm.expectEmit(true, true, false, true, address(house));
        emit IAuctionHouse.CommitmentDropped(id, phantom, "escrow pull failed");
        house.freeze(id);

        assertTrue(house.commitment(phantom).cancelled, "the phantom is out of the book");
        assertFalse(house.commitment(phantom).escrowed);

        vm.recordLogs();
        house.publishIndicative(id);
        (, int256 imbalanceFrozen,) = _lastIndicative();

        assertGt(imbalanceWithPhantom, imbalanceFrozen, "the phantom had moved the indicative");
        (,,, uint256 escrowedValue,,) = house.auctionResult(id);
        assertEq(escrowedValue, 40_000e6, "and it contributed nothing to the frozen book");
    }

    /// A6, the other half. Cancelling before the freeze is allowed and costs
    /// nothing, which is exactly why the indicative alone is never a commitment.
    function test_A6_cancellingBeforeFreezeLeavesNothingBehind() public {
        _fund(mallory, MALLORY_KEY);
        _buyMoo(alice, 20_000e6, 1);
        _sellMoo(bob, 100e18, 2);
        bytes32 phantom =
            _commit(_intent(mallory, true, 80_000e6, 0, IntentKind.MOO, 0, SessionMask.AUCTION_OPEN, 3));

        uint64 id = house.auctionIdOf(address(nvda), DAY, kindOpen);
        house.openAuction(address(nvda), kindOpen);

        vm.prank(mallory);
        house.cancelBeforeFreeze(phantom);

        vm.warp(FREEZE_AT);
        _pushFeeds(200e8, uint64(block.timestamp));
        house.freeze(id);

        (,,, uint256 escrowedValue,,) = house.auctionResult(id);
        assertEq(escrowedValue, 40_000e6, "the cancelled side never escrowed");
        assertEq(usdg.balanceOf(mallory), 100_000e6, "and never paid anything either");
    }

    /// A7. A challenge is not free speech. Naming a price the hierarchy rates no
    /// better than the standing one costs the challenger the whole bond, and the
    /// cross stands.
    function test_A7_challengerNamesAWorsePrice() public {
        uint64 id = _crossedAt(200e6);

        usdg.mint(challenger, 10_000e6);
        vm.prank(challenger);
        usdg.approve(address(house), type(uint256).max);

        uint256 bondAmount = house.bond();
        uint256 treasuryBefore = usdg.balanceOf(treasury);

        vm.expectEmit(true, true, false, true, address(house));
        emit IAuctionHouse.CrossChallenged(id, challenger, 200e6, 201e6, false);
        vm.prank(challenger);
        house.challenge(id, 201e6);

        assertEq(usdg.balanceOf(challenger), 10_000e6 - bondAmount, "the bond is gone");
        assertEq(usdg.balanceOf(treasury), treasuryBefore + bondAmount / 2, "half of it to the treasury");

        (, uint256 clearing,,,, address winner) = house.auctionResult(id);
        assertEq(clearing, 200e6, "the cross stands untouched");
        assertEq(winner, solver, "and so does its solver");

        (,, uint8 phase,,,) = house.auctionState(id);
        assertEq(phase, 3, "the auction is still CROSSED");
    }

    function _crossedAt(uint256 price) internal returns (uint64 id) {
        _buyMoo(alice, 20_000e6, 1);
        _sellMoo(bob, 100e18, 2);
        id = _openAndFreeze();
        _passOpeningReference(200e8);

        Execution[] memory e = new Execution[](2);
        e[0] = _exec(0, 20_000e6, 100e18);
        e[1] = _exec(1, 100e18, 20_000e6);
        vm.prank(solver);
        house.submitCross(id, price, e);
    }

    function _lastIndicative() internal returns (uint256 price, int256 imbalance, uint256 matched) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 k = logs.length; k > 0; --k) {
            if (logs[k - 1].topics[0] == IAuctionHouse.IndicativePublished.selector) {
                return abi.decode(logs[k - 1].data, (uint256, int256, uint256));
            }
        }
        revert("no indicative published");
    }
}
