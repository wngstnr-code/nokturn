// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Intent, Solution} from "../types/Types.sol";

interface ISettlement {
    event IntentSettled(
        uint64 indexed batchId,
        address indexed owner,
        bytes32 indexed intentHash,
        address sellToken,
        address buyToken,
        uint256 executedSell,
        uint256 executedBuy,
        uint256 baselineBuy,
        uint256 savingsUsd
    );

    event BatchSettled(
        uint64 indexed batchId,
        address indexed solver,
        uint8 session,
        uint256 intentCount,
        uint256 nettedVolumeUsd,
        uint256 routedVolumeUsd,
        uint256 totalSavingsUsd,
        uint256 solverFeeUsd,
        uint256 protocolFeeUsd
    );

    event BatchPassthrough(uint64 indexed batchId, uint256 intentCount, string reason);

    /// The one leg that could not be collected at finalize, and whose owner it
    /// belongs to. Settlement cannot tell a withdrawn approval from a spent
    /// balance and does not try. It names the owner and leaves the judgement to
    /// whoever is deciding which intents to accept next.
    event IntentCollectionFailed(uint64 indexed batchId, address indexed owner, uint256 intentIndex);
    event SolutionSubmitted(
        uint64 indexed batchId, address indexed solver, bytes32 hash, uint256 claimedSavings
    );
    event SolutionRejected(uint64 indexed batchId, address indexed solver, bytes32 reason);
    event ClearingPrice(uint64 indexed batchId, address indexed token, uint256 price, uint256 refPrice);
    /// @notice Carries the whole intent and its signature, not just the hash. An
    /// escape hatch that only publishes a hash cannot be acted on by a solver, so
    /// it would be a censorship story rather than a censorship route.
    event IntentSubmittedOnchain(
        address indexed owner, bytes32 indexed intentHash, Intent intent, bytes signature
    );
    event DustSwept(address indexed token, uint256 amount);

    /// Mirrors the event on IVenueAdapter so the indexer sees routing from the
    /// contract that actually performed it.
    event VenueRouted(
        uint64 indexed batchId,
        address indexed adapter,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );

    event AdapterAllowlisted(address indexed adapter, bool allowed);

    /// @notice The adapter the floor under baselineQuotes is read from, or zero
    /// when there is none and every batch is therefore a pass through.
    event BaselineAdapterSet(address indexed adapter);
    event TokenAllowlisted(address indexed token, bool allowed);
    event ExposureCapsUpdated(uint256 perBatch, uint256 perTokenDaily, uint256 globalDaily);

    error BatchNotOpen(uint64 batchId);
    error SolutionWindowClosed(uint64 batchId);
    error LimitViolated(uint256 intentIndex);
    error NonUniformPrice(address token);
    error ValueNotConserved(address token, int256 delta);
    error PriceOutsideBand(address token, uint256 price, uint256 ref, uint16 maxBps);
    error SavingsMismatch(uint256 claimed, uint256 computed);
    error ExposureCapExceeded(bytes32 capKind, uint256 attempted, uint256 cap);
    error IntentExpired(uint256 intentIndex);
    error NonceAlreadyUsed(address owner, uint256 nonce);
    error SessionNotAllowed(uint256 intentIndex, uint8 session);
    error AdapterNotAllowed(address adapter);

    /// @notice The total baseline claimed for a pair direction sits below what the
    /// venue itself would have quoted on that direction's volume. parameter.md 4C.
    error BaselineBelowVenue(address sellToken, address buyToken, uint256 claimed, uint256 floor);
    error AdapterNotQuotable(address adapter);
    error TokenNotAllowed(address token);
    error MultiplierChanged(address token, uint256 atStart, uint256 atSettle);

    function submitSolution(Solution calldata s) external;

    /// @notice The winner resubmits the full payload. Only its hash is kept onchain.
    function finalize(uint64 batchId, Solution calldata winning) external;

    /// @notice Censorship escape hatch. Works even if every coordinator refuses the intent.
    function submitIntentOnchain(Intent calldata i, bytes calldata sig) external;

    /// @notice Whether this owner has already spent this nonce.
    /// Nonces live in Permit2, not here. One signature covers both the transfer
    /// and the terms of the trade, so duplicating the bitmap would cost a cold
    /// SSTORE per intent to re-enforce something Permit2 already enforces.
    /// Cancelling means calling invalidateUnorderedNonces on Permit2 directly.
    function bestSolution(uint64 batchId)
        external
        view
        returns (bytes32 hash, uint256 savings, address solver);

    function batchWindow(uint64 batchId)
        external
        view
        returns (uint64 collectStart, uint64 collectEnd, uint64 solveEnd);

    function nonceUsed(address owner, uint256 nonce) external view returns (bool);
}
