// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ClearingMath} from "../../src/libraries/ClearingMath.sol";

/// @notice Pro rata rounding and value conservation, from rencana-uji.md section 4.
///
/// AuctionHouse does not allocate a book itself. A solver names the fills and the
/// contract checks them, so the property that matters is not that some allocator
/// divides fairly. It is that the floored conversion every fill is measured against
/// cannot be made to hand out more than the one number it is dividing, however the
/// solver splits it. That is what makes a cross safe to accept from a stranger.
///
/// The claim rests on two facts. Pricing distributes over a split, and flooring the
/// parts never gains on flooring the whole. Both are proved below. The composed
/// statement is stated below them as well, and the naming says which is which,
/// because the solver reaches one and not the other.
///
/// Why the split. A testFuzz name is run symbolically by tools/halmos.sh and is a
/// proof over the whole stated range. A testBound name is run by forge as a bounded
/// fuzz test and is not.
///
/// The line between them is one measured fact. The solver closes a division when the
/// number being divided is under roughly 2 to the 65 and does not when it is over
/// roughly 2 to the 73, and the wall is on that dividend rather than on the width of
/// the inputs. Measured 20 September 2026 against four solvers, three shapes of the
/// same statement and every width solidity offers. test/halmos/DivisionWall.t.sol
/// holds the probes, rencana-uji.md section 4.1 holds the numbers.
///
/// An allowlist amount at the batch cap times a stock token price is about 2 to the
/// 139, so nothing the solver reaches covers the range this protocol runs in, and
/// stating a proof over a narrow width as if it covered the wide one would be the
/// kind of claim this repo exists to avoid making.
contract AuctionMathProofs is Test {
    uint256 internal constant WAD = 1e18;

    /// Pricing distributes over a split fill. Two fills priced separately carry the
    /// same value as one fill of their sum, before any rounding happens. This is the
    /// half of pro rata safety that involves no division, and the solver closes it
    /// over the full range in under a second.
    function testFuzz_pricingDistributesOverASplitFill(uint128 a, uint128 b, uint128 price) public pure {
        vm.assume(uint256(a) + b <= type(uint128).max);

        assertEq(
            uint256(a) * price + uint256(b) * price,
            (uint256(a) + b) * price,
            "splitting a fill changed the value being priced"
        );
    }

    /// Flooring the parts never gains on flooring the whole, and falls short by at
    /// most one unit per part. The first half is what stops a book handing out more
    /// than it holds. The second is the bound submitCross relies on when it accepts
    /// an executed volume up to e.length below the matchable number, so that
    /// tolerance is a consequence rather than a number somebody chose.
    ///
    /// Stated over uint64 because the sum is then at most 2 to the 65, which is the
    /// side of the wall the solver closes on. See the note on this contract.
    function testFuzz_flooringASplitNeverGainsOnFlooringTheWhole(uint64 x, uint64 y) public pure {
        uint256 whole = (uint256(x) + y) / WAD;
        uint256 split = uint256(x) / WAD + uint256(y) / WAD;

        assertLe(split, whole, "two floored parts took more than the floored whole");
        assertLe(whole - split, 1, "the shortfall from two parts passed one unit");
    }

    /// The conservation arithmetic never lies about its sign. Both sides are uint128
    /// and the venue leg is int128, so nothing here can wrap into a positive balance
    /// that is really a deficit. This is the one that would hide a drain, because
    /// the check ClearingVerifier runs is a comparison against zero on a signed
    /// value. No division, so the solver closes it over the full range.
    function testFuzz_conservationNeverWrapsIntoAFalsePositive(
        uint128 pulled,
        uint128 delivered,
        int128 venueDelta
    ) public pure {
        int256 balance = ClearingMath.conserved(pulled, venueDelta, delivered);
        int256 honest = int256(uint256(pulled)) + int256(venueDelta) - int256(uint256(delivered));

        assertEq(balance, honest, "the balance was not the difference it claims to be");
        assertEq(balance >= 0, honest >= 0, "the sign of the balance was wrong");
    }

    /// A batch that pulled nothing and routed nothing can deliver nothing. The base
    /// case, and the one a mutation dropping the subtraction would break.
    function testFuzz_nothingPulledMeansNothingCanBeDelivered(uint128 delivered) public pure {
        vm.assume(delivered > 0);

        assertLt(ClearingMath.conserved(0, 0, delivered), 0, "a batch delivered out of an empty pool");
    }

    /// The composed statement at the width whose dividend fits under the wall. The
    /// product is formed before the division, so uint32 inputs already put a 2 to the
    /// 64 number in front of it and uint64 inputs put 2 to the 129 there. That is why
    /// this is narrower than the lemma above rather than the same width.
    ///
    /// Narrow, and not nothing. It is the only symbolic evidence that the two lemmas
    /// compose in the direction claimed, which a fuzz sample cannot give.
    function testFuzz_splittingAFillNeverAllocatesMoreThanTheWhole(uint32 a, uint32 b, uint32 price)
        public
        pure
    {
        uint256 whole = ClearingMath.quoteOf(uint256(a) + b, price);
        uint256 split = ClearingMath.quoteOf(a, price) + ClearingMath.quoteOf(b, price);

        assertLe(split, whole, "two fills took more than the book they came from");
        assertLe(whole - split, 1, "the dust from two fills passed one unit");
    }

    /// The same statement over the width the protocol runs in. It follows from the
    /// three proofs above, and forge samples it here because the solver times out on
    /// the combined form at this width rather than refuting it.
    function testBound_splittingAFillNeverAllocatesMoreThanTheWhole(uint128 a, uint128 b, uint128 price)
        public
        pure
    {
        vm.assume(uint256(a) + b <= type(uint128).max);

        uint256 whole = ClearingMath.quoteOf(uint256(a) + b, price);
        uint256 split = ClearingMath.quoteOf(a, price) + ClearingMath.quoteOf(b, price);

        assertLe(split, whole, "two fills took more than the book they came from");
        assertLe(whole - split, 1, "the dust from two fills passed one unit");
    }

    /// The same statement on the other conversion. A buy side fill is measured by
    /// tokenOf and a sell side fill by quoteOf, so the guarantee has to hold both
    /// ways. This one divides by a symbolic price rather than by a constant, which
    /// is further out of the solver's reach than the constant case.
    function testBound_splittingAQuoteNeverBuysMoreThanTheWhole(uint128 a, uint128 b, uint128 price)
        public
        pure
    {
        vm.assume(price > 0);
        vm.assume(uint256(a) + b <= type(uint128).max);

        uint256 whole = ClearingMath.tokenOf(uint256(a) + b, price);
        uint256 split = ClearingMath.tokenOf(a, price) + ClearingMath.tokenOf(b, price);

        assertLe(split, whole, "two buyers took more token than their quote bought");
        assertLe(whole - split, 1, "the dust from two buys passed one unit");
    }

    /// A round trip never gains. Converting a token amount to quote and back cannot
    /// produce more token than was there, at any price. A conversion that could
    /// would let a solver mint value by routing a fill through the unit it is
    /// priced in.
    function testBound_aRoundTripThroughThePriceNeverGains(uint128 tokenAmount, uint128 price) public pure {
        vm.assume(price > 0);

        assertLe(
            ClearingMath.tokenOf(ClearingMath.quoteOf(tokenAmount, price), price),
            tokenAmount,
            "a round trip produced more than it started with"
        );
    }

    /// And in the other order. Both directions floor, so neither is the safe one to
    /// trust and the guarantee has to be stated twice.
    function testBound_aRoundTripThroughTheTokenNeverGains(uint128 quoteAmount, uint128 price) public pure {
        vm.assume(price > 0);

        assertLe(
            ClearingMath.quoteOf(ClearingMath.tokenOf(quoteAmount, price), price),
            quoteAmount,
            "a round trip produced more than it started with"
        );
    }

    /// Value conservation under the worst rounding the protocol can produce, over
    /// the check ClearingVerifier actually runs. Two fills are paid out of one
    /// converted pool, each floored on its own, and the pool is never short.
    function testBound_payingFlooredFillsOutOfOnePoolAlwaysConserves(uint128 a, uint128 b, uint128 price)
        public
        pure
    {
        vm.assume(uint256(a) + b <= type(uint128).max);

        uint256 pool = ClearingMath.quoteOf(uint256(a) + b, price);
        uint256 delivered = ClearingMath.quoteOf(a, price) + ClearingMath.quoteOf(b, price);

        assertGe(ClearingMath.conserved(pool, 0, delivered), 0, "a batch delivered more than it was given");
    }
}
