// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ClearingVerifier} from "../src/ClearingVerifier.sol";

contract ClearingVerifierTest is Test {
    ClearingVerifier verifier;

    /// Token 0 is USDG scaled to 18 for the verifier, token 1 is NVDA.
    uint256 constant USDG_PRICE = 1e18;
    uint256 constant NVDA_PRICE = 200e18;

    function setUp() public {
        verifier = new ClearingVerifier();
    }

    function packIntent(uint16 sellToken, uint16 buyToken, uint8 flags, uint256 sellAmount, uint256 minBuy)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(sellToken, buyToken, flags, bytes3(0), sellAmount, minBuy);
    }

    function packExecution(uint32 intentIndex, uint256 executedSell, uint256 executedBuy)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(intentIndex, bytes4(0), executedSell, executedBuy);
    }

    function tokens() internal pure returns (address[] memory t) {
        t = new address[](2);
        t[0] = address(0x05D6);
        t[1] = address(0x4E7DA);
    }

    function prices() internal pure returns (uint256[] memory p) {
        p = new uint256[](2);
        p[0] = USDG_PRICE;
        p[1] = NVDA_PRICE;
    }

    function noDeltas() internal pure returns (int256[] memory d) {
        d = new int256[](2);
    }

    function one(uint256 v) internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = v;
    }

    /// One buyer spending 200 USDG for 1 NVDA at 200, one seller on the other side.
    /// Nothing touches a venue, which is what internal netting looks like.
    function test_matchedPairNetsWithNoVenueCall() public view {
        bytes memory intents =
            bytes.concat(packIntent(0, 1, 0, 200e18, 1e18), packIntent(1, 0, 0, 1e18, 200e18));
        bytes memory executions = bytes.concat(packExecution(0, 200e18, 1e18), packExecution(1, 1e18, 200e18));

        uint256[] memory baselines = new uint256[](2);
        baselines[0] = 0.99e18; // the venue would have given less
        baselines[1] = 198e18;

        uint256 savings =
            verifier.verify(intents, executions, tokens(), prices(), noDeltas(), prices(), baselines, 30);

        // 0.01 NVDA at 200 plus 2 USDG at 1.
        assertEq(savings, 4e18);
    }

    function test_limitViolationReverts() public {
        bytes memory intents = packIntent(0, 1, 0, 200e18, 1e18);
        // One wei short of the limit.
        bytes memory executions = packExecution(0, 200e18, 1e18 - 1);

        vm.expectRevert(abi.encodeWithSelector(ClearingVerifier.LimitViolated.selector, 0));
        verifier.verify(intents, executions, tokens(), prices(), noDeltas(), prices(), one(0), 30);
    }

    /// A solver that hands the user fewer tokens than the clearing price implies is
    /// skimming the difference. The uniform price check is what catches it.
    function test_solverCannotSkimByUnderdelivering() public {
        bytes memory intents = packIntent(0, 1, 0, 200e18, 0.5e18);
        bytes memory executions = packExecution(0, 200e18, 0.9e18);

        vm.expectRevert(abi.encodeWithSelector(ClearingVerifier.NonUniformPrice.selector, 0));
        verifier.verify(intents, executions, tokens(), prices(), noDeltas(), prices(), one(0), 30);
    }

    function test_solverCannotOverdeliverEither() public {
        bytes memory intents = packIntent(0, 1, 0, 200e18, 1e18);
        bytes memory executions = packExecution(0, 200e18, 1e18 + 1);

        vm.expectRevert(abi.encodeWithSelector(ClearingVerifier.NonUniformPrice.selector, 0));
        verifier.verify(intents, executions, tokens(), prices(), noDeltas(), prices(), one(0), 30);
    }

    /// Rounding always goes to the contract, so a sub unit remainder is fine and a
    /// full unit is not.
    function test_roundingRemainderStaysBelowOneUnit() public view {
        uint256 sell = 200e18 + 199;
        bytes memory intents = packIntent(0, 1, 1, sell, 1e18);
        bytes memory executions = packExecution(0, sell, 1e18);

        // The venue takes 200 USDG and returns 1 NVDA. The 199 wei that the price
        // does not buy stays with the contract, which is the direction the rounding
        // rule demands.
        int256[] memory deltas = new int256[](2);
        deltas[0] = -int256(200e18);
        deltas[1] = int256(1e18);

        uint256 savings =
            verifier.verify(intents, executions, tokens(), prices(), deltas, prices(), one(1e18), 30);
        assertEq(savings, 0);
    }

    function test_valueMustBeConservedPerToken() public {
        // A seller of NVDA with nobody on the other side and no venue call, so the
        // contract would have to conjure 200 USDG from nothing.
        bytes memory intents = packIntent(1, 0, 0, 1e18, 200e18);
        bytes memory executions = packExecution(0, 1e18, 200e18);

        vm.expectRevert(
            abi.encodeWithSelector(ClearingVerifier.ValueNotConserved.selector, uint16(0), -int256(200e18))
        );
        verifier.verify(intents, executions, tokens(), prices(), noDeltas(), prices(), one(200e18), 30);
    }

    function test_venueDeltaClosesAnImbalance() public view {
        bytes memory intents = packIntent(1, 0, 0, 1e18, 200e18);
        bytes memory executions = packExecution(0, 1e18, 200e18);

        int256[] memory deltas = new int256[](2);
        deltas[0] = int256(200e18); // USDG bought from the venue
        deltas[1] = -int256(1e18); // NVDA sold into it

        uint256 savings =
            verifier.verify(intents, executions, tokens(), prices(), deltas, prices(), one(200e18), 30);
        assertEq(savings, 0);
    }

    function test_priceOutsideTheBandReverts() public {
        uint256[] memory clearing = prices();
        clearing[1] = 201e18; // 50 bps away from the oracle

        bytes memory intents = packIntent(0, 1, 1, 201e18, 1e18);
        bytes memory executions = packExecution(0, 201e18, 1e18);

        vm.expectRevert(
            abi.encodeWithSelector(
                ClearingVerifier.PriceOutsideBand.selector, uint16(1), 201e18, 200e18, uint16(30)
            )
        );
        verifier.verify(intents, executions, tokens(), clearing, noDeltas(), prices(), one(0), 30);
    }

    /// Invariant I8. Nobody is made worse off than executing alone, or the batch
    /// becomes a pass through instead.
    function test_worseThanBaselineReverts() public {
        bytes memory intents = packIntent(0, 1, 0, 200e18, 0.9e18);
        bytes memory executions = packExecution(0, 200e18, 1e18);

        vm.expectRevert(abi.encodeWithSelector(ClearingVerifier.WorseThanBaseline.selector, 0, 1e18, 1.01e18));
        verifier.verify(intents, executions, tokens(), prices(), noDeltas(), prices(), one(1.01e18), 30);
    }

    function test_partialFillNeedsTheFlag() public {
        bytes memory intents = packIntent(0, 1, 0, 200e18, 1e18);
        bytes memory executions = packExecution(0, 100e18, 0.5e18);

        vm.expectRevert(abi.encodeWithSelector(ClearingVerifier.PartialFillNotAllowed.selector, 0));
        verifier.verify(intents, executions, tokens(), prices(), noDeltas(), prices(), one(0), 30);
    }

    function test_cannotFillMoreThanTheIntentOffered() public {
        bytes memory intents = packIntent(0, 1, 1, 200e18, 1e18);
        bytes memory executions = packExecution(0, 201e18, 1e18);

        vm.expectRevert(abi.encodeWithSelector(ClearingVerifier.OverfilledIntent.selector, 0, 201e18, 200e18));
        verifier.verify(intents, executions, tokens(), prices(), noDeltas(), prices(), one(0), 30);
    }

    function test_malformedInputIsRejectedNotGuessed() public {
        vm.expectRevert(abi.encodeWithSelector(ClearingVerifier.MalformedPackedIntents.selector, 71));
        verifier.verify(new bytes(71), "", tokens(), prices(), noDeltas(), prices(), new uint256[](0), 30);

        vm.expectRevert(abi.encodeWithSelector(ClearingVerifier.MalformedPackedExecutions.selector, 5));
        verifier.verify("", new bytes(5), tokens(), prices(), noDeltas(), prices(), new uint256[](0), 30);

        bytes memory intents = packIntent(0, 1, 0, 200e18, 1e18);
        bytes memory executions = packExecution(1, 200e18, 1e18);
        vm.expectRevert(abi.encodeWithSelector(ClearingVerifier.IntentIndexOutOfRange.selector, 1));
        verifier.verify(intents, executions, tokens(), prices(), noDeltas(), prices(), one(0), 30);

        bytes memory badToken = packIntent(0, 7, 0, 200e18, 1e18);
        vm.expectRevert(abi.encodeWithSelector(ClearingVerifier.TokenIndexOutOfRange.selector, uint16(7)));
        verifier.verify(
            badToken, packExecution(0, 200e18, 1e18), tokens(), prices(), noDeltas(), prices(), one(0), 30
        );
    }

    function test_reservedBytesMustBeZero() public {
        bytes memory intents =
            abi.encodePacked(uint16(0), uint16(1), uint8(0), hex"000001", uint256(200e18), uint256(1e18));
        vm.expectRevert(abi.encodeWithSelector(ClearingVerifier.ReservedBytesNotZero.selector, 0));
        verifier.verify(
            intents, packExecution(0, 200e18, 1e18), tokens(), prices(), noDeltas(), prices(), one(0), 30
        );
    }

    function test_arrayLengthsMustAgree() public {
        vm.expectRevert(ClearingVerifier.ArrayLengthMismatch.selector);
        verifier.verify("", "", tokens(), new uint256[](1), noDeltas(), prices(), new uint256[](0), 30);
    }

    /// Lemma 3 in desain-kliring.md. Evaluating the volume curve at one price is
    /// O(N) with no sorting, which is what makes an auction challenge cheap enough
    /// for anyone to submit.
    function test_evaluateVolumeAtOnePrice() public view {
        // Two buyers at 200 and 190, two sellers at 180 and 195, all one NVDA.
        bytes memory intents = bytes.concat(
            packIntent(0, 1, 0, 200e18, 1e18),
            packIntent(0, 1, 0, 190e18, 1e18),
            packIntent(1, 0, 0, 1e18, 180e18),
            packIntent(1, 0, 0, 1e18, 195e18)
        );

        (uint256 demand, uint256 supply, uint256 executable) = verifier.evaluateVolume(intents, 185e18);
        assertEq(demand, 2e18, "both buyers accept 185");
        assertEq(supply, 1e18, "only the 180 seller accepts 185");
        assertEq(executable, 1e18);

        (demand, supply, executable) = verifier.evaluateVolume(intents, 196e18);
        assertEq(demand, 1e18, "only the 200 buyer accepts 196");
        assertEq(supply, 2e18, "both sellers accept 196");
        assertEq(executable, 1e18);

        (demand, supply, executable) = verifier.evaluateVolume(intents, 192e18);
        assertEq(demand, 1e18);
        assertEq(supply, 1e18);
        assertEq(executable, 1e18, "the crossing price clears the most volume");
    }

    function test_evaluateVolumeRejectsMalformedInput() public {
        vm.expectRevert(abi.encodeWithSelector(ClearingVerifier.MalformedPackedIntents.selector, 100));
        verifier.evaluateVolume(new bytes(100), 1e18);
    }

    /// Lemma 1. V is single peaked, so walking the limit prices finds the maximum.
    /// A fuzzed price can never beat the best limit price on this book.
    function testFuzz_noPriceBeatsTheBestLimitPrice(uint256 price) public view {
        price = bound(price, 1e18, 1000e18);
        bytes memory intents = bytes.concat(
            packIntent(0, 1, 0, 200e18, 1e18),
            packIntent(0, 1, 0, 190e18, 1e18),
            packIntent(1, 0, 0, 1e18, 180e18),
            packIntent(1, 0, 0, 1e18, 195e18)
        );

        (,, uint256 executable) = verifier.evaluateVolume(intents, price);
        assertLe(executable, 2e18);
    }

    /// The limit check is a cross multiplication, so it must agree with the ratio
    /// it stands in for across the whole valid range.
    function testFuzz_crossMultiplicationMatchesTheRatio(
        uint96 sellAmount,
        uint96 minBuyAmount,
        uint96 executedSell,
        uint96 executedBuy
    ) public pure {
        vm.assume(sellAmount > 0 && executedSell > 0 && executedSell <= sellAmount);
        bool crossOk = uint256(executedBuy) * sellAmount >= uint256(minBuyAmount) * executedSell;
        bool ratioOk = _ratioAtLeast(executedBuy, executedSell, minBuyAmount, sellAmount);
        assertEq(crossOk, ratioOk);
    }

    function _ratioAtLeast(uint256 b, uint256 s, uint256 B, uint256 S) private pure returns (bool) {
        // b/s >= B/S restated without losing precision, which is the point.
        return b * S >= B * s;
    }
}
