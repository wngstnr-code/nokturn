// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";

import {AgentMandate} from "../src/AgentMandate.sol";
import {MandateAccount} from "../src/MandateAccount.sol";
import {PriceOracle} from "../src/PriceOracle.sol";
import {SessionManager} from "../src/SessionManager.sol";
import {IAgentMandate} from "../src/interfaces/IAgentMandate.sol";
import {IPriceOracle} from "../src/interfaces/IPriceOracle.sol";
import {ISessionManager} from "../src/interfaces/ISessionManager.sol";
import {ISignatureTransfer} from "../src/interfaces/IPermit2.sol";
import {IntentLib} from "../src/libraries/IntentLib.sol";
import {Permit2Witness} from "../src/libraries/Permit2Witness.sol";
import {Intent, IntentFlags, IntentKind, Mandate, SessionMask} from "../src/types/Types.sol";
import {CalendarFixture} from "./fixtures/CalendarFixture.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockPermit2} from "./mocks/MockPermit2.sol";

contract IntentHasher {
    function hashOf(Intent calldata i) external pure returns (bytes32) {
        return IntentLib.hash(i);
    }
}

contract AgentMandateTest is Test {
    SessionManager sessions;
    PriceOracle oracle;
    MockPermit2 permit2;
    AgentMandate mandates;
    MockERC20 usdg;
    MockERC20 nvda;
    MockAggregator usdgFeed;
    MockAggregator nvdaFeed;
    IntentHasher hasher;

    address governor = address(0x60174E);
    address settlement = address(0x5E771E);
    address auctionHouse = address(0xA0C7104);
    address owner = address(0x0E4E4);
    address relayer = address(0xBE1A4);

    uint256 constant AGENT_KEY = 0xA9E47;
    uint256 constant STRANGER_KEY = 0xDECAF;
    address agent = vm.addr(AGENT_KEY);

    /// Wednesday 11 March 2026, 09:30 in New York. Daylight time already started
    /// on 8 March, so New York is four hours behind and the bell is 13:30 UTC.
    bytes32 constant RULE_REVOKED = "revoked";
    bytes32 constant RULE_MANDATE_EXPIRED = "mandate expired";
    bytes32 constant RULE_WRONG_OWNER = "wrong owner";
    bytes32 constant RULE_NOT_AGENT_SIGNED = "not agent signed";
    bytes32 constant RULE_OUTLIVES_MANDATE = "outlives mandate";
    bytes32 constant RULE_SESSION_NOT_ALLOWED = "session not allowed";
    bytes32 constant RULE_DEVIATION_TOO_WIDE = "deviation too wide";
    bytes32 constant RULE_AUCTION_NOT_ALLOWED = "auction not allowed";
    bytes32 constant RULE_TOKEN_NOT_ALLOWED = "token not allowed";
    bytes32 constant RULE_PER_BATCH_CAP = "per batch cap";
    bytes32 constant RULE_PER_DAY_CAP = "per day cap";
    bytes32 constant RULE_ORACLE_UNHEALTHY = "oracle unhealthy";

    uint64 constant BELL = 1_773_235_800;
    uint32 constant DAY = 20_260_311;

    function setUp() public {
        sessions = new SessionManager(governor);
        vm.startPrank(governor);
        sessions.setDstBoundaries(CalendarFixture.loadDst());
        CalendarFixture.loadCalendar(sessions, CalendarFixture.loadDays());
        vm.stopPrank();

        usdg = new MockERC20("Global Dollar", "USDG", 6);
        nvda = new MockERC20("Nvidia", "RHNVDA", 18);
        usdgFeed = new MockAggregator(8, "USDG / USD");
        nvdaFeed = new MockAggregator(8, "RHNVDA / USD");

        oracle = new PriceOracle(ISessionManager(address(sessions)), governor);
        vm.startPrank(governor);
        oracle.setFeed(address(usdg), address(usdgFeed), 6000, 20_000);
        oracle.setFeed(address(nvda), address(nvdaFeed), 6000, 20_000);
        vm.stopPrank();

        permit2 = new MockPermit2();
        mandates = new AgentMandate(
            ISessionManager(address(sessions)),
            IPriceOracle(address(oracle)),
            ISignatureTransfer(address(permit2)),
            settlement,
            auctionHouse
        );
        hasher = new IntentHasher();

        vm.warp(BELL + 3600);
        usdgFeed.push(1e8, block.timestamp);
        nvdaFeed.push(200e8, block.timestamp);
    }

    function test_aMandateGetsItsOwnAccountAndTheRegistryKnowsBothWays() public {
        bytes32 id = _create();
        address account = mandates.accountOf(id);

        assertTrue(account != address(0), "the account was deployed");
        assertEq(mandates.mandateOf(account), id, "and the registry maps it back");
        assertEq(mandates.accountOwner(account), owner);
        assertEq(MandateAccount(account).permit2(), address(permit2));
        assertEq(address(MandateAccount(account).registry()), address(mandates));
    }

    function test_theSameOwnerAndAgentCanHoldTwoMandates() public {
        bytes32 first = _create();
        bytes32 second = _create();

        assertTrue(first != second, "ids differ");
        assertTrue(mandates.accountOf(first) != mandates.accountOf(second), "accounts differ");
        assertEq(mandates.mandateCount(owner), 2);
    }

    function test_aMandateWithoutTokensIsRefused() public {
        Mandate memory m = _template();
        m.allowedTokens = new address[](0);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AgentMandate.TooManyTokens.selector, 0));
        mandates.createMandate(m);
    }

    function test_aMandateOverTheTokenCapIsRefused() public {
        Mandate memory m = _template();
        m.allowedTokens = new address[](9);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AgentMandate.TooManyTokens.selector, 9));
        mandates.createMandate(m);
    }

    /// A mandate that never expires is an unlimited approval under another name.
    function test_anExpiryPastTheMaximumDurationIsRefused() public {
        Mandate memory m = _template();
        m.expiry = uint64(block.timestamp) + 91 days;

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AgentMandate.ExpiryOutOfRange.selector, m.expiry));
        mandates.createMandate(m);
    }

    function test_anExpiryInThePastIsRefused() public {
        Mandate memory m = _template();
        m.expiry = uint64(block.timestamp);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AgentMandate.ExpiryOutOfRange.selector, m.expiry));
        mandates.createMandate(m);
    }

    function test_aMandateWithoutAnAgentIsRefused() public {
        Mandate memory m = _template();
        m.agent = address(0);

        vm.prank(owner);
        vm.expectRevert(AgentMandate.ZeroAgent.selector);
        mandates.createMandate(m);
    }

    function test_onlyTheOwnerRevokes() public {
        bytes32 id = _create();

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentMandate.NotMandateOwner.selector, id));
        mandates.revokeMandate(id);

        vm.prank(owner);
        mandates.revokeMandate(id);
        (,,,,,,, bool revoked) = mandates.mandate(id);
        assertTrue(revoked);
    }

    function test_revokingAnUnknownMandateReverts() public {
        bytes32 id = keccak256("nothing");
        vm.expectRevert(abi.encodeWithSelector(AgentMandate.UnknownMandate.selector, id));
        mandates.revokeMandate(id);
    }

    function test_aRelayerCanCarryTheAgentSignature() public {
        bytes32 id = _create();
        Intent memory i = _intent(id, 1000e6, 1);
        bytes memory sig = _sign(AGENT_KEY, i);

        vm.prank(relayer);
        bytes32 digest = mandates.authorize(id, i, sig);

        assertTrue(mandates.accountAuthorized(mandates.accountOf(id), digest));
        assertEq(mandates.spentToday(id), 1000e18, "one thousand dollars of budget");
    }

    function test_aSignatureFromAnyoneButTheAgentIsRefused() public {
        bytes32 id = _create();
        Intent memory i = _intent(id, 1000e6, 1);
        bytes memory sig = _sign(STRANGER_KEY, i);
        bytes32 digest = _digest(i);

        vm.expectRevert(abi.encodeWithSelector(AgentMandate.BadAgentSignature.selector, id, digest));
        mandates.authorize(id, i, sig);
    }

    function test_theSameIntentCannotBeAuthorizedTwice() public {
        bytes32 id = _create();
        Intent memory i = _intent(id, 1000e6, 1);
        bytes memory sig = _sign(AGENT_KEY, i);
        bytes32 digest = mandates.authorize(id, i, sig);

        vm.expectRevert(abi.encodeWithSelector(AgentMandate.AlreadyAuthorized.selector, digest));
        mandates.authorize(id, i, sig);
    }

    /// The spender sits inside the Permit2 digest, so a signature made for a cross
    /// cannot be spent by the batch path and the other way round.
    function test_theAuctionFlagChangesTheDigestAndSoTheSignature() public {
        bytes32 id = _createAllowingAuctions();
        Intent memory batchIntent = _intent(id, 1000e6, 1);
        Intent memory crossIntent = _intent(id, 1000e6, 1);
        crossIntent.flags = IntentFlags.AGENT_SIGNED | IntentFlags.AUCTION;
        crossIntent.allowedSessions = SessionMask.AUCTION_OPEN;

        assertTrue(_digest(batchIntent) != _digest(crossIntent), "different spender, different digest");

        bytes memory forTheBatch = _sign(AGENT_KEY, batchIntent);
        bytes32 crossDigest = _digest(crossIntent);
        vm.expectRevert(abi.encodeWithSelector(AgentMandate.BadAgentSignature.selector, id, crossDigest));
        mandates.authorize(id, crossIntent, forTheBatch);
    }

    function test_aRevokedMandateAuthorizesNothing() public {
        bytes32 id = _create();
        vm.prank(owner);
        mandates.revokeMandate(id);

        Intent memory i = _intent(id, 1000e6, 1);
        bytes memory sig = _sign(AGENT_KEY, i);
        vm.expectRevert(abi.encodeWithSelector(AgentMandate.MandateRuleBroken.selector, id, RULE_REVOKED));
        mandates.authorize(id, i, sig);
    }

    function test_anExpiredMandateAuthorizesNothing() public {
        bytes32 id = _create();
        (,,, uint64 expiry,,,,) = mandates.mandate(id);
        vm.warp(expiry);

        Intent memory i = _intent(id, 1000e6, 1);
        // forge-lint: disable-next-line(unsafe-typecast)
        i.validUntil = uint32(expiry);
        bytes memory sig = _sign(AGENT_KEY, i);
        vm.expectRevert(
            abi.encodeWithSelector(AgentMandate.MandateRuleBroken.selector, id, RULE_MANDATE_EXPIRED)
        );
        mandates.authorize(id, i, sig);
    }

    function test_anIntentOwnedByAnybodyElseIsRefused() public {
        bytes32 id = _create();
        Intent memory i = _intent(id, 1000e6, 1);
        i.owner = owner;
        bytes memory sig = _sign(AGENT_KEY, i);

        vm.expectRevert(abi.encodeWithSelector(AgentMandate.MandateRuleBroken.selector, id, RULE_WRONG_OWNER));
        mandates.authorize(id, i, sig);
    }

    function test_anIntentWithoutTheAgentFlagIsNotAnAgentIntent() public {
        bytes32 id = _create();
        Intent memory i = _intent(id, 1000e6, 1);
        i.flags = 0;
        bytes memory sig = _sign(AGENT_KEY, i);

        vm.expectRevert(
            abi.encodeWithSelector(AgentMandate.MandateRuleBroken.selector, id, RULE_NOT_AGENT_SIGNED)
        );
        mandates.authorize(id, i, sig);
    }

    /// An intent that outlives its mandate would still be sitting in a book after
    /// the owner expected the authority to lapse.
    function test_anIntentCannotOutliveItsMandate() public {
        bytes32 id = _create();
        (,,, uint64 expiry,,,,) = mandates.mandate(id);
        Intent memory i = _intent(id, 1000e6, 1);
        // forge-lint: disable-next-line(unsafe-typecast)
        i.validUntil = uint32(expiry) + 1;
        bytes memory sig = _sign(AGENT_KEY, i);

        vm.expectRevert(
            abi.encodeWithSelector(AgentMandate.MandateRuleBroken.selector, id, RULE_OUTLIVES_MANDATE)
        );
        mandates.authorize(id, i, sig);
    }

    function test_theIntentSessionsMustFitInsideTheMandateMask() public {
        bytes32 id = _create();
        Intent memory i = _intent(id, 1000e6, 1);
        i.allowedSessions = SessionMask.OPEN | SessionMask.CLOSED_WEEKEND;
        bytes memory sig = _sign(AGENT_KEY, i);

        vm.expectRevert(
            abi.encodeWithSelector(AgentMandate.MandateRuleBroken.selector, id, RULE_SESSION_NOT_ALLOWED)
        );
        mandates.authorize(id, i, sig);
    }

    function test_theIntentCannotAcceptAWiderDeviationThanTheMandate() public {
        bytes32 id = _create();
        Intent memory i = _intent(id, 1000e6, 1);
        i.maxDevFromRefBps = 201;
        bytes memory sig = _sign(AGENT_KEY, i);

        vm.expectRevert(
            abi.encodeWithSelector(AgentMandate.MandateRuleBroken.selector, id, RULE_DEVIATION_TOO_WIDE)
        );
        mandates.authorize(id, i, sig);
    }

    function test_anAuctionIntentNeedsTheAuctionPermission() public {
        bytes32 id = _create();
        Intent memory i = _intent(id, 1000e6, 1);
        i.flags = IntentFlags.AGENT_SIGNED | IntentFlags.AUCTION;
        bytes memory sig = _sign(AGENT_KEY, i);

        vm.expectRevert(
            abi.encodeWithSelector(AgentMandate.MandateRuleBroken.selector, id, RULE_AUCTION_NOT_ALLOWED)
        );
        mandates.authorize(id, i, sig);
    }

    function test_bothLegsOfTheTradeMustBeAllowed() public {
        bytes32 id = _createForTokens(_one(address(usdg)));
        Intent memory i = _intent(id, 1000e6, 1);
        bytes memory sig = _sign(AGENT_KEY, i);

        vm.expectRevert(
            abi.encodeWithSelector(AgentMandate.MandateRuleBroken.selector, id, RULE_TOKEN_NOT_ALLOWED)
        );
        mandates.authorize(id, i, sig);
    }

    function test_theSellLegIsCheckedToo() public {
        bytes32 id = _createForTokens(_one(address(nvda)));
        Intent memory i = _intent(id, 1000e6, 1);
        bytes memory sig = _sign(AGENT_KEY, i);

        vm.expectRevert(
            abi.encodeWithSelector(AgentMandate.MandateRuleBroken.selector, id, RULE_TOKEN_NOT_ALLOWED)
        );
        mandates.authorize(id, i, sig);
    }

    function test_oneIntentCannotExceedThePerBatchCap() public {
        bytes32 id = _create();
        Intent memory i = _intent(id, 2001e6, 1);
        bytes memory sig = _sign(AGENT_KEY, i);

        vm.expectRevert(
            abi.encodeWithSelector(AgentMandate.MandateRuleBroken.selector, id, RULE_PER_BATCH_CAP)
        );
        mandates.authorize(id, i, sig);
    }

    function test_theDailyBudgetAddsUpAcrossIntents() public {
        bytes32 id = _create();
        _authorize(id, _intent(id, 2000e6, 1));
        _authorize(id, _intent(id, 2000e6, 2));
        assertEq(mandates.spentToday(id), 4000e18);

        Intent memory third = _intent(id, 2000e6, 3);
        bytes memory sig = _sign(AGENT_KEY, third);
        vm.expectRevert(abi.encodeWithSelector(AgentMandate.MandateRuleBroken.selector, id, RULE_PER_DAY_CAP));
        mandates.authorize(id, third, sig);
    }

    /// The budget follows the New York calendar day. UTC midnight lands inside the
    /// post market session, so resetting on it would hand out two budgets in one
    /// American evening.
    function test_theBudgetSurvivesUtcMidnightAndResetsOnTheNewYorkDay() public {
        bytes32 id = _create();
        _authorize(id, _intent(id, 2000e6, 1));

        // 00:30 UTC the next calendar day, which is still 20:30 in New York. The
        // timestamps are written out rather than read back from the clock, because
        // the optimizer is free to hoist a block.timestamp read across vm.warp.
        uint64 pastUtcMidnight = BELL + 11 hours;
        uint64 nextNewYorkDay = BELL + 1 days;
        assertEq(sessions.easternDay(pastUtcMidnight), DAY, "still the same New York day");
        assertTrue(sessions.easternDay(nextNewYorkDay) != DAY, "and the next one is not");

        vm.warp(pastUtcMidnight);
        assertEq(mandates.spentToday(id), 2000e18, "so the budget did not reset at UTC midnight");

        vm.warp(nextNewYorkDay);
        assertEq(mandates.spentToday(id), 0, "and the next day starts clean");
    }

    /// A cap written in dollars has to mean dollars whatever the token decimals
    /// are, or it is decoration.
    function test_notionalIsNormalisedByTokenDecimals() public view {
        assertEq(mandates.notionalUsd(address(usdg), 1000e6), 1000e18, "six decimals");
        assertEq(mandates.notionalUsd(address(nvda), 5e18), 1000e18, "eighteen decimals, same dollars");
    }

    function test_releaseBeforeTheIntentExpiredIsRefused() public {
        bytes32 id = _create();
        Intent memory i = _intent(id, 2000e6, 1);
        _authorize(id, i);
        bytes32 digest = _digest(i);

        vm.expectRevert(abi.encodeWithSelector(AgentMandate.NothingToRelease.selector, digest));
        mandates.releaseUnspent(id, i);
    }

    function test_releaseGivesTheBudgetBackAndDropsTheAuthorization() public {
        bytes32 id = _create();
        Intent memory i = _intent(id, 2000e6, 1);
        _authorize(id, i);
        address account = mandates.accountOf(id);
        bytes32 digest = _digest(i);

        vm.warp(uint256(i.validUntil) + 1);
        mandates.releaseUnspent(id, i);

        assertFalse(mandates.accountAuthorized(account, digest), "the mark is gone");
        assertEq(mandates.spentToday(id), 0, "and so is the reservation");
    }

    function test_releasingTwiceIsRefused() public {
        bytes32 id = _create();
        Intent memory i = _intent(id, 2000e6, 1);
        _authorize(id, i);
        bytes32 digest = _digest(i);

        vm.warp(uint256(i.validUntil) + 1);
        mandates.releaseUnspent(id, i);

        vm.expectRevert(abi.encodeWithSelector(AgentMandate.NothingToRelease.selector, digest));
        mandates.releaseUnspent(id, i);
    }

    /// The proof that an intent did trade is the Permit2 nonce bitmap, not a claim
    /// by whoever is asking for the budget back.
    function test_anIntentThatSpentItsNonceKeepsItsBudget() public {
        bytes32 id = _create();
        Intent memory i = _intent(id, 2000e6, 1);
        _authorize(id, i);
        address account = mandates.accountOf(id);
        bytes32 digest = _digest(i);

        usdg.mint(account, 2000e6);
        MandateAccount(account).approvePermit2(IERC20(address(usdg)));
        _pull(i, account);

        vm.warp(uint256(i.validUntil) + 1);
        vm.expectRevert(abi.encodeWithSelector(AgentMandate.NothingToRelease.selector, digest));
        mandates.releaseUnspent(id, i);
        assertEq(mandates.spentToday(id), 2000e18, "the budget stays spent because the trade happened");
    }

    /// A cap priced off a feed that stopped updating is not a cap. The agent is
    /// told to come back rather than handed a number nobody stands behind.
    function test_aStaleFeedAuthorizesNothing() public {
        bytes32 id = _create();
        Intent memory i = _intent(id, 1000e6, 1);
        bytes memory sig = _sign(AGENT_KEY, i);

        // The staleness limit in the OPEN session is 6000 seconds, so the round is
        // pushed with a timestamp already past it rather than by moving the clock.
        usdgFeed.push(1e8, block.timestamp - 7000);

        (bool ok, bytes32 reason) = mandates.validate(id, i);
        assertFalse(ok);
        assertEq(reason, RULE_ORACLE_UNHEALTHY);

        vm.expectRevert(
            abi.encodeWithSelector(AgentMandate.MandateRuleBroken.selector, id, RULE_ORACLE_UNHEALTHY)
        );
        mandates.authorize(id, i, sig);
    }

    function test_validateAnswersWithoutTouchingTheBudget() public {
        bytes32 id = _create();
        Intent memory i = _intent(id, 1000e6, 1);

        (bool ok, bytes32 reason) = mandates.validate(id, i);
        assertTrue(ok);
        assertEq(reason, bytes32(0));

        _authorize(id, i);
        (ok,) = mandates.validate(id, i);
        assertTrue(ok, "still true after the budget moved, so a caller cannot double count");
    }

    function test_validateNamesTheUnknownMandate() public view {
        (bool ok, bytes32 reason) = mandates.validate(keccak256("nothing"), _blankIntent());
        assertFalse(ok);
        assertEq(reason, "unknown mandate");
    }

    function test_theAccountAcceptsOnlyADigestThatWasAuthorized() public {
        bytes32 id = _create();
        Intent memory i = _intent(id, 1000e6, 1);
        address account = mandates.accountOf(id);

        assertEq(MandateAccount(account).isValidSignature(_digest(i), ""), bytes4(0xffffffff));
        _authorize(id, i);
        assertEq(MandateAccount(account).isValidSignature(_digest(i), ""), bytes4(0x1626ba7e));
    }

    /// Revocation has to reach intents that were already booked, or an agent could
    /// front run its own dismissal.
    function test_revokingStopsAnIntentThatWasAlreadyAuthorized() public {
        bytes32 id = _create();
        Intent memory i = _intent(id, 1000e6, 1);
        _authorize(id, i);
        address account = mandates.accountOf(id);

        vm.prank(owner);
        mandates.revokeMandate(id);
        assertEq(MandateAccount(account).isValidSignature(_digest(i), ""), bytes4(0xffffffff));
    }

    function test_expiryStopsAnIntentThatWasAlreadyAuthorized() public {
        bytes32 id = _create();
        Intent memory i = _intent(id, 1000e6, 1);
        _authorize(id, i);
        address account = mandates.accountOf(id);
        (,,, uint64 expiry,,,,) = mandates.mandate(id);

        vm.warp(expiry);
        assertEq(MandateAccount(account).isValidSignature(_digest(i), ""), bytes4(0xffffffff));
    }

    function test_anAddressWithoutAMandateAuthorizesNothing() public view {
        assertFalse(mandates.accountAuthorized(address(0xDEAD), keccak256("anything")));
        assertEq(mandates.accountOwner(address(0xDEAD)), address(0));
    }

    function test_onlyTheOwnerWithdraws() public {
        bytes32 id = _create();
        address account = mandates.accountOf(id);
        usdg.mint(account, 500e6);

        vm.prank(agent);
        vm.expectRevert(MandateAccount.NotOwner.selector);
        MandateAccount(account).withdraw(IERC20(address(usdg)), 500e6, agent);

        vm.prank(owner);
        MandateAccount(account).withdraw(IERC20(address(usdg)), 500e6, owner);
        assertEq(usdg.balanceOf(owner), 500e6, "the owner can always take the deposit back");
    }

    function test_theAccountOnlyEverApprovesPermit2() public {
        bytes32 id = _create();
        address account = mandates.accountOf(id);

        MandateAccount(account).approvePermit2(IERC20(address(usdg)));
        assertEq(usdg.allowance(account, address(permit2)), type(uint256).max);
        assertEq(usdg.allowance(account, settlement), 0);
        assertEq(usdg.allowance(account, agent), 0);
    }

    function test_authorizeOnAnUnknownMandateReverts() public {
        bytes32 id = keccak256("nothing");
        Intent memory i = _blankIntent();
        vm.expectRevert(abi.encodeWithSelector(AgentMandate.UnknownMandate.selector, id));
        mandates.authorize(id, i, "");
    }

    function test_theLimitsReadBackTheWayTheyWereWritten() public {
        bytes32 id = _create();
        (uint256 perBatch, uint256 perDay, address[] memory tokens) = mandates.mandateLimits(id);

        assertEq(perBatch, 2000e18);
        assertEq(perDay, 5000e18);
        assertEq(tokens.length, 2);
        assertEq(tokens[0], address(usdg));
        assertEq(tokens[1], address(nvda));
    }

    function _template() internal view returns (Mandate memory m) {
        address[] memory tokens = new address[](2);
        tokens[0] = address(usdg);
        tokens[1] = address(nvda);
        m = Mandate({
            owner: owner,
            agent: agent,
            allowedTokens: tokens,
            maxNotionalPerBatch: 2000e18,
            maxNotionalPerDay: 5000e18,
            maxDeviationFromRefBps: 200,
            allowedSessions: SessionMask.OPEN | SessionMask.POST_MARKET,
            expiry: uint64(block.timestamp) + 30 days,
            auctionAllowed: false
        });
    }

    function _create() internal returns (bytes32) {
        Mandate memory m = _template();
        vm.prank(owner);
        return mandates.createMandate(m);
    }

    function _createAllowingAuctions() internal returns (bytes32) {
        Mandate memory m = _template();
        m.auctionAllowed = true;
        m.allowedSessions = SessionMask.OPEN | SessionMask.POST_MARKET | SessionMask.AUCTION_OPEN;
        vm.prank(owner);
        return mandates.createMandate(m);
    }

    function _createForTokens(address[] memory tokens) internal returns (bytes32) {
        Mandate memory m = _template();
        m.allowedTokens = tokens;
        vm.prank(owner);
        return mandates.createMandate(m);
    }

    function _one(address token) internal pure returns (address[] memory out) {
        out = new address[](1);
        out[0] = token;
    }

    function _intent(bytes32 id, uint256 sellAmount, uint256 nonce) internal view returns (Intent memory) {
        return Intent({
            owner: mandates.accountOf(id),
            receiver: mandates.accountOf(id),
            sellToken: address(usdg),
            buyToken: address(nvda),
            sellAmount: sellAmount,
            minBuyAmount: 0,
            validAfter: 0,
            // forge-lint: disable-next-line(unsafe-typecast)
            validUntil: uint32(BELL + 2 hours),
            flags: IntentFlags.AGENT_SIGNED,
            kind: uint8(IntentKind.SPOT),
            maxDevFromRefBps: 100,
            allowedSessions: SessionMask.OPEN,
            batchSpan: 1,
            nonce: nonce
        });
    }

    function _blankIntent() internal view returns (Intent memory) {
        return _intent(bytes32(0), 0, 0);
    }

    function _digest(Intent memory i) internal view returns (bytes32) {
        address spender = i.flags & IntentFlags.AUCTION != 0 ? auctionHouse : settlement;
        return Permit2Witness.digest(
            permit2.DOMAIN_SEPARATOR(),
            mandates.permitTypeHash(),
            i.sellToken,
            i.sellAmount,
            spender,
            i.nonce,
            i.validUntil,
            hasher.hashOf(i)
        );
    }

    function _sign(uint256 key, Intent memory i) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, _digest(i));
        return abi.encodePacked(r, s, v);
    }

    function _authorize(bytes32 id, Intent memory i) internal {
        mandates.authorize(id, i, _sign(AGENT_KEY, i));
    }

    function _pull(Intent memory i, address account) internal {
        vm.prank(settlement);
        permit2.permitWitnessTransferFrom(
            ISignatureTransfer.PermitTransferFrom({
                permitted: ISignatureTransfer.TokenPermissions({token: i.sellToken, amount: i.sellAmount}),
                nonce: i.nonce,
                deadline: i.validUntil
            }),
            ISignatureTransfer.SignatureTransferDetails({to: settlement, requestedAmount: i.sellAmount}),
            account,
            hasher.hashOf(i),
            mandates.WITNESS_TYPE_STRING(),
            ""
        );
    }
}
