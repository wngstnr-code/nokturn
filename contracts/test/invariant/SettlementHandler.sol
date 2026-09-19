// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PriceOracle} from "../../src/PriceOracle.sol";
import {SessionManager} from "../../src/SessionManager.sol";
import {Settlement} from "../../src/Settlement.sol";
import {Execution, Intent, Session, SessionMask, Solution, VenueCall} from "../../src/types/Types.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockPermit2} from "../mocks/MockPermit2.sol";
import {MockSwapAdapter} from "../mocks/MockSwapAdapter.sol";

/// @notice Drives the settlement core for the invariant runs. The honest actions
/// build solutions that should clear, and the dishonest ones build solutions that
/// must not, so a solver that lies is inside the search space rather than outside
/// it. rencana-uji.md section 2 asks for that split by name.
///
/// Every call records what actually happened into ghost state. The invariants read
/// the ghosts rather than the contract, because a contract that is wrong about its
/// own accounting would otherwise be asked to certify itself.
contract SettlementHandler is Test {
    struct Fill {
        uint64 batchId;
        address owner;
        address sellToken;
        address buyToken;
        uint256 sellAmount;
        uint256 minBuyAmount;
        uint256 executedSell;
        uint256 executedBuy;
        uint256 baselineQuote;
        uint256 sellPrice;
        uint256 buyPrice;
        uint256 nonce;
    }

    struct SettledBatch {
        uint64 id;
        uint256 savingsUsd;
        uint256 notionalUsd;
        uint256 solverFeeUsd;
        uint256 quotePrice;
        uint256 basePrice;
        uint256 quoteRef;
        uint256 baseRef;
        uint16 maxDevBps;
    }

    uint256 internal constant WAD = 1e18;
    uint16 internal constant BPS = 10_000;

    /// Two basis points of the base leg, which is inside the three the verifier
    /// allows. Anything at or above three is a dishonest action, not an honest one.
    uint16 internal constant HONEST_WEDGE_BPS = 2;

    Settlement public immutable settlement;
    SessionManager public immutable sessions;
    PriceOracle public immutable oracle;
    MockPermit2 public immutable permit2;
    MockSwapAdapter public immutable venue;
    MockERC20 public immutable quote;
    MockERC20 public immutable base;
    MockAggregator public immutable quoteFeed;
    MockAggregator public immutable baseFeed;
    address public immutable solver;
    address public immutable governor;
    address public immutable treasury;

    address[4] public actors;

    Fill[] internal fills;
    SettledBatch[] internal settledBatches;

    mapping(address => uint256) public nextNonce;
    mapping(bytes32 => bool) public nonceSettled;

    uint256 public dishonestAccepted;
    uint256 public duplicateNonces;
    uint256 public callsSubmitted;
    uint256 public callsFinalized;
    uint256 public callsExpired;

    uint256 internal solverValueBefore;

    constructor(
        Settlement settlement_,
        SessionManager sessions_,
        PriceOracle oracle_,
        MockPermit2 permit2_,
        MockSwapAdapter venue_,
        MockERC20 quote_,
        MockERC20 base_,
        MockAggregator quoteFeed_,
        MockAggregator baseFeed_,
        address solver_,
        address governor_,
        address treasury_
    ) {
        settlement = settlement_;
        sessions = sessions_;
        oracle = oracle_;
        permit2 = permit2_;
        venue = venue_;
        quote = quote_;
        base = base_;
        quoteFeed = quoteFeed_;
        baseFeed = baseFeed_;
        solver = solver_;
        governor = governor_;
        treasury = treasury_;

        actors[0] = address(0xA11CE);
        actors[1] = address(0xB0B);
        actors[2] = address(0xCA401);
        actors[3] = address(0xDA4E);
    }

    function fillCount() external view returns (uint256) {
        return fills.length;
    }

    function fillAt(uint256 index) external view returns (Fill memory) {
        return fills[index];
    }

    function settledCount() external view returns (uint256) {
        return settledBatches.length;
    }

    function settledAt(uint256 index) external view returns (SettledBatch memory) {
        return settledBatches[index];
    }

    /// @notice Signs a pair of opposing intents and settles them end to end. The
    /// pair nets against itself, which is the shape the protocol exists to produce.
    function actSettleBatch(uint256 seed) external {
        (Solution memory s, bool ok) = _buildPair(seed, HONEST_WEDGE_BPS, 0, false);
        if (!ok) return;

        if (!_submit(s, solver)) return;
        if (!_finalize(s)) return;
        _record(s);
    }

    /// @notice Settles a pair whose buy side is twice the sell side, so half of it
    /// nets and half has to be routed. The conservation check then has a nonzero
    /// venue delta to account for rather than a pair that cancels exactly.
    function actSettleWithVenue(uint256 seed) external {
        (Solution memory s, bool ok) = _buildPair(seed, HONEST_WEDGE_BPS, 0, true);
        if (!ok) return;

        if (!_submit(s, solver)) return;
        if (!_finalize(s)) return;
        _record(s);
    }

    /// @notice A solution that breaks one rule on purpose. None of these may ever
    /// reach finalize, and the counter is what the invariant reads.
    function actSubmitDishonest(uint256 seed) external {
        uint8 kind = uint8(bound(seed, 0, 6));
        (Solution memory s, bool ok) = _buildPair(seed >> 8, HONEST_WEDGE_BPS, kind, false);
        if (!ok) return;

        address who = kind == 6 ? actors[0] : solver;
        if (kind == 0) s.claimedSavings += 1e18;

        if (_submit(s, who) && _finalize(s)) {
            dishonestAccepted += 1;
            _record(s);
        }
    }

    /// @notice Rebuilds a batch on a nonce that already settled. Permit2 owns the
    /// bitmap, so this is the check that the settlement path cannot talk it out of
    /// refusing a replay.
    function actReuseNonce(uint256 seed) external {
        if (fills.length == 0) return;
        Fill memory f = fills[bound(seed, 0, fills.length - 1)];

        (Solution memory s, bool ok) = _buildPair(seed >> 8, HONEST_WEDGE_BPS, 0, false);
        if (!ok) return;
        s.intents[0].owner = f.owner;
        s.intents[0].receiver = f.owner;
        s.intents[0].nonce = f.nonce;

        if (_submit(s, solver) && _finalize(s)) {
            dishonestAccepted += 1;
            _record(s);
        }
    }

    /// @notice Leaves a batch with a winner and never finalizes it, then retires it
    /// once the deadline passes. No funds move on this path, which is the claim.
    function actExpireBatch(uint256 seed) external {
        (Solution memory s, bool ok) = _buildPair(seed, HONEST_WEDGE_BPS, 0, true);
        if (!ok) return;
        if (!_submit(s, solver)) return;

        vm.warp(s.batchId + settlement.SOLUTION_WINDOW() + settlement.FINALIZE_DEADLINE() + 1);
        try settlement.expireBatch(s.batchId) {
            callsExpired += 1;
        } catch {}
    }

    /// @notice Moves the clock. The jumps are small and frequent rather than
    /// uniform over a year, because the boundaries are where the session engine is
    /// interesting and a uniform jump lands on one roughly never.
    function actWarpTime(uint256 seed) external {
        uint64 now_ = uint64(vm.getBlockTimestamp());
        uint64 step = uint64(bound(seed, 1, 3600));

        // Half the time, land within a guard band of the next boundary instead.
        if (seed & 1 == 0) {
            uint64 next = sessions.nextTransition(now_);
            if (next > now_) {
                uint64 band = uint64(bound(seed >> 8, 0, 2 * sessions.GUARD_BAND()));
                uint64 target =
                    next + band > sessions.GUARD_BAND() ? next + band - sessions.GUARD_BAND() : next;
                if (target > now_) {
                    vm.warp(target);
                    return;
                }
            }
        }
        vm.warp(now_ + step);
    }

    /// @notice Pushes a feed round, sometimes far enough off the last one to take
    /// the token outside the price band and make every solution on it fail.
    function actOracleUpdate(uint256 seed) external {
        uint256 driftBps = bound(seed, 0, 900);
        bool up = seed & 1 == 0;
        int256 answer = int256(200e8);
        int256 delta = (answer * int256(driftBps)) / int256(uint256(BPS));
        baseFeed.push(up ? answer + delta : answer - delta, block.timestamp);
        quoteFeed.push(1e8, block.timestamp);
    }

    /// @notice Four allowlist tokens have already moved off 1e18 on mainnet and
    /// three of those moves landed inside OPEN, so a batch has to meet one.
    function actMultiplierChange(uint256 seed) external {
        uint256 m = bound(seed, 1e18, 2e18);
        base.setUiMultiplier(m);
    }

    function _buildPair(uint256 seed, uint16 wedgeBps, uint8 corruption, bool withVenue)
        internal
        returns (Solution memory s, bool ok)
    {
        uint64 batchId = _nextBatch();
        if (batchId == 0) return (s, false);

        uint256 qty = bound(seed, 10, 500) * 1e15;
        uint256 quoteAmount = (qty * 200) / 1e12;
        uint256 buyQty = withVenue ? qty * 2 : qty;
        uint256 buySpend = withVenue ? quoteAmount * 2 : quoteAmount;
        uint256 wedge = (buyQty * wedgeBps) / BPS;
        if (corruption == 4) wedge = (buyQty * 6) / BPS;

        address buyer = actors[bound(seed >> 16, 0, 1)];
        address seller = actors[bound(seed >> 24, 2, 3)];

        quote.mint(buyer, buySpend);
        base.mint(seller, qty);
        vm.prank(buyer);
        quote.approve(address(permit2), type(uint256).max);
        vm.prank(seller);
        base.approve(address(permit2), type(uint256).max);

        s.batchId = batchId;
        s.solver = solver;

        s.intents = new Intent[](2);
        s.intents[0] =
            _intent(buyer, address(quote), address(base), buySpend, (buyQty * 99) / 100, nextNonce[buyer]++);
        s.intents[1] = _intent(
            seller, address(base), address(quote), qty, (quoteAmount * 99) / 100, nextNonce[seller]++
        );
        s.signatures = new bytes[](2);

        s.tokens = new address[](2);
        s.tokens[0] = address(quote);
        s.tokens[1] = address(base);

        (uint256 quoteRef,,) = oracle.refPrice(address(quote));
        (uint256 baseRef,,) = oracle.refPrice(address(base));
        s.prices = new uint256[](2);
        s.prices[0] = (quoteRef * WAD) / (10 ** quote.decimals());
        s.prices[1] = (baseRef * WAD) / (10 ** base.decimals());
        if (corruption == 2) s.prices[1] = (s.prices[1] * 12_000) / BPS;

        uint256 buyerGets = buyQty - wedge;
        if (corruption == 1) buyerGets = (buyQty * 90) / 100;
        if (corruption == 3) buyerGets = buyQty + wedge;

        s.executions = new Execution[](2);
        s.executions[0] = Execution({intentIndex: 0, executedSell: buySpend, executedBuy: buyerGets});
        s.executions[1] = Execution({intentIndex: 1, executedSell: qty, executedBuy: quoteAmount});

        s.baselineQuotes = new uint256[](2);
        s.baselineQuotes[0] = (buyQty * 99) / 100;
        s.baselineQuotes[1] = (quoteAmount * 99) / 100;
        if (corruption == 5) s.baselineQuotes[0] = buyQty;

        if (withVenue) {
            s.venueCalls = new VenueCall[](1);
            s.venueCalls[0] = VenueCall({
                adapter: address(venue),
                tokenIn: address(quote),
                tokenOut: address(base),
                amountIn: quoteAmount,
                minOut: qty
            });
        } else {
            s.venueCalls = new VenueCall[](0);
        }

        s.claimedSavings = _savings(s);
        ok = true;
    }

    function _savings(Solution memory s) internal pure returns (uint256 total) {
        for (uint256 k = 0; k < s.executions.length; ++k) {
            Execution memory e = s.executions[k];
            if (e.executedBuy <= s.baselineQuotes[k]) continue;
            uint256 price = s.intents[e.intentIndex].buyToken == s.tokens[0] ? s.prices[0] : s.prices[1];
            total += ((e.executedBuy - s.baselineQuotes[k]) * price) / WAD;
        }
    }

    function _intent(
        address owner,
        address sellToken,
        address buyToken,
        uint256 sellAmount,
        uint256 minBuy,
        uint256 nonce
    ) internal pure returns (Intent memory i) {
        i = Intent({
            owner: owner,
            receiver: owner,
            sellToken: sellToken,
            buyToken: buyToken,
            sellAmount: sellAmount,
            minBuyAmount: minBuy,
            validAfter: 0,
            validUntil: type(uint32).max,
            flags: 0,
            kind: 0,
            maxDevFromRefBps: 0,
            allowedSessions: type(uint8).max,
            batchSpan: 1,
            nonce: nonce
        });
    }

    /// @dev The last aligned instant that is already behind us, so the collection
    /// window is closed and the solution window is open.
    function _nextBatch() internal returns (uint64 batchId) {
        uint64 now_ = uint64(vm.getBlockTimestamp());
        Session session = sessions.sessionAt(now_);
        uint32 duration = sessions.batchDuration(session);
        if (duration == 0) return 0;

        batchId = (now_ / duration) * duration;
        if (batchId <= duration) return 0;
        if (batchId == now_) batchId -= duration;
        if (sessions.sessionAt(batchId) != session) return 0;
        if (sessions.inGuardBand(batchId)) return 0;
        if (settlement.finalized(batchId)) return 0;

        vm.warp(batchId + 1);
        _refreshFeeds();
    }

    function _refreshFeeds() internal {
        quoteFeed.push(1e8, block.timestamp);
        baseFeed.push(200e8, block.timestamp);
    }

    function _submit(Solution memory s, address who) internal returns (bool) {
        vm.prank(who);
        try settlement.submitSolution(s) {
            callsSubmitted += 1;
            return true;
        } catch {
            return false;
        }
    }

    function _finalize(Solution memory s) internal returns (bool) {
        vm.warp(s.batchId + settlement.SOLUTION_WINDOW() + 1);
        (bytes32 hash,,) = settlement.bestSolution(s.batchId);
        if (hash != keccak256(abi.encode(s))) return false;

        solverValueBefore = _solverValue(s);

        try settlement.finalize(s.batchId, s) {
            callsFinalized += 1;
            return true;
        } catch {
            return false;
        }
    }

    function _record(Solution memory s) internal {
        uint256 solverAfter = _solverValue(s);
        uint256 solverFee = solverAfter > solverValueBefore ? solverAfter - solverValueBefore : 0;

        for (uint256 k = 0; k < s.executions.length; ++k) {
            Execution memory e = s.executions[k];
            Intent memory i = s.intents[e.intentIndex];

            bytes32 key = keccak256(abi.encode(i.owner, i.nonce));
            if (nonceSettled[key]) duplicateNonces += 1;
            nonceSettled[key] = true;

            bool sellIsQuote = i.sellToken == s.tokens[0];
            fills.push(
                Fill({
                    batchId: s.batchId,
                    owner: i.owner,
                    sellToken: i.sellToken,
                    buyToken: i.buyToken,
                    sellAmount: i.sellAmount,
                    minBuyAmount: i.minBuyAmount,
                    executedSell: e.executedSell,
                    executedBuy: e.executedBuy,
                    baselineQuote: s.baselineQuotes[k],
                    sellPrice: sellIsQuote ? s.prices[0] : s.prices[1],
                    buyPrice: sellIsQuote ? s.prices[1] : s.prices[0],
                    nonce: i.nonce
                })
            );
        }

        (uint256 quoteRef,,) = oracle.refPrice(address(quote));
        (uint256 baseRef,,) = oracle.refPrice(address(base));

        settledBatches.push(
            SettledBatch({
                id: s.batchId,
                savingsUsd: s.claimedSavings,
                notionalUsd: _notional(s),
                solverFeeUsd: solverFee,
                quotePrice: s.prices[0],
                basePrice: s.prices[1],
                quoteRef: (quoteRef * WAD) / (10 ** quote.decimals()),
                baseRef: (baseRef * WAD) / (10 ** base.decimals()),
                maxDevBps: sessions.maxDeviationBps(sessions.sessionAt(s.batchId))
            })
        );
    }

    /// @dev What the solver is holding in dollars right now. Fees are the only way
    /// the solver ever receives a token here, so the running total is the fee.
    function _solverValue(Solution memory s) internal view returns (uint256) {
        return (quote.balanceOf(solver) * s.prices[0]) / WAD + (base.balanceOf(solver) * s.prices[1]) / WAD;
    }

    function _notional(Solution memory s) internal pure returns (uint256 total) {
        for (uint256 k = 0; k < s.executions.length; ++k) {
            Intent memory i = s.intents[s.executions[k].intentIndex];
            uint256 price = i.sellToken == s.tokens[0] ? s.prices[0] : s.prices[1];
            total += (s.executions[k].executedSell * price) / WAD;
        }
    }
}
