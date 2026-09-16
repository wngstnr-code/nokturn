// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

enum Session {
    CLOSED_OVERNIGHT,
    PRE_MARKET,
    AUCTION_OPEN,
    OPEN,
    AUCTION_CLOSE,
    POST_MARKET,
    CLOSED_WEEKEND,
    HOLIDAY,
    PROTECTIVE
}

enum IntentKind {
    SPOT,
    MOO,
    LOO,
    ROO
}

library IntentFlags {
    uint8 internal constant PARTIAL_FILL = 1 << 0;
    uint8 internal constant AGENT_SIGNED = 1 << 1;
    uint8 internal constant AUCTION = 1 << 2;
}

library SessionMask {
    uint8 internal constant CLOSED_OVERNIGHT = 1 << 0;
    uint8 internal constant PRE_MARKET = 1 << 1;
    uint8 internal constant AUCTION_OPEN = 1 << 2;
    uint8 internal constant OPEN = 1 << 3;
    uint8 internal constant AUCTION_CLOSE = 1 << 4;
    uint8 internal constant POST_MARKET = 1 << 5;
    uint8 internal constant CLOSED_WEEKEND = 1 << 6;
    uint8 internal constant HOLIDAY = 1 << 7;

    /// PROTECTIVE has no bit. An intent can never opt into a session the protocol
    /// enters only because it stopped trusting its own inputs.
    function bit(Session s) internal pure returns (uint8) {
        if (s == Session.PROTECTIVE) return 0;
        return uint8(2 ** uint256(uint8(s)));
    }
}

struct Intent {
    address owner;
    address receiver;
    address sellToken;
    address buyToken;
    uint256 sellAmount;
    uint256 minBuyAmount;
    uint32 validAfter;
    uint32 validUntil;
    uint8 flags;
    uint8 kind;
    uint16 maxDevFromRefBps;
    uint8 allowedSessions;
    uint16 batchSpan;
    uint256 nonce;
}

struct Execution {
    uint256 intentIndex;
    uint256 executedSell;
    uint256 executedBuy;
}

/// A venue call is structured rather than raw calldata. An allowlisted adapter
/// plus arbitrary bytes would let a solver call anything on that adapter, and it
/// would also make the venue delta impossible to derive, so the contract would
/// have to trust the number it is supposed to be checking.
struct VenueCall {
    address adapter;
    address tokenIn;
    address tokenOut;
    uint256 amountIn;
    uint256 minOut;
}

struct Solution {
    uint64 batchId;
    Intent[] intents;
    bytes[] signatures;
    address[] tokens;
    uint256[] prices;
    Execution[] executions;
    VenueCall[] venueCalls;
    /// One entry per Execution, parallel to `executions`. Not one per pair: the
    /// baseline depends on size because of slippage, so a single number per pair
    /// cannot produce the per intent baselineBuy that IntentSettled carries.
    uint256[] baselineQuotes;
    uint256 claimedSavings;
    address solver;
}

struct Mandate {
    address owner;
    address agent;
    address[] allowedTokens;
    uint256 maxNotionalPerBatch;
    uint256 maxNotionalPerDay;
    uint16 maxDeviationFromRefBps;
    uint8 allowedSessions;
    uint64 expiry;
    bool auctionAllowed;
}
