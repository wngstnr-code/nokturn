// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {ClearingMath} from "../../src/libraries/ClearingMath.sol";

/// @notice The clearing predicates under a third engine, per rencana-uji.md
/// section 1. Foundry fuzzes these, halmos proves them, and echidna searches them
/// with a different generator and a different shrinker. Three engines over one
/// property is not three times the assurance, but it is three different ways of
/// being wrong about what the property covers.
///
/// Nothing here uses a cheatcode, because echidna has none. A premise that does
/// not hold returns early rather than being assumed away, which is the same shape
/// the halmos proofs use for their branching properties.
///
/// Echidna prints a warning that some of the assertions below were never reached.
/// That warning is a source map artifact of the IR pipeline, not a vacuous
/// property. Every one of these was checked by breaking it on purpose and watching
/// echidna falsify it, which is the only way to tell the two apart.
///
/// Arguments are uint128 for the reason stated in ClearingMathProofs. Two such
/// values multiplied still fit a uint256, which is what lets the limit path cross
/// multiply instead of dividing.
contract EchidnaClearing {
    uint256 internal constant BPS = 10_000;

    uint16 internal constant FEE_CAP_SHARE_BPS = 2000;
    uint16 internal constant FEE_CAP_NOTIONAL_BPS = 3;

    /// parameter.md section 4, ascending.
    uint16 internal constant PROTECTIVE_BPS = 20;
    uint16 internal constant OPEN_BPS = 30;
    uint16 internal constant PRE_AND_POST_BPS = 60;
    uint16 internal constant OVERNIGHT_BPS = 100;
    uint16 internal constant WEEKEND_BPS = 150;
    uint16 internal constant AUCTION_COLLAR_BPS = 200;

    /// I6. The fee is at most a fifth of the surplus and at most three basis points
    /// of the notional, and both hold at once.
    function checkFeeCapNeverPassesEitherBound(uint128 surplusUsd, uint128 notionalUsd) public pure {
        uint256 cap = ClearingMath.feeCap(surplusUsd, notionalUsd, FEE_CAP_SHARE_BPS, FEE_CAP_NOTIONAL_BPS);
        assert(cap <= (uint256(surplusUsd) * FEE_CAP_SHARE_BPS) / BPS);
        assert(cap <= (uint256(notionalUsd) * FEE_CAP_NOTIONAL_BPS) / BPS);
    }

    /// I6. A batch with no surplus has no fee to give, whatever its size.
    function checkNoSurplusMeansNoFee(uint128 notionalUsd) public pure {
        assert(ClearingMath.feeCap(0, notionalUsd, FEE_CAP_SHARE_BPS, FEE_CAP_NOTIONAL_BPS) == 0);
    }

    /// I1. A fill that delivered exactly what was asked for, against the whole
    /// amount offered, always clears.
    function checkAFullFillAlwaysClears(uint128 executedBuy, uint128 sellAmount) public pure {
        assert(ClearingMath.limitRespected(executedBuy, sellAmount, executedBuy, sellAmount));
    }

    /// I1. More delivered is never worse.
    function checkDeliveringMoreNeverBreaksALimit(
        uint128 executedBuy,
        uint128 extra,
        uint128 sellAmount,
        uint128 minBuyAmount,
        uint128 executedSell
    ) public pure {
        if (uint256(executedBuy) + extra > type(uint128).max) return;
        if (!ClearingMath.limitRespected(executedBuy, sellAmount, minBuyAmount, executedSell)) return;
        assert(
            ClearingMath.limitRespected(uint256(executedBuy) + extra, sellAmount, minBuyAmount, executedSell)
        );
    }

    /// I1. A fill that sold nothing cannot break a limit, whatever was asked for.
    function checkAFillThatSoldNothingNeverBreaksALimit(
        uint128 executedBuy,
        uint128 sellAmount,
        uint128 minBuyAmount
    ) public pure {
        assert(ClearingMath.limitRespected(executedBuy, sellAmount, minBuyAmount, 0));
    }

    /// I2 and I6. Whatever the uniform price check lets through withheld no more
    /// than the fee ceiling, and never took out more than it put in.
    function checkTheFeeBandIsAlsoTheCeiling(uint128 valueIn, uint128 valueOut, uint16 maxFeeBps)
        public
        pure
    {
        if (!ClearingMath.feeWithinBand(valueIn, valueOut, maxFeeBps)) return;
        assert(valueOut <= valueIn);
        assert((uint256(valueIn) - valueOut) * BPS <= uint256(valueIn) * maxFeeBps);
    }

    /// I2. A fill that hands back everything it took is inside the band at any
    /// ceiling, including zero.
    function checkAnExactNettingIsAlwaysInsideTheBand(uint128 value, uint16 maxFeeBps) public pure {
        assert(ClearingMath.feeWithinBand(value, value, maxFeeBps));
    }

    /// I7. The band is symmetric, so a solver gains nothing from the side it picks.
    function checkTheBandIsSymmetric(uint128 ref, uint128 distance, uint16 maxDevBps) public pure {
        if (distance > ref) return;
        assert(
            ClearingMath.withinBand(uint256(ref) + distance, ref, maxDevBps)
                == ClearingMath.withinBand(uint256(ref) - distance, ref, maxDevBps)
        );
    }

    /// I7. The reference is always inside its own band, at any width.
    function checkTheReferenceIsInsideItsOwnBand(uint128 ref, uint16 maxDevBps) public pure {
        assert(ClearingMath.withinBand(ref, ref, maxDevBps));
    }

    /// I7. Widening the band never excludes a price it already accepted. Stated
    /// over the six widths that exist, for the reason ClearingMathProofs gives.
    function checkAWiderBandNeverRefusesWhatANarrowerOneTook(uint128 price, uint128 ref) public pure {
        uint16[6] memory widths = _widths();
        for (uint256 k = 1; k < 6; ++k) {
            if (!ClearingMath.withinBand(price, ref, widths[k - 1])) continue;
            assert(ClearingMath.withinBand(price, ref, widths[k]));
        }
    }

    function _widths() internal pure returns (uint16[6] memory) {
        return [PROTECTIVE_BPS, OPEN_BPS, PRE_AND_POST_BPS, OVERNIGHT_BPS, WEEKEND_BPS, AUCTION_COLLAR_BPS];
    }
}
