// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {AgentMandate} from "../../src/AgentMandate.sol";
import {PriceOracle} from "../../src/PriceOracle.sol";
import {SessionManager} from "../../src/SessionManager.sol";
import {IPriceOracle} from "../../src/interfaces/IPriceOracle.sol";
import {ISessionManager} from "../../src/interfaces/ISessionManager.sol";
import {ISignatureTransfer} from "../../src/interfaces/IPermit2.sol";
import {Intent, IntentFlags, Mandate} from "../../src/types/Types.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockPermit2} from "../mocks/MockPermit2.sol";
import {MockSwapAdapter} from "../mocks/MockSwapAdapter.sol";

/// @dev The agent, as a contract wallet. Echidna cannot sign, so the signature
/// check is satisfied through EIP-1271 rather than through a key. That is not a
/// weakening of the target. It moves the question from who signed to what the
/// mandate allows, which is the question I14 asks, and the impostor below is what
/// keeps the signature side of it honest.
contract AlwaysSigns {
    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        return 0x1626ba7e;
    }
}

contract NeverSigns {
    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        return 0xffffffff;
    }
}

/// @notice I14 under echidna. An intent outside the agent mandate is never
/// authorized, and a mandate's daily budget is never overspent.
///
/// Ten shapes go in. One conforms and nine break exactly one named rule, because a
/// campaign that only signs conforming intents proves that conforming intents
/// conform. Every authorization that succeeds is then re-checked here against the
/// mandate, independently of the contract that just accepted it, so the contract
/// is not the one certifying itself.
contract EchidnaMandate {
    uint16 internal constant MANDATE_DEV_BPS = 50;
    /// Everything but overnight and holiday.
    uint8 internal constant MANDATE_SESSIONS = 0x3E;

    AgentMandate internal mandates;
    SessionManager internal sessions;
    PriceOracle internal oracle;
    MockPermit2 internal permit2;
    MockSwapAdapter internal venue;

    MockERC20 internal quote;
    MockERC20 internal base;
    MockERC20 internal outsider;
    MockAggregator internal quoteFeed;
    MockAggregator internal baseFeed;

    address internal agent;
    address internal impostor;

    bytes32 internal goodMandate;
    bytes32 internal impostorMandate;
    address internal goodAccount;
    address internal impostorAccount;
    uint64 internal expiry;

    uint256 internal constant MAX_PER_BATCH = 2000e18;
    uint256 internal constant MAX_PER_DAY = 5000e18;

    uint256 internal nextNonce = 1;

    uint256 public authorizedCount;
    uint256 public outsideMandateAccepted;
    uint256 public budgetOverspent;
    uint256 public impostorAccepted;
    uint256 public revokedAccepted;

    bool internal revoked;

    constructor() {
        quote = new MockERC20("Global Dollar", "USDG", 6);
        base = new MockERC20("Nvidia", "NVDA", 18);
        outsider = new MockERC20("Not On The List", "NOPE", 18);
        quoteFeed = new MockAggregator(8, "USDG / USD");
        baseFeed = new MockAggregator(8, "RHNVDA / USD");
        venue = new MockSwapAdapter();
        permit2 = new MockPermit2();

        sessions = new SessionManager(address(this));
        uint64[] memory dst = new uint64[](2);
        dst[0] = uint64(block.timestamp) - 30 days;
        dst[1] = uint64(block.timestamp) + 300 days;
        sessions.setDstBoundaries(dst);

        oracle = new PriceOracle(ISessionManager(address(sessions)), address(this));
        oracle.setFeed(address(quote), address(quoteFeed), 6000, 20_000);
        oracle.setFeed(address(base), address(baseFeed), 6000, 20_000);
        oracle.setFeed(address(outsider), address(baseFeed), 6000, 20_000);
        oracle.setTwapSource(address(quote), address(venue), address(base), 1800);
        oracle.setTwapSource(address(base), address(venue), address(quote), 1800);
        oracle.setTwapSource(address(outsider), address(venue), address(quote), 1800);
        // The frozen sessions read the pool rather than the feed, and these are the
        // same pair written the way a price feed writes it.
        venue.setRate(address(quote), address(base), 1e18);
        venue.setRate(address(base), address(quote), 200e18);
        venue.setRate(address(outsider), address(quote), 200e18);

        mandates = new AgentMandate(
            ISessionManager(address(sessions)),
            IPriceOracle(address(oracle)),
            ISignatureTransfer(address(permit2)),
            address(0x5E77),
            address(0xA0C7)
        );

        agent = address(new AlwaysSigns());
        impostor = address(new NeverSigns());
        expiry = uint64(block.timestamp) + 30 days;

        goodMandate = _create(agent);
        impostorMandate = _create(impostor);
        goodAccount = mandates.accountOf(goodMandate);
        impostorAccount = mandates.accountOf(impostorMandate);

        _refreshFeeds();
    }

    // ---- actions ----

    /// @notice One of ten shapes. Nine of them break a rule the mandate names.
    function actAuthorize(uint256 seed) public {
        uint8 shape = uint8(seed % 10);
        Intent memory i = _intent(shape, seed);
        bytes32 id = shape == 9 ? impostorMandate : goodMandate;

        try mandates.authorize(id, i, hex"01") {
            authorizedCount += 1;
            if (shape == 9) impostorAccepted += 1;
            if (revoked) revokedAccepted += 1;
            if (!_conforms(i, id)) outsideMandateAccepted += 1;
        } catch {}
        _checkInvariants();
    }

    /// @notice Gives back a booking whose intent expired without being spent. The
    /// budget is a reservation, not a charge, so an intent that never settled has
    /// to stop counting against the day.
    function actRelease(uint256 seed) public {
        Intent memory i = _intent(0, seed);
        try mandates.releaseUnspent(goodMandate, i) {} catch {}
        _checkInvariants();
    }

    function actRevoke() public {
        try mandates.revokeMandate(goodMandate) {
            revoked = true;
        } catch {}
        _checkInvariants();
    }

    function actOracleUpdate(uint256 seed) public {
        int256 answer = int256(200e8);
        int256 delta = (answer * int256(seed % 900)) / 10_000;
        quoteFeed.push(1e8, block.timestamp);
        baseFeed.push(seed & 1 == 0 ? answer + delta : answer - delta, block.timestamp);
        _checkInvariants();
    }

    // ---- invariants ----

    function _checkInvariants() internal view {
        // I14.
        assert(outsideMandateAccepted == 0);
        assert(impostorAccepted == 0);
        assert(revokedAccepted == 0);

        // The daily reservation never passes the daily cap, on either mandate.
        assert(mandates.spentToday(goodMandate) <= MAX_PER_DAY);
        assert(mandates.spentToday(impostorMandate) <= MAX_PER_DAY);
        assert(budgetOverspent == 0);
    }

    /// @dev Re-checks every rule from outside the contract that just applied them.
    function _conforms(Intent memory i, bytes32 id) internal view returns (bool) {
        address account = id == goodMandate ? goodAccount : impostorAccount;
        if (revoked && id == goodMandate) return false;
        if (block.timestamp >= expiry) return false;
        if (i.owner != account) return false;
        if (i.flags & IntentFlags.AGENT_SIGNED == 0) return false;
        if (i.validUntil > expiry) return false;
        if (i.allowedSessions & ~MANDATE_SESSIONS != 0) return false;
        if (i.maxDevFromRefBps > MANDATE_DEV_BPS) return false;
        if (i.flags & IntentFlags.AUCTION != 0) return false;
        if (i.sellToken != address(quote) && i.sellToken != address(base)) return false;
        if (i.buyToken != address(quote) && i.buyToken != address(base)) return false;
        if (mandates.notionalUsd(i.sellToken, i.sellAmount) > MAX_PER_BATCH) return false;
        return true;
    }

    // ---- building ----

    function _create(address agent_) internal returns (bytes32) {
        address[] memory allowed = new address[](2);
        allowed[0] = address(quote);
        allowed[1] = address(base);
        return mandates.createMandate(
            Mandate({
                owner: address(this),
                agent: agent_,
                allowedTokens: allowed,
                maxNotionalPerBatch: MAX_PER_BATCH,
                maxNotionalPerDay: MAX_PER_DAY,
                maxDeviationFromRefBps: MANDATE_DEV_BPS,
                allowedSessions: MANDATE_SESSIONS,
                expiry: expiry,
                auctionAllowed: false
            })
        );
    }

    function _intent(uint8 shape, uint256 seed) internal returns (Intent memory i) {
        i = Intent({
            owner: shape == 9 ? impostorAccount : goodAccount,
            receiver: shape == 9 ? impostorAccount : goodAccount,
            sellToken: address(quote),
            buyToken: address(base),
            sellAmount: 100e6 + (seed % 900) * 1e6,
            minBuyAmount: 0.4e18,
            validAfter: 0,
            validUntil: uint32(expiry - 1),
            flags: IntentFlags.AGENT_SIGNED,
            kind: 0,
            maxDevFromRefBps: 20,
            allowedSessions: 0x08, // OPEN, which the mandate allows
            batchSpan: 1,
            nonce: nextNonce++
        });

        if (shape == 1) i.owner = address(0xDEAD);
        if (shape == 2) i.flags = 0;
        if (shape == 3) i.validUntil = uint32(expiry) + 1;
        if (shape == 4) i.allowedSessions = 0x01; // overnight, which it does not
        if (shape == 5) i.maxDevFromRefBps = MANDATE_DEV_BPS + 1;
        if (shape == 6) i.flags = IntentFlags.AGENT_SIGNED | IntentFlags.AUCTION;
        if (shape == 7) i.sellToken = address(outsider);
        if (shape == 8) i.sellAmount = 10_000e6;
    }

    function _refreshFeeds() internal {
        quoteFeed.push(1e8, block.timestamp);
        baseFeed.push(200e8, block.timestamp);
    }
}
