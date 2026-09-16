// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IClearingVerifier} from "./interfaces/IClearingVerifier.sol";

/// @title Solidity clearing verifier
/// @notice Checks validity, never optimality. Optimality comes from competition,
/// measured against a venue quote in the same block, so a lazy solution does not
/// need to be proven bad. It simply loses. See desain-kliring.md section 6.2.
///
/// Every limit check is a cross multiplication. There is no division anywhere on
/// the limit path, which removes rounding from the one place a clearing bug
/// usually hides.
///
/// This is the default path. The Stylus port is a benchmark decision, not a
/// deadline decision, and nothing here depends on it landing.
contract ClearingVerifier is IClearingVerifier {
    uint256 internal constant INTENT_STRIDE = 72;
    uint256 internal constant EXECUTION_STRIDE = 72;
    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;

    error MalformedPackedIntents(uint256 length);
    error MalformedPackedExecutions(uint256 length);
    error ArrayLengthMismatch();
    error IntentIndexOutOfRange(uint256 intentIndex);
    error TokenIndexOutOfRange(uint16 tokenIndex);
    error OverfilledIntent(uint256 intentIndex, uint256 executedSell, uint256 sellAmount);
    error PartialFillNotAllowed(uint256 intentIndex);
    error LimitViolated(uint256 intentIndex);
    error NonUniformPrice(uint256 intentIndex);
    error ValueNotConserved(uint16 tokenIndex, int256 delta);
    error PriceOutsideBand(uint16 tokenIndex, uint256 price, uint256 ref, uint16 maxBps);
    error WorseThanBaseline(uint256 intentIndex, uint256 executedBuy, uint256 baselineBuy);
    error ReservedBytesNotZero(uint256 index);

    struct PackedIntent {
        uint16 sellTokenIndex;
        uint16 buyTokenIndex;
        uint8 flags;
        uint256 sellAmount;
        uint256 minBuyAmount;
    }

    struct PackedExecution {
        uint32 intentIndex;
        uint256 executedSell;
        uint256 executedBuy;
    }

    uint8 internal constant FLAG_PARTIAL_FILL = 1;

    /// evaluateVolume reads one pair at a time, with the numeraire at index 0.
    /// desain-kliring.md section 8 prices every token in USDG, so the quote side of
    /// any pair is the USDG side.
    uint16 internal constant QUOTE_TOKEN_INDEX = 0;

    /// @inheritdoc IClearingVerifier
    function verify(
        bytes calldata packedIntents,
        bytes calldata packedExecutions,
        address[] calldata tokens,
        uint256[] calldata prices,
        int256[] calldata venueDeltas,
        uint256[] calldata oraclePrices,
        uint256[] calldata baselineQuotes,
        uint16 maxDeviationBps
    ) external pure returns (uint256 savings) {
        if (packedIntents.length % INTENT_STRIDE != 0) {
            revert MalformedPackedIntents(packedIntents.length);
        }
        if (packedExecutions.length % EXECUTION_STRIDE != 0) {
            revert MalformedPackedExecutions(packedExecutions.length);
        }
        if (tokens.length != prices.length || tokens.length != venueDeltas.length) {
            revert ArrayLengthMismatch();
        }
        if (tokens.length != oraclePrices.length) revert ArrayLengthMismatch();

        uint256 intentCount = packedIntents.length / INTENT_STRIDE;
        uint256 executionCount = packedExecutions.length / EXECUTION_STRIDE;
        if (baselineQuotes.length != executionCount) revert ArrayLengthMismatch();

        _checkBand(prices, oraclePrices, maxDeviationBps);

        uint256[] memory pulled = new uint256[](tokens.length);
        uint256[] memory delivered = new uint256[](tokens.length);

        for (uint256 k = 0; k < executionCount; ++k) {
            PackedExecution memory e = _execution(packedExecutions, k);
            if (e.intentIndex >= intentCount) revert IntentIndexOutOfRange(e.intentIndex);

            PackedIntent memory i = _intent(packedIntents, e.intentIndex);
            if (i.sellTokenIndex >= tokens.length) revert TokenIndexOutOfRange(i.sellTokenIndex);
            if (i.buyTokenIndex >= tokens.length) revert TokenIndexOutOfRange(i.buyTokenIndex);

            if (e.executedSell > i.sellAmount) {
                revert OverfilledIntent(e.intentIndex, e.executedSell, i.sellAmount);
            }
            if (e.executedSell != i.sellAmount && i.flags & FLAG_PARTIAL_FILL == 0) {
                revert PartialFillNotAllowed(e.intentIndex);
            }

            // b * S >= B * s, the limit as a cross multiplication.
            if (e.executedBuy * i.sellAmount < i.minBuyAmount * e.executedSell) {
                revert LimitViolated(e.intentIndex);
            }

            _checkUniformPrice(e, prices[i.sellTokenIndex], prices[i.buyTokenIndex]);

            if (e.executedBuy < baselineQuotes[k]) {
                revert WorseThanBaseline(e.intentIndex, e.executedBuy, baselineQuotes[k]);
            }

            pulled[i.sellTokenIndex] += e.executedSell;
            delivered[i.buyTokenIndex] += e.executedBuy;

            savings += ((e.executedBuy - baselineQuotes[k]) * prices[i.buyTokenIndex]) / WAD;
        }

        _checkConservation(pulled, delivered, venueDeltas);
    }

    /// @inheritdoc IClearingVerifier
    function evaluateVolume(bytes calldata packedIntents, uint256 price)
        external
        pure
        returns (uint256 demand, uint256 supply, uint256 executable)
    {
        if (packedIntents.length % INTENT_STRIDE != 0) {
            revert MalformedPackedIntents(packedIntents.length);
        }
        uint256 count = packedIntents.length / INTENT_STRIDE;

        for (uint256 n = 0; n < count; ++n) {
            PackedIntent memory i = _intent(packedIntents, n);
            // Buyers spend the quote token and want the base token. Their limit
            // price is sellAmount / minBuyAmount, so they accept p when
            // sellAmount >= minBuyAmount * p, written without a division.
            if (i.sellTokenIndex == QUOTE_TOKEN_INDEX) {
                if (i.sellAmount * WAD >= i.minBuyAmount * price) demand += i.minBuyAmount;
            } else {
                if (i.minBuyAmount * WAD <= i.sellAmount * price) supply += i.sellAmount;
            }
        }
        executable = demand < supply ? demand : supply;
    }

    /// @dev Every execution must settle at the same per token price, so the value
    /// leaving equals the value entering up to one unit of the bought token. The
    /// remainder rounds toward the contract, never toward the solver.
    function _checkUniformPrice(PackedExecution memory e, uint256 sellPrice, uint256 buyPrice) internal pure {
        uint256 valueIn = e.executedSell * sellPrice;
        uint256 valueOut = e.executedBuy * buyPrice;
        if (valueOut > valueIn) revert NonUniformPrice(e.intentIndex);
        if (valueIn - valueOut >= buyPrice) revert NonUniformPrice(e.intentIndex);
    }

    function _checkBand(uint256[] calldata prices, uint256[] calldata oraclePrices, uint16 maxDeviationBps)
        internal
        pure
    {
        // Token index fits uint16 because the packed intent addresses it with two
        // bytes, so a longer token array could not be referenced at all.
        for (uint16 t = 0; t < prices.length; ++t) {
            uint256 ref = oraclePrices[t];
            uint256 p = prices[t];
            uint256 diff = p > ref ? p - ref : ref - p;
            if (diff * BPS > ref * maxDeviationBps) {
                revert PriceOutsideBand(t, p, ref, maxDeviationBps);
            }
        }
    }

    function _checkConservation(
        uint256[] memory pulled,
        uint256[] memory delivered,
        int256[] calldata venueDeltas
    ) internal pure {
        for (uint16 t = 0; t < pulled.length; ++t) {
            int256 balance = int256(pulled[t]) + venueDeltas[t] - int256(delivered[t]);
            if (balance < 0) revert ValueNotConserved(t, balance);
        }
    }

    function _intent(bytes calldata packed, uint256 index) internal pure returns (PackedIntent memory i) {
        uint256 offset = index * INTENT_STRIDE;
        bytes calldata word = packed[offset:offset + INTENT_STRIDE];
        i.sellTokenIndex = uint16(bytes2(word[0:2]));
        i.buyTokenIndex = uint16(bytes2(word[2:4]));
        i.flags = uint8(word[4]);
        if (uint256(bytes32(word[5:8])) >> 232 != 0) revert ReservedBytesNotZero(index);
        i.sellAmount = uint256(bytes32(word[8:40]));
        i.minBuyAmount = uint256(bytes32(word[40:72]));
    }

    function _execution(bytes calldata packed, uint256 index)
        internal
        pure
        returns (PackedExecution memory e)
    {
        uint256 offset = index * EXECUTION_STRIDE;
        bytes calldata word = packed[offset:offset + EXECUTION_STRIDE];
        e.intentIndex = uint32(bytes4(word[0:4]));
        if (uint32(bytes4(word[4:8])) != 0) revert ReservedBytesNotZero(index);
        e.executedSell = uint256(bytes32(word[8:40]));
        e.executedBuy = uint256(bytes32(word[40:72]));
    }
}
