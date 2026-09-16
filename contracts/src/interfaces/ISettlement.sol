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
    event SolutionSubmitted(
        uint64 indexed batchId, address indexed solver, bytes32 hash, uint256 claimedSavings
    );
    event SolutionRejected(uint64 indexed batchId, address indexed solver, bytes32 reason);
    event ClearingPrice(uint64 indexed batchId, address indexed token, uint256 price, uint256 refPrice);
    event IntentSubmittedOnchain(address indexed owner, bytes32 indexed intentHash);
    event DustSwept(address indexed token, uint256 amount);

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
    error TokenNotAllowed(address token);
    error MultiplierChanged(address token, uint256 atStart, uint256 atSettle);
    error MandateViolated(uint256 intentIndex, bytes32 rule);

    function submitSolution(Solution calldata s) external;

    /// @notice The winner resubmits the full payload. Only its hash is kept onchain.
    function finalize(uint64 batchId, Solution calldata winning) external;

    /// @notice Censorship escape hatch. Works even if every coordinator refuses the intent.
    function submitIntentOnchain(Intent calldata i, bytes calldata sig) external;

    function invalidateNonce(uint256 nonce) external;

    /// @notice Unordered nonce bitmap, same shape as Permit2. wordPos is nonce >> 8.
    function invalidateNonceRange(uint256 wordPos, uint256 mask) external;

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
