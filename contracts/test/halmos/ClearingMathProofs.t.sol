// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ClearingMath} from "../../src/libraries/ClearingMath.sol";

/// @notice Proofs of the predicates a batch is judged on, from rencana-uji.md
/// section 4. Halmos runs these symbolically, which explores every input in the
/// stated range rather than sampling it, so what they establish is a proof and not
/// a pass rate. Forge runs the same functions as bounded fuzz tests, which is what
/// keeps them honest on a laptop with no solver installed.
///
/// Every argument is a uint128, so the range is stated by the signature rather than
/// by an assumption the fuzzer would reject almost every draw against. The
/// settlement surface carries USD in wad, and 2 to the 128 is about 3.4e20 dollars,
/// which is eleven orders of magnitude past the exposure caps in parameter.md
/// section 4. Two such values multiplied still fit a uint256, which is the reason
/// the limit path can cross multiply without a division at all.
///
/// The two that matter most to a reader are the fee cap and the limit. A fee that
/// cannot pass its ceiling and a limit that cannot be violated are claims the
/// protocol makes without qualification, so they are the ones worth proving.
contract ClearingMathProofs is Test {
    uint256 internal constant BPS = 10_000;

    uint16 internal constant FEE_CAP_SHARE_BPS = 2000;
    uint16 internal constant FEE_CAP_NOTIONAL_BPS = 3;

    /// The six deviation widths SessionManager hands out, in ascending order.
    /// parameter.md section 4.
    uint16 internal constant PROTECTIVE_BPS = 20;
    uint16 internal constant OPEN_BPS = 30;
    uint16 internal constant PRE_AND_POST_BPS = 60;
    uint16 internal constant OVERNIGHT_BPS = 100;
    uint16 internal constant WEEKEND_BPS = 150;
    uint16 internal constant AUCTION_COLLAR_BPS = 200;

    /// The fee is at most a fifth of the surplus and at most three basis points of
    /// the notional, and both hold at once rather than whichever is convenient.
    function testFuzz_theFeeCapNeverPassesEitherBound(uint128 surplusUsd, uint128 notionalUsd) public pure {
        uint256 cap = ClearingMath.feeCap(surplusUsd, notionalUsd, FEE_CAP_SHARE_BPS, FEE_CAP_NOTIONAL_BPS);

        assertLe(cap, (uint256(surplusUsd) * FEE_CAP_SHARE_BPS) / BPS, "the cap passed the surplus share");
        assertLe(
            cap, (uint256(notionalUsd) * FEE_CAP_NOTIONAL_BPS) / BPS, "the cap passed the notional share"
        );
    }

    /// A batch with no surplus has no fee to give, whatever its size. This is what
    /// makes the pass through case free rather than merely cheap.
    function testFuzz_aBatchWithNoSurplusHasNoFeeCap(uint128 notionalUsd) public pure {
        assertEq(ClearingMath.feeCap(0, notionalUsd, FEE_CAP_SHARE_BPS, FEE_CAP_NOTIONAL_BPS), 0);
    }

    /// A fill that delivered exactly what was asked for, against the whole amount
    /// offered, always clears. The cross multiplication reduces to the comparison
    /// it replaced.
    function testFuzz_theLimitOnAFullFillIsJustTheAskedAmount(uint128 executedBuy, uint128 sellAmount)
        public
        pure
    {
        assertTrue(
            ClearingMath.limitRespected(executedBuy, sellAmount, executedBuy, sellAmount),
            "a fill that delivered exactly what was asked was refused"
        );
    }

    /// More delivered is never worse. A solver that improves one fill can never turn
    /// a batch that cleared into one that does not.
    function testFuzz_deliveringMoreNeverBreaksALimitThatHeld(
        uint128 executedBuy,
        uint128 extra,
        uint128 sellAmount,
        uint128 minBuyAmount,
        uint128 executedSell
    ) public pure {
        // The improved fill stays inside the same range as the original, because a
        // delivery past it is not one any batch in this protocol can hold.
        vm.assume(uint256(executedBuy) + extra <= type(uint128).max);
        vm.assume(ClearingMath.limitRespected(executedBuy, sellAmount, minBuyAmount, executedSell));

        assertTrue(
            ClearingMath.limitRespected(uint256(executedBuy) + extra, sellAmount, minBuyAmount, executedSell),
            "improving a fill broke the limit it already met"
        );
    }

    /// A fill that sold nothing cannot break a limit, whatever was asked for. This
    /// is the base case the partial fill path stands on, since a zero sell side is
    /// what every fill shrinks towards.
    function testFuzz_aFillThatSoldNothingNeverBreaksALimit(
        uint128 executedBuy,
        uint128 sellAmount,
        uint128 minBuyAmount
    ) public pure {
        assertTrue(
            ClearingMath.limitRespected(executedBuy, sellAmount, minBuyAmount, 0),
            "a fill that moved nothing was refused"
        );
    }

    /// Whatever the uniform price check lets through withheld no more than the fee
    /// ceiling. This is the only place in the protocol where value can be withheld
    /// at all, so the bound here is the bound everywhere.
    function testFuzz_nothingInsideTheFeeBandWithheldMoreThanTheCeiling(
        uint128 valueIn,
        uint128 valueOut,
        uint16 maxFeeBps
    ) public pure {
        vm.assume(ClearingMath.feeWithinBand(valueIn, valueOut, maxFeeBps));

        assertLe(valueOut, valueIn, "a fill took out more than it put in");
        assertLe(
            (uint256(valueIn) - valueOut) * BPS,
            uint256(valueIn) * maxFeeBps,
            "more was withheld than the ceiling"
        );
    }

    /// A fill that hands back everything it took is inside the band at any ceiling,
    /// including zero. Netting at the clearing price is the base case the whole
    /// protocol is built around.
    function testFuzz_aFillThatWithheldNothingIsAlwaysInsideTheBand(uint128 value, uint16 maxFeeBps)
        public
        pure
    {
        assertTrue(ClearingMath.feeWithinBand(value, value, maxFeeBps), "an exact netting was refused");
    }

    /// The band is symmetric. A price the same distance above the reference is
    /// judged the same as one below it, so a solver gains nothing from the side it
    /// picks.
    function testFuzz_theBandIsSymmetricAroundTheReference(uint128 ref, uint128 distance, uint16 maxDevBps)
        public
        pure
    {
        vm.assume(distance <= ref);

        assertEq(
            ClearingMath.withinBand(uint256(ref) + distance, ref, maxDevBps),
            ClearingMath.withinBand(uint256(ref) - distance, ref, maxDevBps),
            "the band judged one side differently from the other"
        );
    }

    /// The reference is always inside its own band, at any width. A band that could
    /// exclude the oracle price would make every batch on that token unclearable
    /// without anything having gone wrong.
    function testFuzz_theReferenceIsAlwaysInsideItsOwnBand(uint128 ref, uint16 maxDevBps) public pure {
        assertTrue(ClearingMath.withinBand(ref, ref, maxDevBps), "the reference fell outside its own band");
    }

    /// Widening the band never excludes a price it already accepted. Stated over
    /// the six widths that exist rather than over every uint16, because the widths
    /// are a closed set from parameter.md section 4, and a symbolic width turns the
    /// comparison into a product of two unknowns that no solver closes at this
    /// bit width. Adjacent pairs are enough, since the order is transitive.
    ///
    /// Halmos explores both sides of the branch below and that is where the proof
    /// comes from. Under forge most draws land outside the narrowest band and fall
    /// through, so the case with real numbers in it is pinned separately.
    function testFuzz_aWiderBandNeverRefusesWhatANarrowerOneAccepted(uint128 price, uint128 ref) public pure {
        uint16[6] memory widths = _widths();
        for (uint256 k = 1; k < 6; ++k) {
            if (!ClearingMath.withinBand(price, ref, widths[k - 1])) continue;
            assertTrue(
                ClearingMath.withinBand(price, ref, widths[k]),
                "a wider band refused what a narrower one took"
            );
        }
    }

    /// NVDA at two hundred dollars, drifting out through each width in turn. The
    /// widths are ordered, so a price is refused by every band narrower than the
    /// one it sits in and accepted by every band wider.
    function test_theSixWidthsAcceptInTheOrderTheyAreWritten() public pure {
        uint256 ref = 200e18;
        uint16[6] memory widths = _widths();

        for (uint256 k = 0; k < 6; ++k) {
            uint256 justInside = ref + (ref * widths[k]) / BPS;
            uint256 justOutside = justInside + 1;

            for (uint256 j = 0; j < 6; ++j) {
                assertEq(
                    ClearingMath.withinBand(justInside, ref, widths[j]),
                    widths[j] >= widths[k],
                    "a price at one width was taken by the wrong set of bands"
                );
            }
            assertFalse(
                ClearingMath.withinBand(justOutside, ref, widths[k]),
                "one unit past the edge was still inside"
            );
        }
    }

    function _widths() internal pure returns (uint16[6] memory) {
        return [PROTECTIVE_BPS, OPEN_BPS, PRE_AND_POST_BPS, OVERNIGHT_BPS, WEEKEND_BPS, AUCTION_COLLAR_BPS];
    }
}
