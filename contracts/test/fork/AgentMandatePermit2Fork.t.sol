// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";

import {AgentMandate} from "../../src/AgentMandate.sol";
import {MandateAccount} from "../../src/MandateAccount.sol";
import {PriceOracle} from "../../src/PriceOracle.sol";
import {SessionManager} from "../../src/SessionManager.sol";
import {IPriceOracle} from "../../src/interfaces/IPriceOracle.sol";
import {ISessionManager} from "../../src/interfaces/ISessionManager.sol";
import {ISignatureTransfer} from "../../src/interfaces/IPermit2.sol";
import {IntentLib} from "../../src/libraries/IntentLib.sol";
import {Permit2Witness} from "../../src/libraries/Permit2Witness.sol";
import {Intent, IntentFlags, IntentKind, Mandate, SessionMask} from "../../src/types/Types.sol";
import {CalendarFixture} from "../../script/Calendar.sol";
import {ForkFixture} from "../fixtures/ForkFixture.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";

/// @notice Stands in for the contract that will call Permit2 in production. It has
/// to be a real address because Permit2 puts its caller into the digest.
contract Spender {
    ISignatureTransfer internal immutable permit2;

    constructor(ISignatureTransfer permit2_) {
        permit2 = permit2_;
    }

    function pull(Intent calldata i, string calldata witnessTypeString, bytes calldata signature) external {
        permit2.permitWitnessTransferFrom(
            ISignatureTransfer.PermitTransferFrom({
                permitted: ISignatureTransfer.TokenPermissions({token: i.sellToken, amount: i.sellAmount}),
                nonce: i.nonce,
                deadline: i.validUntil
            }),
            ISignatureTransfer.SignatureTransferDetails({to: address(this), requestedAmount: i.sellAmount}),
            i.owner,
            IntentLib.hash(i),
            witnessTypeString,
            signature
        );
    }
}

contract IntentHasher {
    function hashOf(Intent calldata i) external pure returns (bytes32) {
        return IntentLib.hash(i);
    }
}

/// @notice The claim under test is that a mandate account can stand as the owner
/// on a Permit2 transfer, which is the whole reason the account exists. Nothing in
/// a mock can settle it, because a mock would accept whatever this repo hands it.
/// So the pull here runs through the Permit2 that is actually deployed on mainnet
/// 4663, with real USDG, and the only thing standing between an agent key and the
/// money is the EIP-1271 answer the clone gives.
contract AgentMandatePermit2ForkTest is Test {
    SessionManager sessions;
    PriceOracle oracle;
    AgentMandate mandates;
    Spender spender;
    IntentHasher hasher;
    MockAggregator usdgFeed;
    MockAggregator nvdaFeed;

    ISignatureTransfer constant PERMIT2 = ISignatureTransfer(0x000000000022D473030F116dDEE9F6B43aC78BA3);
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;

    address governor = address(0x60174E);
    address auctionHouse = address(0xA0C7104);
    address owner = address(0x0E4E4);
    address relayer = address(0xBE1A4);

    uint256 constant AGENT_KEY = 0xA9E47;
    address agent = vm.addr(AGENT_KEY);

    /// Wednesday 23 September 2026, the open_utc of that row of nyse-sessions.csv.
    uint64 constant BELL = 1_790_170_200;

    bytes32 id;
    address account;

    function setUp() public {
        ForkFixture.selectMainnet();

        sessions = new SessionManager(governor);
        vm.startPrank(governor);
        sessions.setDstBoundaries(CalendarFixture.loadDst());
        CalendarFixture.loadCalendar(sessions, CalendarFixture.loadDays());
        vm.stopPrank();

        // Stub feeds on purpose. This test is about Permit2, and a live feed would
        // make it pass or fail on how recently Chainlink happened to update.
        usdgFeed = new MockAggregator(8, "USDG / USD");
        nvdaFeed = new MockAggregator(8, "RHNVDA / USD");
        oracle = new PriceOracle(ISessionManager(address(sessions)), governor);
        vm.startPrank(governor);
        oracle.setFeed(USDG, address(usdgFeed), 6000, 20_000);
        oracle.setFeed(NVDA, address(nvdaFeed), 6000, 20_000);
        vm.stopPrank();

        spender = new Spender(PERMIT2);
        hasher = new IntentHasher();
        mandates = new AgentMandate(
            ISessionManager(address(sessions)),
            IPriceOracle(address(oracle)),
            PERMIT2,
            address(spender),
            auctionHouse
        );

        vm.warp(BELL + 3600);
        usdgFeed.push(1e8, block.timestamp);
        nvdaFeed.push(200e8, block.timestamp);

        address[] memory tokens = new address[](2);
        tokens[0] = USDG;
        tokens[1] = NVDA;
        vm.prank(owner);
        id = mandates.createMandate(
            Mandate({
                owner: owner,
                agent: agent,
                allowedTokens: tokens,
                maxNotionalPerBatch: 2000e18,
                maxNotionalPerDay: 5000e18,
                maxDeviationFromRefBps: 200,
                allowedSessions: SessionMask.OPEN,
                expiry: uint64(block.timestamp) + 30 days,
                auctionAllowed: false
            })
        );
        account = mandates.accountOf(id);

        deal(USDG, account, 5000e6);
        MandateAccount(account).approvePermit2(IERC20(USDG));
    }

    function test_theRealPermit2TakesTheAccountAsTheOwnerOfTheIntent() public {
        Intent memory i = _intent(1000e6, 11);
        bytes memory agentSig = _sign(AGENT_KEY, i);

        vm.prank(relayer);
        mandates.authorize(id, i, agentSig);

        spender.pull(i, mandates.WITNESS_TYPE_STRING(), agentSig);

        assertEq(IERC20(USDG).balanceOf(address(spender)), 1000e6, "the real Permit2 moved it");
        assertEq(IERC20(USDG).balanceOf(account), 4000e6);
        uint256 bitmap = PERMIT2.nonceBitmap(account, 11 >> 8);
        assertEq(bitmap & (2 ** 11), 2 ** 11, "and the nonce was spent in Permit2 itself");
    }

    /// The agent signature alone is worth nothing. Without the booking that
    /// authorize writes, the account answers no and the real Permit2 refuses.
    function test_anIntentTheMandateNeverBookedIsRefusedByPermit2() public {
        Intent memory i = _intent(1000e6, 12);
        bytes memory agentSig = _sign(AGENT_KEY, i);
        string memory witnessType = mandates.WITNESS_TYPE_STRING();

        vm.expectRevert();
        spender.pull(i, witnessType, agentSig);
    }

    /// Revocation is not a promise for later. It reaches an intent that was already
    /// authorized, and the refusal comes out of Permit2 rather than out of a check
    /// this repo wrote.
    function test_revokingTheMandateStopsAPullThatWasAlreadyBooked() public {
        Intent memory i = _intent(1000e6, 13);
        bytes memory agentSig = _sign(AGENT_KEY, i);
        mandates.authorize(id, i, agentSig);
        string memory witnessType = mandates.WITNESS_TYPE_STRING();

        vm.prank(owner);
        mandates.revokeMandate(id);

        vm.expectRevert();
        spender.pull(i, witnessType, agentSig);
        assertEq(IERC20(USDG).balanceOf(account), 5000e6, "nothing left the account");
    }

    function _intent(uint256 sellAmount, uint256 nonce) internal view returns (Intent memory) {
        return Intent({
            owner: account,
            receiver: account,
            sellToken: USDG,
            buyToken: NVDA,
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

    function _sign(uint256 key, Intent memory i) internal view returns (bytes memory) {
        bytes32 digest = Permit2Witness.digest(
            PERMIT2.DOMAIN_SEPARATOR(),
            mandates.permitTypeHash(),
            i.sellToken,
            i.sellAmount,
            address(spender),
            i.nonce,
            i.validUntil,
            hasher.hashOf(i)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }
}
