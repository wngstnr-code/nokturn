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

    /// Selling less of the same intent at the same rate is never worse either,
    /// which is what makes a partial fill safe to allow at all.
    function testFuzz_aSmallerPartialFillAtTheSameRateStillClears(
        uint128 executedBuy,
        uint128 sellAmount,
        uint128 minBuyAmount,
        uint128 executedSell,
        uint128 smaller
    ) public pure {
        vm.assume(smaller <= executedSell);
        vm.assume(ClearingMath.limitRespected(executedBuy, sellAmount, minBuyAmount, executedSell));

        assertTrue(
            ClearingMath.limitRespected(executedBuy, sellAmount, minBuyAmount, smaller),
            "shrinking the sell side broke a limit that held"
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

    /// Widening the band never excludes a price it already accepted.
    function testFuzz_awiderBandNeverRefusesWhatANarrowerOneAccepted(
        uint128 price,
        uint128 ref,
        uint16 narrow,
        uint16 wide
    ) public pure {
        vm.assume(narrow <= wide);
        vm.assume(ClearingMath.withinBand(price, ref, narrow));

        assertTrue(ClearingMath.withinBand(price, ref, wide), "a wider band refused what a narrower one took");
    }
}
