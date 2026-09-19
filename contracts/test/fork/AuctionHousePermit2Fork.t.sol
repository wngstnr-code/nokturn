// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";
import {AuctionHouse} from "../../src/AuctionHouse.sol";
import {PriceOracle} from "../../src/PriceOracle.sol";
import {SessionManager} from "../../src/SessionManager.sol";
import {IAuctionHouse} from "../../src/interfaces/IAuctionHouse.sol";
import {IPriceOracle} from "../../src/interfaces/IPriceOracle.sol";
import {ISessionManager} from "../../src/interfaces/ISessionManager.sol";
import {ISignatureTransfer} from "../../src/interfaces/IPermit2.sol";
import {ISolverRegistry} from "../../src/interfaces/ISolverRegistry.sol";
import {IntentLib} from "../../src/libraries/IntentLib.sol";
import {Permit2Witness} from "../../src/libraries/Permit2Witness.sol";
import {Intent, IntentFlags, IntentKind, SessionMask} from "../../src/types/Types.sol";
import {CalendarFixture} from "../../script/Calendar.sol";
import {ForkFixture} from "../fixtures/ForkFixture.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";
import {MockSolverRegistry} from "../mocks/MockSolverRegistry.sol";

/// @notice Any spender that is not the AuctionHouse. Permit2 binds a signature to
/// its own caller, and this is what proves it.
contract ForeignSpender {
    ISignatureTransfer internal immutable permit2;

    constructor(ISignatureTransfer permit2_) {
        permit2 = permit2_;
    }

    function pull(
        address token,
        uint256 amount,
        uint256 nonce,
        uint256 deadline,
        address owner,
        bytes32 witness,
        string calldata witnessTypeString,
        bytes calldata signature
    ) external {
        permit2.permitWitnessTransferFrom(
            ISignatureTransfer.PermitTransferFrom({
                permitted: ISignatureTransfer.TokenPermissions({token: token, amount: amount}),
                nonce: nonce,
                deadline: deadline
            }),
            ISignatureTransfer.SignatureTransferDetails({to: address(this), requestedAmount: amount}),
            owner,
            witness,
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

/// @notice The test that decides whether checking a signature at commit time means
/// anything. AuctionHouse rebuilds the digest Permit2 will verify, so that a
/// commitment can be refused before it takes a slot in the book. If that
/// reconstruction is wrong, every commitment on mainnet would be refused, and no
/// mock can catch it because a mock would verify against the same wrong answer.
///
/// So the escrow here is pulled through the Permit2 that is actually deployed, with
/// the real USDG and the real Stock Token, using a signature built from the library
/// the contract uses.
contract AuctionHousePermit2ForkTest is Test {
    SessionManager sessions;
    PriceOracle oracle;
    AuctionHouse house;
    MockSolverRegistry registry;
    MockAggregator usdgFeed;
    MockAggregator nvdaFeed;
    IntentHasher hasher;

    ISignatureTransfer constant PERMIT2 = ISignatureTransfer(0x000000000022D473030F116dDEE9F6B43aC78BA3);
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;

    address governor = address(0x60174E);
    address treasury = address(0x7EA);

    uint256 constant TRADER_KEY = 0xBEEF;
    address trader = vm.addr(TRADER_KEY);

    /// Wednesday 23 September 2026. open_utc for that row of nyse-sessions.csv is
    /// 1790170200, so the auction session runs for the half hour before it.
    uint64 constant BELL = 1_790_170_200;
    uint64 constant AUCTION_OPEN_AT = BELL - 1800;

    function setUp() public {
        ForkFixture.selectMainnet();

        sessions = new SessionManager(governor);
        vm.startPrank(governor);
        sessions.setDstBoundaries(CalendarFixture.loadDst());
        CalendarFixture.loadCalendar(sessions, CalendarFixture.loadDays());
        vm.stopPrank();

        // The feeds are stubs because this test is about Permit2, and a live feed
        // would make it pass or fail on how recently Chainlink happened to update.
        usdgFeed = new MockAggregator(8, "USDG / USD");
        nvdaFeed = new MockAggregator(8, "RHNVDA / USD");
        oracle = new PriceOracle(ISessionManager(address(sessions)), governor);
        vm.startPrank(governor);
        oracle.setFeed(USDG, address(usdgFeed), 6000, 20_000);
        oracle.setFeed(NVDA, address(nvdaFeed), 6000, 20_000);
        vm.stopPrank();

        registry = new MockSolverRegistry();
        hasher = new IntentHasher();

        house = new AuctionHouse(
            ISessionManager(address(sessions)),
            IPriceOracle(address(oracle)),
            ISolverRegistry(address(registry)),
            PERMIT2,
            IERC20(USDG),
            treasury,
            governor
        );
        vm.prank(governor);
        house.setAuctionTokenAllowed(NVDA, true);

        vm.warp(AUCTION_OPEN_AT + 60);
        usdgFeed.push(1e8, uint64(block.timestamp));
        nvdaFeed.push(200e8, uint64(block.timestamp));

        deal(USDG, trader, 10_000e6);
        vm.prank(trader);
        IERC20(USDG).approve(address(PERMIT2), type(uint256).max);
    }

    function test_theRealPermit2AcceptsTheSignatureThisContractChecked() public {
        Intent memory i = _buyIntent(1000e6, 7);
        bytes32 intentHash = hasher.hashOf(i);

        // Relayed by someone who is not the owner, which is the whole point of
        // checking the signature here rather than trusting the sender.
        vm.prank(address(0xBE1A4));
        house.commitAuctionIntent(i, _sign(TRADER_KEY, i, intentHash));

        uint64 auctionId = house.auctionIdOf(NVDA, 20_260_923, house.KIND_OPEN());
        house.openAuction(NVDA, house.KIND_OPEN());

        vm.warp(BELL - 300);
        usdgFeed.push(1e8, uint64(block.timestamp));
        nvdaFeed.push(200e8, uint64(block.timestamp));
        house.freeze(auctionId);

        assertTrue(house.commitment(intentHash).escrowed, "the real Permit2 moved the escrow");
        assertEq(IERC20(USDG).balanceOf(address(house)), 1000e6);
        assertEq(IERC20(USDG).balanceOf(trader), 9000e6);
        uint256 bitmap = PERMIT2.nonceBitmap(trader, 7 >> 8);
        assertEq(bitmap & (2 ** (7 & 0xff)), 2 ** 7, "and the nonce was spent in Permit2 itself");
    }

    /// The other half of the claim. The digest names this contract as the spender,
    /// so a signature meant for an auction commitment is worthless to anyone else,
    /// and the real Permit2 is what enforces that rather than anything written here.
    function test_theSignatureIsWorthlessToAnySpenderButThisOne() public {
        Intent memory i = _buyIntent(1000e6, 8);
        bytes32 intentHash = hasher.hashOf(i);
        bytes memory sig = _sign(TRADER_KEY, i, intentHash);
        string memory witnessType = house.WITNESS_TYPE_STRING();

        ForeignSpender thief = new ForeignSpender(PERMIT2);
        vm.expectRevert();
        thief.pull(USDG, i.sellAmount, i.nonce, i.validUntil, trader, intentHash, witnessType, sig);

        // The same signature, spent by the contract it was made for.
        vm.prank(address(0xBE1A4));
        house.commitAuctionIntent(i, sig);
        assertEq(house.commitment(intentHash).owner, trader);
    }

    /// A commitment nobody signed never reaches the book, which is what keeps a
    /// relayed commitment from meaning an unpaid slot in it.
    function test_aCommitmentTheOwnerNeverSignedIsRefused() public {
        Intent memory i = _buyIntent(1000e6, 9);
        bytes32 intentHash = hasher.hashOf(i);
        bytes memory wrongSigner = _sign(uint256(0xDECAF), i, intentHash);

        vm.expectRevert(abi.encodeWithSelector(AuctionHouse.BadSignature.selector, intentHash));
        house.commitAuctionIntent(i, wrongSigner);
    }

    function _buyIntent(uint256 sellAmount, uint256 nonce) internal view returns (Intent memory) {
        return Intent({
            owner: trader,
            receiver: trader,
            sellToken: USDG,
            buyToken: NVDA,
            sellAmount: sellAmount,
            minBuyAmount: 0,
            validAfter: 0,
            // forge-lint: disable-next-line(unsafe-typecast)
            validUntil: uint32(BELL + 1 days),
            flags: IntentFlags.AUCTION,
            kind: uint8(IntentKind.MOO),
            maxDevFromRefBps: 0,
            allowedSessions: SessionMask.AUCTION_OPEN,
            batchSpan: 1,
            nonce: nonce
        });
    }

    function _sign(uint256 key, Intent memory i, bytes32 intentHash) internal view returns (bytes memory) {
        bytes32 digest = Permit2Witness.digest(
            PERMIT2.DOMAIN_SEPARATOR(),
            house.permitTypeHash(),
            i.sellToken,
            i.sellAmount,
            address(house),
            i.nonce,
            i.validUntil,
            intentHash
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }
}
