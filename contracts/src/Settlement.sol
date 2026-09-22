// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {Guarded} from "./Guarded.sol";
import {IClearingVerifier} from "./interfaces/IClearingVerifier.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";
import {ISessionManager} from "./interfaces/ISessionManager.sol";
import {ISettlement} from "./interfaces/ISettlement.sol";
import {ISignatureTransfer} from "./interfaces/IPermit2.sol";
import {ISolverRegistry} from "./interfaces/ISolverRegistry.sol";
import {IUiMultiplier} from "./interfaces/IUiMultiplier.sol";
import {IVenueAdapter} from "./interfaces/IVenueAdapter.sol";
import {ClearingMath} from "./libraries/ClearingMath.sol";
import {IntentLib} from "./libraries/IntentLib.sol";
import {Execution, Intent, Session, SessionMask, Solution, VenueCall} from "./types/Types.sol";

/// @title Nokturn settlement core
/// @notice Immutable. No proxy, and no key that can move user funds. Allowlists
/// and parameters move through a 48 hour timelock, and nothing else moves at all.
///
/// The contract verifies validity and lets competition decide optimality. It also
/// caps what a solver can take, because at launch there is only one solver and
/// the code has to be what restrains it rather than good intentions.
///
/// Prices on this surface are USD with 18 decimals per SMALLEST unit of the token,
/// scaled by 1e18. Not per whole token. USDG has six decimals and is the quote asset
/// for nearly every pair, so a price per whole token cannot be multiplied by a raw
/// amount and still mean dollars. See parameter.md section 4C.
contract Settlement is ISettlement, Guarded, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Best {
        bytes32 hash;
        uint256 savings;
        address solver;
        bytes32 multiplierHash;
    }

    /// @dev The per token total is keyed by day outside this struct rather than
    /// inside it. A mapping cannot be cleared on a day rollover without walking its
    /// keys, and a total that is never cleared is a lifetime quota wearing the word
    /// daily. Settlement is immutable, so a token that reached it would have been
    /// retired for good.
    struct Day {
        uint32 index;
        uint256 global;
    }

    uint256 internal constant WAD = 1e18;
    uint16 internal constant BPS = 10_000;

    uint32 public constant SOLUTION_WINDOW = 10;

    /// After this, anyone can retire a batch whose winner never finalized it. The
    /// batch is not stuck, since no funds move before finalize, but the winner has
    /// still blocked everyone else's solution and that is what gets slashed.
    uint32 public constant FINALIZE_DEADLINE = 300;
    uint8 public constant MAX_SOLUTIONS_PER_SOLVER = 3;

    uint16 internal constant FEE_CAP_SHARE_BPS = 2000; // 20 percent of the surplus
    uint16 internal constant FEE_CAP_NOTIONAL_BPS = 3;
    uint16 internal constant MIN_SAVINGS_BPS = 1;
    uint16 internal constant SOLVER_SHARE_OF_FEE_BPS = 7500; // 15 of the 20

    ISessionManager public immutable sessions;
    IPriceOracle public immutable oracle;
    IClearingVerifier public immutable verifier;
    ISolverRegistry public immutable solvers;
    ISignatureTransfer public immutable permit2;
    address public immutable treasury;
    address public immutable governor;

    string public constant WITNESS_TYPE_STRING = "Intent witness)Intent(address owner,address receiver,"
        "address sellToken,address buyToken,uint256 sellAmount,uint256 minBuyAmount,uint32 validAfter,"
        "uint32 validUntil,uint8 flags,uint8 kind,uint16 maxDevFromRefBps,uint8 allowedSessions,"
        "uint16 batchSpan,uint256 nonce)TokenPermissions(address token,uint256 amount)";

    mapping(uint64 => Best) internal best;
    mapping(uint64 => bool) public finalized;
    mapping(uint64 => mapping(address => uint8)) public solutionsSubmitted;

    mapping(address => bool) public tokenAllowed;
    mapping(address => bool) public adapterAllowed;

    /// The adapter the floor under Solution.baselineQuotes is read from.
    /// parameter.md section 4C. A parameter rather than an immutable, because the
    /// V4 adapter arrives in v1.1 through the timelock and the settlement core does
    /// not get redeployed for it.
    address public baselineAdapter;

    uint256 public capPerBatchUsd = 5000e18;
    uint256 public capPerTokenDailyUsd = 50_000e18;
    uint256 public capGlobalDailyUsd = 200_000e18;

    Day internal today;
    mapping(uint32 => mapping(address => uint256)) internal perTokenOnDay;

    error NotGovernor();
    error SolverNotActive(address solver);
    error TooManySolutions(address solver);
    error BatchMisaligned(uint64 batchId, uint32 duration);
    error BatchInGuardBand(uint64 batchId);
    error AlreadyFinalized(uint64 batchId);
    error NoWinningSolution(uint64 batchId);
    error IntentNonceUsed(uint256 intentIndex);
    error SolutionHashMismatch(uint64 batchId);
    error SolutionArraysMismatch();
    error FeeExceedsCap(uint256 withheld, uint256 cap);
    error OracleUnhealthy(address token);

    constructor(
        ISessionManager sessions_,
        IPriceOracle oracle_,
        IClearingVerifier verifier_,
        ISolverRegistry solvers_,
        ISignatureTransfer permit2_,
        address treasury_,
        address governor_,
        address guardian_
    ) Guarded(guardian_) {
        sessions = sessions_;
        oracle = oracle_;
        verifier = verifier_;
        solvers = solvers_;
        permit2 = permit2_;
        treasury = treasury_;
        governor = governor_;
    }

    modifier onlyGovernor() {
        if (msg.sender != governor) revert NotGovernor();
        _;
    }

    function setTokenAllowed(address token, bool allowed) external onlyGovernor {
        tokenAllowed[token] = allowed;
        emit TokenAllowlisted(token, allowed);
    }

    function setAdapterAllowed(address adapter, bool allowed) external onlyGovernor {
        adapterAllowed[adapter] = allowed;
        emit AdapterAllowlisted(adapter, allowed);
    }

    /// @notice Names the adapter the baseline floor is read from. Zero clears it,
    /// which leaves every batch a pass through rather than an unchecked one.
    function setBaselineAdapter(address adapter) external onlyGovernor {
        if (adapter != address(0)) {
            if (!adapterAllowed[adapter]) revert AdapterNotAllowed(adapter);
            // The timelock is naming this adapter, and the adapter is not the
            // timelock, so an adapter that reenters here lands on onlyGovernor and
            // can only refuse its own appointment. Nothing has been written yet at
            // this point either, so there is no half applied state to reenter into.
            // aderyn-fp-next-line(reentrancy-state-change)
            if (!IVenueAdapter(adapter).isQuotable()) revert AdapterNotQuotable(adapter);
        }
        baselineAdapter = adapter;
        emit BaselineAdapterSet(adapter);
    }

    /// @notice The guardian is a parameter rather than an immutable, so a leaked
    /// key stops mattering one rotation after it is noticed. parameter.md 8.1.
    function setGuardian(address guardian_) external onlyGovernor {
        _setGuardian(guardian_);
    }

    function setExposureCaps(uint256 perBatch, uint256 perTokenDaily, uint256 globalDaily)
        external
        onlyGovernor
    {
        capPerBatchUsd = perBatch;
        capPerTokenDailyUsd = perTokenDaily;
        capGlobalDailyUsd = globalDaily;
        emit ExposureCapsUpdated(perBatch, perTokenDaily, globalDaily);
    }

    /// @inheritdoc ISettlement
    function batchWindow(uint64 batchId)
        public
        view
        returns (uint64 collectStart, uint64 collectEnd, uint64 solveEnd)
    {
        Session session = sessions.sessionAt(batchId);
        uint32 duration = sessions.batchDuration(session);
        if (duration == 0 || batchId % duration != 0) revert BatchMisaligned(batchId, duration);
        if (sessions.inGuardBand(batchId)) revert BatchInGuardBand(batchId);
        collectEnd = batchId;
        collectStart = batchId - duration;
        solveEnd = batchId + SOLUTION_WINDOW;
    }

    /// @inheritdoc ISettlement
    function submitSolution(Solution calldata s) external whenLive {
        // SolverRegistry is immutable and this reads it.
        // aderyn-fp-next-line(reentrancy-state-change)
        if (!solvers.isActive(msg.sender)) revert SolverNotActive(msg.sender);

        uint8 count = solutionsSubmitted[s.batchId][msg.sender] + 1;
        if (count > MAX_SOLUTIONS_PER_SOLVER) revert TooManySolutions(msg.sender);
        solutionsSubmitted[s.batchId][msg.sender] = count;

        (, uint64 collectEnd, uint64 solveEnd) = batchWindow(s.batchId);
        // Batch windows are wall clock windows by definition. The guard band in
        // SessionManager is what absorbs sequencer drift at the edges.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp <= collectEnd || block.timestamp > solveEnd) {
            revert SolutionWindowClosed(s.batchId);
        }
        if (finalized[s.batchId]) revert AlreadyFinalized(s.batchId);

        _requireCollectable(s, solveEnd);

        uint256 computed = _verify(s);
        if (computed != s.claimedSavings) {
            emit SolutionRejected(s.batchId, msg.sender, "savings mismatch");
            revert SavingsMismatch(s.claimedSavings, computed);
        }

        bytes32 hash = keccak256(abi.encode(s));
        emit SolutionSubmitted(s.batchId, msg.sender, hash, computed);

        if (computed <= best[s.batchId].savings && best[s.batchId].hash != bytes32(0)) {
            emit SolutionRejected(s.batchId, msg.sender, "not the best");
            return;
        }

        best[s.batchId] = Best({
            hash: hash, savings: computed, solver: msg.sender, multiplierHash: _multiplierHash(s.tokens)
        });
    }

    /// @inheritdoc ISettlement
    /// @dev A leg that cannot be collected retires the batch instead of reverting.
    /// The solution window is already shut by the time finalize runs, so no other
    /// solution can replace this one, and an owner who moves their balance, revokes
    /// their approval or burns their nonce in that gap would otherwise decide that
    /// the winner is slashed for a failure that is not theirs. One transaction, and
    /// the whole batch and an honest solver's bond go with it. Nothing is executed
    /// here, everything already taken is given back, and the offending owner is
    /// named in an event so the coordinator can price the behaviour offchain.
    function finalize(uint64 batchId, Solution calldata winning) external nonReentrant whenLive {
        if (finalized[batchId]) revert AlreadyFinalized(batchId);
        (, uint64 collectEnd, uint64 solveEnd) = batchWindow(batchId);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp <= solveEnd) revert SolutionWindowClosed(batchId);

        Best memory winner = best[batchId];
        if (winner.hash == bytes32(0)) revert NoWinningSolution(batchId);
        if (keccak256(abi.encode(winning)) != winner.hash) revert SolutionHashMismatch(batchId);

        bytes32 multipliersNow = _multiplierHash(winning.tokens);
        if (multipliersNow != winner.multiplierHash) {
            revert MultiplierChanged(
                winning.tokens[0], uint256(winner.multiplierHash), uint256(multipliersNow)
            );
        }

        finalized[batchId] = true;

        uint256[] memory before = _balances(winning.tokens);
        uint256 collected = _pull(winning, collectEnd);
        if (collected != winning.executions.length) {
            _refund(winning, collected);
            emit BatchPassthrough(batchId, winning.executions.length, "intent could not be collected");
            return;
        }
        _route(winning);
        _deliver(winning);

        uint256 notionalUsd = _notionalUsd(winning);
        _chargeExposure(winning, notionalUsd);
        _settleFees(winning, winner, before, notionalUsd);
    }

    /// @notice Retires a batch whose winner never finalized it, and slashes them.
    /// Callable by anyone, because a griefing solver should not also get to decide
    /// when the consequence lands.
    function expireBatch(uint64 batchId) external {
        if (finalized[batchId]) revert AlreadyFinalized(batchId);
        (,, uint64 solveEnd) = batchWindow(batchId);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp <= solveEnd + FINALIZE_DEADLINE) revert SolutionWindowClosed(batchId);

        Best memory winner = best[batchId];
        if (winner.hash == bytes32(0)) revert NoWinningSolution(batchId);

        finalized[batchId] = true;
        solvers.reportFailedFinalize(winner.solver);
        emit BatchPassthrough(batchId, 0, "winner never finalized");
    }

    /// @inheritdoc ISettlement
    function submitIntentOnchain(Intent calldata i, bytes calldata sig) external {
        // The escape hatch executes nothing. It publishes the intent and its
        // signature so any solver can pick it up even when every coordinator
        // refuses to relay it.
        emit IntentSubmittedOnchain(i.owner, _intentHash(i), i, sig);
    }

    /// @inheritdoc ISettlement
    function bestSolution(uint64 batchId) external view returns (bytes32, uint256, address) {
        Best memory b = best[batchId];
        return (b.hash, b.savings, b.solver);
    }

    /// @inheritdoc ISettlement
    function nonceUsed(address owner, uint256 nonce) external view returns (bool) {
        uint256 word = permit2.nonceBitmap(owner, nonce >> 8);
        return word & (2 ** (nonce & 0xff)) != 0;
    }

    function _verify(Solution calldata s) internal view returns (uint256) {
        if (s.intents.length != s.signatures.length) revert SolutionArraysMismatch();
        if (s.executions.length != s.baselineQuotes.length) revert SolutionArraysMismatch();

        uint256[] memory oraclePrices = new uint256[](s.tokens.length);
        for (uint256 t = 0; t < s.tokens.length; ++t) {
            if (!tokenAllowed[s.tokens[t]]) revert TokenNotAllowed(s.tokens[t]);
            (uint256 price,, bool healthy) = oracle.refPrice(s.tokens[t]);
            if (!healthy) revert OracleUnhealthy(s.tokens[t]);
            // Per smallest unit, not per whole token. See the note on this contract.
            oraclePrices[t] = (price * WAD) / (10 ** IERC20Metadata(s.tokens[t]).decimals());
        }

        Session session = sessions.sessionAt(s.batchId);
        uint256 savings = verifier.verify(
            _packIntents(s),
            _packExecutions(s),
            s.tokens,
            s.prices,
            _venueDeltas(s),
            oraclePrices,
            s.baselineQuotes,
            sessions.maxDeviationBps(session),
            FEE_CAP_NOTIONAL_BPS
        );

        // A baseline nobody checked is a baseline a solver writes for itself, and
        // savings is what picks the winner and sets the fee cap. parameter.md 4C.
        return _baselineFloor(s) ? savings : 0;
    }

    /// @dev One quote per pair direction on that direction's gross volume, not one
    /// per intent. The bound is looser than the truth by the pool's own price impact
    /// between a combined trade and the same volume split, which is zero at the
    /// batch sizes this protocol actually sees. parameter.md section 4C carries the
    /// measured table.
    ///
    /// @return priced false when no floor could be computed at all, which forces
    /// the batch to pass through rather than trusting an unchecked number.
    function _baselineFloor(Solution calldata s) internal view returns (bool priced) {
        address adapter = baselineAdapter;
        if (adapter == address(0)) return false;

        uint256 n = s.tokens.length;
        uint256[][] memory sold = new uint256[][](n);
        uint256[][] memory claimed = new uint256[][](n);
        for (uint256 t = 0; t < n; ++t) {
            sold[t] = new uint256[](n);
            claimed[t] = new uint256[](n);
        }

        for (uint256 k = 0; k < s.executions.length; ++k) {
            Intent calldata i = s.intents[s.executions[k].intentIndex];
            uint256 si = _tokenIndex(s.tokens, i.sellToken);
            uint256 bi = _tokenIndex(s.tokens, i.buyToken);
            sold[si][bi] += s.executions[k].executedSell;
            claimed[si][bi] += s.baselineQuotes[k];
        }

        priced = true;
        for (uint256 si = 0; si < n; ++si) {
            for (uint256 bi = 0; bi < n; ++bi) {
                if (sold[si][bi] == 0) continue;
                try IVenueAdapter(adapter).quoteFromState(s.tokens[si], s.tokens[bi], sold[si][bi]) returns (
                    uint256 floor
                ) {
                    if (claimed[si][bi] < floor) {
                        revert BaselineBelowVenue(s.tokens[si], s.tokens[bi], claimed[si][bi], floor);
                    }
                } catch {
                    // The venue cannot be read for this pair right now, so there is
                    // no floor to hold the solver to and no fee to charge.
                    priced = false;
                }
            }
        }
    }

    /// @dev Returns how many executions were collected. A short count is not an
    /// error here. It means an owner made their own leg impossible after the
    /// solution window had already closed, and finalize unwinds rather than
    /// reverting. See the comment on finalize.
    /// @dev The two ways a leg is doomed before the solution is even recorded. A
    /// nonce Permit2 has already spent never comes back, and a permit whose
    /// deadline falls inside the solving window is dead before finalize can run.
    /// Both are the solver's own doing and both are refused here, which is what
    /// leaves finalize free to read a failed collection as the owner changing
    /// their mind rather than as anything the solver is answerable for.
    function _requireCollectable(Solution calldata s, uint64 solveEnd) internal view {
        for (uint256 k = 0; k < s.executions.length; ++k) {
            uint256 index = s.executions[k].intentIndex;
            Intent calldata i = s.intents[index];
            if (i.validUntil <= solveEnd) revert IntentExpired(index);
            uint256 word = permit2.nonceBitmap(i.owner, i.nonce >> 8);
            if (word & (2 ** (i.nonce & 0xff)) != 0) revert IntentNonceUsed(index);
        }
    }

    function _pull(Solution calldata s, uint64 collectEnd) internal returns (uint256) {
        Session session = sessions.sessionAt(collectEnd);
        uint8 sessionBit = SessionMask.bit(session);

        for (uint256 k = 0; k < s.executions.length; ++k) {
            Execution calldata e = s.executions[k];
            Intent calldata i = s.intents[e.intentIndex];

            if (i.validUntil < collectEnd || i.validAfter > collectEnd) revert IntentExpired(e.intentIndex);
            if (i.allowedSessions & sessionBit == 0) {
                revert SessionNotAllowed(e.intentIndex, uint8(session));
            }
            if (!tokenAllowed[i.sellToken] || !tokenAllowed[i.buyToken]) {
                revert TokenNotAllowed(tokenAllowed[i.sellToken] ? i.buyToken : i.sellToken);
            }

            // Permit2 and the sell token are both allowlisted, so nothing an owner
            // controls runs inside this call. What an owner does control is whether
            // it can succeed at all, and that is what the catch is here for.
            try permit2.permitWitnessTransferFrom(
                ISignatureTransfer.PermitTransferFrom({
                    permitted: ISignatureTransfer.TokenPermissions({
                        token: i.sellToken, amount: i.sellAmount
                    }),
                    nonce: i.nonce,
                    deadline: i.validUntil
                }),
                ISignatureTransfer.SignatureTransferDetails({
                    to: address(this), requestedAmount: e.executedSell
                }),
                i.owner,
                _intentHash(i),
                WITNESS_TYPE_STRING,
                s.signatures[e.intentIndex]
            ) {}
            catch {
                emit IntentCollectionFailed(s.batchId, i.owner, e.intentIndex);
                return k;
            }
        }
        return s.executions.length;
    }

    /// @dev Gives back what was already taken when a later leg cannot be collected.
    /// The owner is paid, not the receiver, because nothing was executed and the
    /// receiver is where a filled intent lands rather than where it came from.
    function _refund(Solution calldata s, uint256 collected) internal {
        for (uint256 k = 0; k < collected; ++k) {
            Execution calldata e = s.executions[k];
            Intent calldata i = s.intents[e.intentIndex];
            IERC20(i.sellToken).safeTransfer(i.owner, e.executedSell);
        }
    }

    function _route(Solution calldata s) internal {
        for (uint256 v = 0; v < s.venueCalls.length; ++v) {
            VenueCall calldata call = s.venueCalls[v];
            if (!adapterAllowed[call.adapter]) revert AdapterNotAllowed(call.adapter);

            IERC20(call.tokenIn).forceApprove(call.adapter, call.amountIn);
            uint256 out =
                IVenueAdapter(call.adapter).swap(call.tokenIn, call.tokenOut, call.amountIn, call.minOut);
            // Allowance is granted for exactly what is used and taken back in the
            // same transaction, so an adapter is never left standing approved.
            IERC20(call.tokenIn).forceApprove(call.adapter, 0);

            emit VenueRouted(s.batchId, call.adapter, call.tokenIn, call.tokenOut, call.amountIn, out);
        }
    }

    function _deliver(Solution calldata s) internal {
        for (uint256 k = 0; k < s.executions.length; ++k) {
            Execution calldata e = s.executions[k];
            Intent calldata i = s.intents[e.intentIndex];
            if (e.executedBuy > 0) {
                IERC20(i.buyToken).safeTransfer(i.receiver, e.executedBuy);
            }
        }
    }

    function _settleFees(
        Solution calldata s,
        Best memory winner,
        uint256[] memory before,
        uint256 notionalUsd
    ) internal {
        uint256 withheldUsd;
        uint256[] memory withheld = new uint256[](s.tokens.length);
        for (uint256 t = 0; t < s.tokens.length; ++t) {
            uint256 balance = IERC20(s.tokens[t]).balanceOf(address(this));
            withheld[t] = balance > before[t] ? balance - before[t] : 0;
            withheldUsd += (withheld[t] * s.prices[t]) / WAD;
        }

        uint256 cap = _feeCap(winner.savings + withheldUsd, notionalUsd);
        if (withheldUsd > cap) revert FeeExceedsCap(withheldUsd, cap);

        bool passthrough = winner.savings * BPS < notionalUsd * MIN_SAVINGS_BPS;
        uint256 solverFeeUsd;
        uint256 protocolFeeUsd;

        for (uint256 t = 0; t < s.tokens.length; ++t) {
            if (withheld[t] == 0) continue;
            uint256 toSolver = passthrough ? 0 : (withheld[t] * SOLVER_SHARE_OF_FEE_BPS) / BPS;
            uint256 toTreasury = withheld[t] - toSolver;
            if (toSolver > 0) {
                IERC20(s.tokens[t]).safeTransfer(winner.solver, toSolver);
                solverFeeUsd += (toSolver * s.prices[t]) / WAD;
            }
            if (toTreasury > 0) {
                // Dust rounds to the protocol, never to the solver, so nobody has a
                // reason to play the rounding.
                IERC20(s.tokens[t]).safeTransfer(treasury, toTreasury);
                protocolFeeUsd += (toTreasury * s.prices[t]) / WAD;
                emit DustSwept(s.tokens[t], toTreasury);
            }
        }

        if (passthrough) {
            emit BatchPassthrough(s.batchId, s.intents.length, "savings below threshold");
        }

        _emitFills(s);
        solvers.recordWin(winner.solver, winner.savings);

        (uint256 nettedUsd, uint256 routedUsd) = _nettedAndRouted(s, notionalUsd);
        emit BatchSettled(
            s.batchId,
            winner.solver,
            uint8(sessions.sessionAt(s.batchId)),
            s.intents.length,
            nettedUsd,
            routedUsd,
            winner.savings,
            solverFeeUsd,
            protocolFeeUsd
        );
    }

    function _emitFills(Solution calldata s) internal {
        for (uint256 k = 0; k < s.executions.length; ++k) {
            Execution calldata e = s.executions[k];
            Intent calldata i = s.intents[e.intentIndex];
            uint256 buyPrice = s.prices[_tokenIndex(s.tokens, i.buyToken)];
            uint256 savingsUsd = ((e.executedBuy - s.baselineQuotes[k]) * buyPrice) / WAD;
            emit IntentSettled(
                s.batchId,
                i.owner,
                _intentHash(i),
                i.sellToken,
                i.buyToken,
                e.executedSell,
                e.executedBuy,
                s.baselineQuotes[k],
                savingsUsd
            );
        }
    }

    /// @dev The netted share is what never reached a venue. This is the pair that
    /// measures whether the network effect is working, so it is derived from the
    /// routed amounts rather than taken from the solver's word.
    function _nettedAndRouted(Solution calldata s, uint256 notionalUsd)
        internal
        pure
        returns (uint256 nettedUsd, uint256 routedUsd)
    {
        for (uint256 v = 0; v < s.venueCalls.length; ++v) {
            VenueCall calldata call = s.venueCalls[v];
            routedUsd += (call.amountIn * s.prices[_tokenIndex(s.tokens, call.tokenIn)]) / WAD;
        }
        nettedUsd = notionalUsd > routedUsd ? notionalUsd - routedUsd : 0;
    }

    function _feeCap(uint256 surplusUsd, uint256 notionalUsd) internal pure returns (uint256) {
        return ClearingMath.feeCap(surplusUsd, notionalUsd, FEE_CAP_SHARE_BPS, FEE_CAP_NOTIONAL_BPS);
    }

    function _chargeExposure(Solution calldata s, uint256 notionalUsd) internal {
        Session session = sessions.sessionAt(s.batchId);
        uint256 scale = _capScale(session);

        if (notionalUsd > (capPerBatchUsd * scale) / 2) {
            revert ExposureCapExceeded("batch", notionalUsd, (capPerBatchUsd * scale) / 2);
        }

        // forge-lint: disable-next-line(unsafe-typecast)
        uint32 dayIndex = uint32(block.timestamp / 1 days);
        if (today.index != dayIndex) {
            today.index = dayIndex;
            today.global = 0;
        }

        today.global += notionalUsd;
        if (today.global > (capGlobalDailyUsd * scale) / 2) {
            revert ExposureCapExceeded("global", today.global, (capGlobalDailyUsd * scale) / 2);
        }

        uint256 tokenCap = (capPerTokenDailyUsd * scale) / 2;
        for (uint256 t = 0; t < s.tokens.length; ++t) {
            uint256 tokenNotional = _tokenNotional(s, s.tokens[t], s.prices[t]);
            uint256 spent = perTokenOnDay[dayIndex][s.tokens[t]] + tokenNotional;
            perTokenOnDay[dayIndex][s.tokens[t]] = spent;
            if (spent > tokenCap) revert ExposureCapExceeded("token", spent, tokenCap);
        }
    }

    /// @dev Weekend, holiday and protective sessions halve every cap. A wider band
    /// with an unchanged cap would raise the worst case loss exactly when the price
    /// is least certain, so the two always move in opposite directions.
    function _capScale(Session session) internal pure returns (uint256) {
        if (session == Session.CLOSED_WEEKEND || session == Session.HOLIDAY || session == Session.PROTECTIVE)
        {
            return 1;
        }
        return 2;
    }

    function _tokenNotional(Solution calldata s, address token, uint256 price)
        internal
        pure
        returns (uint256 total)
    {
        for (uint256 k = 0; k < s.executions.length; ++k) {
            Intent calldata i = s.intents[s.executions[k].intentIndex];
            if (i.sellToken == token) total += (s.executions[k].executedSell * price) / WAD;
        }
    }

    function _notionalUsd(Solution calldata s) internal pure returns (uint256 total) {
        for (uint256 k = 0; k < s.executions.length; ++k) {
            Intent calldata i = s.intents[s.executions[k].intentIndex];
            uint256 price = s.prices[_tokenIndex(s.tokens, i.sellToken)];
            total += (s.executions[k].executedSell * price) / WAD;
        }
    }

    function _balances(address[] calldata tokens) internal view returns (uint256[] memory out) {
        out = new uint256[](tokens.length);
        for (uint256 t = 0; t < tokens.length; ++t) {
            out[t] = IERC20(tokens[t]).balanceOf(address(this));
        }
    }

    function _multiplierHash(address[] calldata tokens) internal view returns (bytes32) {
        uint256[] memory values = new uint256[](tokens.length);
        for (uint256 t = 0; t < tokens.length; ++t) {
            try IUiMultiplier(tokens[t]).uiMultiplier() returns (uint256 m) {
                values[t] = m;
            } catch {
                values[t] = 0;
            }
        }
        return keccak256(abi.encode(values));
    }

    function _intentHash(Intent calldata i) internal pure returns (bytes32) {
        return IntentLib.hash(i);
    }

    function _tokenIndex(address[] calldata tokens, address token) internal pure returns (uint256) {
        for (uint256 t = 0; t < tokens.length; ++t) {
            if (tokens[t] == token) return t;
        }
        revert TokenNotAllowed(token);
    }

    function _packIntents(Solution calldata s) internal pure returns (bytes memory out) {
        for (uint256 n = 0; n < s.intents.length; ++n) {
            Intent calldata i = s.intents[n];
            out = bytes.concat(
                out,
                abi.encodePacked(
                    uint16(_tokenIndex(s.tokens, i.sellToken)),
                    uint16(_tokenIndex(s.tokens, i.buyToken)),
                    i.flags,
                    bytes3(0),
                    i.sellAmount,
                    i.minBuyAmount
                )
            );
        }
    }

    function _packExecutions(Solution calldata s) internal pure returns (bytes memory out) {
        for (uint256 k = 0; k < s.executions.length; ++k) {
            Execution calldata e = s.executions[k];
            out = bytes.concat(
                out, abi.encodePacked(uint32(e.intentIndex), bytes4(0), e.executedSell, e.executedBuy)
            );
        }
    }

    /// @dev Deltas use minOut, not the expected output. The verifier then checks
    /// conservation against the least the venue can legally return, and anything
    /// above it stays with the contract where the fee cap governs it.
    function _venueDeltas(Solution calldata s) internal view returns (int256[] memory deltas) {
        deltas = new int256[](s.tokens.length);
        for (uint256 v = 0; v < s.venueCalls.length; ++v) {
            VenueCall calldata call = s.venueCalls[v];
            if (!adapterAllowed[call.adapter]) revert AdapterNotAllowed(call.adapter);
            if (!IVenueAdapter(call.adapter).isQuotable()) revert AdapterNotQuotable(call.adapter);

            deltas[_tokenIndex(s.tokens, call.tokenIn)] -= int256(call.amountIn);
            deltas[_tokenIndex(s.tokens, call.tokenOut)] += int256(call.minOut);
        }
    }
}
