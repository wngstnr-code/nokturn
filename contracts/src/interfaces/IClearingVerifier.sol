// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

/// @title Clearing verifier
/// @notice Checks uniform pricing, limits by cross multiplication, per token value
/// conservation, the price band, and the correctness of claimed savings. Reverts
/// with the errors declared on ISettlement when any of those fail.
///
/// The two packed arguments use a fixed stride so that a Rust implementation and a
/// Solidity implementation read the exact same bytes. Both are big endian, and
/// reserved bytes must be zero.
///
/// packedIntents, 72 bytes per entry:
///   [0:2]   sellTokenIndex, uint16, index into tokens
///   [2:4]   buyTokenIndex, uint16, index into tokens
///   [4:5]   flags, uint8, bit0 partial fill
///   [5:8]   reserved, zero
///   [8:40]  sellAmount, uint256
///   [40:72] minBuyAmount, uint256
///
/// maxFeeBps is how far below the clearing price an execution may land. It is what
/// makes uniform pricing enforceable and chargeable at once: without a tolerance no
/// fee could ever be withheld, and without a cap the solver could set the effective
/// price per user. Settlement passes FEE_CAP_NOTIONAL_BPS, so the per intent bound
/// and the published fee cap are the same number.
///
/// packedExecutions, 72 bytes per entry:
///   [0:4]   intentIndex, uint32
///   [4:8]   reserved, zero
///   [8:40]  executedSell, uint256
///   [40:72] executedBuy, uint256
interface IClearingVerifier {
    function verify(
        bytes calldata packedIntents,
        bytes calldata packedExecutions,
        address[] calldata tokens,
        uint256[] calldata prices,
        int256[] calldata venueDeltas,
        uint256[] calldata oraclePrices,
        uint256[] calldata baselineQuotes,
        uint16 maxDeviationBps,
        uint16 maxFeeBps
    ) external pure returns (uint256 savings);

    /// @notice Evaluates the volume curve at a single price in O(N), without sorting.
    /// This is what makes verifying an auction challenge cheap.
    /// @notice A solver side helper, not part of the settlement path. Its price is
    /// a relative one, quote token smallest units per 1e18 base token smallest
    /// units, which is a different quantity from the USD prices verify takes.
    function evaluateVolume(bytes calldata packedIntents, uint256 price)
        external
        pure
        returns (uint256 demand, uint256 supply, uint256 executable);
}
