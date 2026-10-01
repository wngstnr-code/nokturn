// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ClearingMath} from "../../src/libraries/ClearingMath.sol";

/// @notice The rounding lemmas at the width the protocol runs in, run by
/// tools/halmos.sh with the cvc5-int solver rather than yices.
///
/// The wall in rencana-uji.md section 4.1 belonged to the bitvector encoding, not
/// to the statements. cvc5-int reasons over integers, where dividing by a constant
/// is linear, and closes each lemma here in under a second at full width. Before
/// trusting that, it was shown three false statements, and it refuted all three
/// with valid counterexamples, one of them the wrap at 2 to the 256 minus one.
/// Measured 29 September 2026.
///
/// What this closes is a chain, not one query. The composed statements in
/// AuctionMathProofs still time out as a single query, because a product of two
/// symbolic values is nonlinear. Each follows from lemmas proved here and there by
/// substituting a product for a variable, and that substitution is the one step
/// no solver checks. rencana-uji.md section 4.1 writes the chains out.
///
/// Splitting a quote through tokenOf closed on 1 October 2026, directly and without a
/// chain. It had timed out because the two bounds were asked as one query. Asked
/// apart, each closes in under a second.
contract RoundingProofs is Test {
    uint256 internal constant WAD = 1e18;

    /// Flooring two parts never gains on flooring their sum, and falls short by at
    /// most one, for any dividends whose sum does not wrap. With x and y set to a
    /// times price and b times price, and distributivity from AuctionMathProofs, this
    /// is the pro rata split over quoteOf at uint128.
    function testFuzz_flooringASplitNeverGainsAtFullWidth(uint256 x, uint256 y) public pure {
        vm.assume(x <= type(uint256).max - y);

        uint256 whole = (x + y) / WAD;
        uint256 split = x / WAD + y / WAD;

        assertLe(split, whole, "two floored parts took more than the floored whole");
        assertLe(whole - split, 1, "the shortfall from two parts passed one unit");
    }

    /// The same lemma with the divisor symbolic rather than WAD, at full width. This
    /// is the floor lemma rencana-uji.md section 4.1 once recorded as closing on no
    /// solver.
    function testFuzz_flooringASplitNeverGainsForAnyDivisor(uint256 x, uint256 y, uint256 d) public pure {
        vm.assume(d > 0);
        vm.assume(x <= type(uint256).max - y);

        assertLe(x / d + y / d, (x + y) / d, "two floored parts took more than the floored whole");
    }

    /// Its other half, kept as a query of its own. Joined to the one above, the pair
    /// times out.
    function testFuzz_theShortfallFromASplitIsAtMostOneForAnyDivisor(uint256 x, uint256 y, uint256 d)
        public
        pure
    {
        vm.assume(d > 0);
        vm.assume(x <= type(uint256).max - y);

        assertLe((x + y) / d - (x / d + y / d), 1, "the shortfall from two parts passed one unit");
    }

    /// The pro rata split over tokenOf itself, at the width the protocol runs in.
    function testFuzz_splittingAQuoteThroughTheTokenNeverGains(uint128 a, uint128 b, uint128 price)
        public
        pure
    {
        vm.assume(price > 0);

        assertLe(
            ClearingMath.tokenOf(a, price) + ClearingMath.tokenOf(b, price),
            ClearingMath.tokenOf(uint256(a) + b, price),
            "two token amounts took more than the token amount of their sum"
        );
    }

    /// First step of the round trip through the price. Flooring and scaling back
    /// never overshoots.
    function testFuzz_flooringThenScalingNeverOvershoots(uint256 x, uint256 d) public pure {
        vm.assume(d > 0);

        assertLe((x / d) * d, x, "a floored quotient scaled back passed the dividend");
    }

    /// Second step. A smaller dividend never floors to a larger quotient.
    function testFuzz_flooringIsMonotone(uint256 z, uint256 w, uint256 d) public pure {
        vm.assume(d > 0);
        vm.assume(z <= w);

        assertLe(z / d, w / d, "a smaller dividend floored to more");
    }

    /// Third step. Multiplying by the price and dividing by it again is exact. With
    /// the two above this is the round trip through the price at uint128.
    function testFuzz_scalingByThePriceAndBackIsExact(uint128 amount, uint128 price) public pure {
        vm.assume(price > 0);

        assertEq((uint256(amount) * price) / price, amount, "the price did not cancel");
    }

    /// Closed directly, with no chain. Moved here from AuctionMathProofs, where it was
    /// a bounded fuzz because yices timed out on it.
    function testFuzz_aRoundTripThroughTheTokenNeverGains(uint128 quoteAmount, uint128 price) public pure {
        vm.assume(price > 0);

        assertLe(
            ClearingMath.quoteOf(ClearingMath.tokenOf(quoteAmount, price), price),
            quoteAmount,
            "a round trip produced more than it started with"
        );
    }

    /// The sign lemma at the width a converted pool reaches. A uint128 amount times a
    /// uint128 price over WAD stays under 2 to the 197, which AuctionMathProofs does
    /// not cover because it states the lemma over uint128.
    function testFuzz_conservationNeverWrapsAtPoolWidth(uint248 pulled, uint248 delivered, int128 venueDelta)
        public
        pure
    {
        int256 balance = ClearingMath.conserved(pulled, venueDelta, delivered);
        int256 honest = int256(uint256(pulled)) + int256(venueDelta) - int256(uint256(delivered));

        assertEq(balance, honest, "the balance was not the difference it claims to be");
        assertEq(balance >= 0, honest >= 0, "the sign of the balance was wrong");
    }
}
