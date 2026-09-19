// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

/// @title The four predicates a batch is judged on
/// @notice Lifted out of ClearingVerifier and Settlement so that the arithmetic
/// the whole protocol rests on can be proved rather than sampled. Halmos runs over
/// this library directly in test/halmos, and the contracts call the same functions,
/// so a proof here is a proof about the code that runs.
///
/// Every comparison is a cross multiplication. There is no division on the limit
/// path, which removes rounding from the one place a clearing bug usually hides.
library ClearingMath {
    uint256 internal constant BPS = 10_000;

    /// @notice b * S >= B * s, the limit as a cross multiplication. Equivalent to
    /// asking whether the realised rate b/s beats the asked rate B/S, without
    /// performing either division.
    function limitRespected(
        uint256 executedBuy,
        uint256 sellAmount,
        uint256 minBuyAmount,
        uint256 executedSell
    ) internal pure returns (bool) {
        return executedBuy * sellAmount >= minBuyAmount * executedSell;
    }

    /// @notice Whether the value withheld from one fill is inside the fee ceiling.
    /// The tolerance is not slack. It is the only place value can be withheld at
    /// all, so it doubles as the per intent fee cap.
    function feeWithinBand(uint256 valueIn, uint256 valueOut, uint16 maxFeeBps) internal pure returns (bool) {
        if (valueOut > valueIn) return false;
        return (valueIn - valueOut) * BPS <= valueIn * maxFeeBps;
    }

    /// @notice Whether a clearing price sits inside the session band around the
    /// oracle reference. Symmetric by construction, because the distance is taken
    /// before the comparison rather than after.
    function withinBand(uint256 price, uint256 ref, uint16 maxDeviationBps) internal pure returns (bool) {
        uint256 diff = price > ref ? price - ref : ref - price;
        return diff * BPS <= ref * maxDeviationBps;
    }

    /// @notice The lower of a share of the surplus and a share of the notional.
    /// Both bounds hold at once, which is the property the protocol publishes.
    function feeCap(uint256 surplusUsd, uint256 notionalUsd, uint16 shareBps, uint16 notionalBps)
        internal
        pure
        returns (uint256)
    {
        uint256 byShare = (surplusUsd * shareBps) / BPS;
        uint256 byNotional = (notionalUsd * notionalBps) / BPS;
        return byShare < byNotional ? byShare : byNotional;
    }
}
