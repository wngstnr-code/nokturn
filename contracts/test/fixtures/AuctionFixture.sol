// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AuctionHouse} from "../../src/AuctionHouse.sol";
import {ClosingPrintFeed} from "../../src/ClosingPrintFeed.sol";
import {PriceOracle} from "../../src/PriceOracle.sol";
import {SessionManager} from "../../src/SessionManager.sol";
import {IAuctionHouse} from "../../src/interfaces/IAuctionHouse.sol";
import {IPriceOracle} from "../../src/interfaces/IPriceOracle.sol";
import {ISessionManager} from "../../src/interfaces/ISessionManager.sol";
import {ISignatureTransfer} from "../../src/interfaces/IPermit2.sol";
import {ISolverRegistry} from "../../src/interfaces/ISolverRegistry.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IntentLib} from "../../src/libraries/IntentLib.sol";
import {Permit2Witness} from "../../src/libraries/Permit2Witness.sol";
import {Execution, Intent, IntentFlags, IntentKind, SessionMask} from "../../src/types/Types.sol";
import {CalendarFixture} from "../../script/Calendar.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockPermit2} from "../mocks/MockPermit2.sol";
import {MockSolverRegistry} from "../mocks/MockSolverRegistry.sol";
import {MockSwapAdapter} from "../mocks/MockSwapAdapter.sol";

contract IntentHasher {
    function hashOf(Intent calldata i) external pure returns (bytes32) {
        return IntentLib.hash(i);
    }
}

abstract contract AuctionFixture is Test {
    SessionManager sessions;
    PriceOracle oracle;
    AuctionHouse house;
    MockPermit2 permit2;
    MockSolverRegistry registry;
    MockSwapAdapter adapter;
    IntentHasher hasher;

    MockERC20 usdg;
    MockERC20 nvda;
    MockAggregator usdgFeed;
    MockAggregator nvdaFeed;

    address governor = address(0x60174E);
    address treasury = address(0x7EA);
    address solver = address(0x501E);

    /// Owners are keys now, not literals, because a commitment carries a real
    /// Permit2 signature and the contract checks it before the entry joins the book.
    uint256 constant ALICE_KEY = 0xA11CE;
    uint256 constant BOB_KEY = 0xB0B;
    uint256 constant CAROL_KEY = 0xCA401;
    uint256 constant DAVE_KEY = 0xDA3E;
    uint256 constant ERIN_KEY = 0xE61;

    address alice = vm.addr(ALICE_KEY);
    address bob = vm.addr(BOB_KEY);
    address carol = vm.addr(CAROL_KEY);

    mapping(address => uint256) internal keyOf;

    /// Wednesday 11 March 2026. 09:30 New York is 13:30 UTC once EDT has started.
    uint64 constant BELL = 1_773_235_800;
    uint64 constant AUCTION_OPEN_AT = BELL - 1800;
    uint64 constant FREEZE_AT = BELL - 300;
    uint64 constant REFERENCE_AT = BELL + 300;
    uint32 constant DAY = 20_260_311;

    /// 16:00 New York on the same day.
    uint64 constant CLOSE_BELL = BELL + 23_400;

    uint256 constant BOND = 500e6;

    uint8 kindOpen;
    uint8 kindClose;

    function setUp() public {
        sessions = new SessionManager(governor);
        vm.startPrank(governor);
        sessions.setDstBoundaries(CalendarFixture.loadDst());
        CalendarFixture.loadCalendar(sessions, CalendarFixture.loadDays());
        vm.stopPrank();

        usdg = new MockERC20("Global Dollar", "USDG", 6);
        nvda = new MockERC20("Nvidia", "NVDA", 18);
        usdgFeed = new MockAggregator(8, "USDG / USD");
        nvdaFeed = new MockAggregator(8, "RHNVDA / USD");
        adapter = new MockSwapAdapter();
        hasher = new IntentHasher();

        oracle = new PriceOracle(ISessionManager(address(sessions)), governor);
        vm.startPrank(governor);
        oracle.setFeed(address(usdg), address(usdgFeed), 6000, 20_000);
        oracle.setFeed(address(nvda), address(nvdaFeed), 6000, 20_000);
        oracle.setTwapSource(address(usdg), address(adapter), address(nvda), 1800);
        oracle.setTwapSource(address(nvda), address(adapter), address(usdg), 1800);
        vm.stopPrank();

        registry = new MockSolverRegistry();
        registry.setActive(solver, true);
        permit2 = new MockPermit2();

        house = new AuctionHouse(
            ISessionManager(address(sessions)),
            IPriceOracle(address(oracle)),
            ISolverRegistry(address(registry)),
            ISignatureTransfer(address(permit2)),
            IERC20(address(usdg)),
            treasury,
            governor
        );
        vm.prank(governor);
        house.setAuctionTokenAllowed(address(nvda), true);

        adapter.setRate(address(nvda), address(usdg), 200e18);
        adapter.setRate(address(usdg), address(nvda), 0.005e18);

        usdg.mint(alice, 100_000e6);
        usdg.mint(carol, 100_000e6);
        usdg.mint(solver, 10_000e6);
        nvda.mint(bob, 100e18);
        nvda.mint(carol, 100e18);

        vm.prank(alice);
        usdg.approve(address(permit2), type(uint256).max);
        vm.prank(carol);
        usdg.approve(address(permit2), type(uint256).max);
        vm.prank(bob);
        nvda.approve(address(permit2), type(uint256).max);
        vm.prank(carol);
        nvda.approve(address(permit2), type(uint256).max);
        vm.prank(solver);
        usdg.approve(address(house), type(uint256).max);

        keyOf[alice] = ALICE_KEY;
        keyOf[bob] = BOB_KEY;
        keyOf[carol] = CAROL_KEY;

        kindOpen = house.KIND_OPEN();
        kindClose = house.KIND_CLOSE();

        vm.warp(AUCTION_OPEN_AT + 60);
        _pushFeeds(200e8, uint64(block.timestamp));
    }

    function _pushFeeds(int256 nvdaPrice, uint64 at) internal {
        usdgFeed.push(1e8, at);
        nvdaFeed.push(nvdaPrice, at);
    }

    function _intent(
        address owner,
        bool buy,
        uint256 sellAmount,
        uint256 minBuyAmount,
        IntentKind kind,
        uint16 devBps,
        uint8 sessionBit,
        uint256 nonce
    ) internal view returns (Intent memory i) {
        i = Intent({
            owner: owner,
            receiver: owner,
            sellToken: buy ? address(usdg) : address(nvda),
            buyToken: buy ? address(nvda) : address(usdg),
            sellAmount: sellAmount,
            minBuyAmount: minBuyAmount,
            validAfter: 0,
            // forge-lint: disable-next-line(unsafe-typecast)
            validUntil: uint32(CLOSE_BELL + 1 days),
            flags: IntentFlags.AUCTION,
            kind: uint8(kind),
            maxDevFromRefBps: devBps,
            allowedSessions: sessionBit,
            batchSpan: 1,
            nonce: nonce
        });
    }

    function _commit(Intent memory i) internal returns (bytes32 hash) {
        hash = hasher.hashOf(i);
        house.commitAuctionIntent(i, _sign(keyOf[i.owner], i, hash));
    }

    function _commitSignature(Intent memory i) internal view returns (bytes memory) {
        return _sign(keyOf[i.owner], i, hasher.hashOf(i));
    }

    /// The same digest the deployed Permit2 verifies. Built from the library the
    /// contract itself uses, and proved against the real Permit2 in
    /// test/fork/AuctionHousePermit2Fork.t.sol, because a mock would only ever
    /// agree with whatever answer this file produced.
    function _sign(uint256 key, Intent memory i, bytes32 hash) internal view returns (bytes memory) {
        bytes32 digest = Permit2Witness.digest(
            permit2.DOMAIN_SEPARATOR(),
            house.permitTypeHash(),
            i.sellToken,
            i.sellAmount,
            address(house),
            i.nonce,
            i.validUntil,
            hash
        );
        (uint8 v, bytes32 r, bytes32 vs) = vm.sign(key, digest);
        return abi.encodePacked(r, vs, v);
    }

    function _buyMoo(address owner, uint256 usdgAmount, uint256 nonce) internal returns (bytes32) {
        return
            _commit(_intent(owner, true, usdgAmount, 0, IntentKind.MOO, 0, SessionMask.AUCTION_OPEN, nonce));
    }

    function _sellMoo(address owner, uint256 tokenAmount, uint256 nonce) internal returns (bytes32) {
        return
            _commit(_intent(owner, false, tokenAmount, 0, IntentKind.MOO, 0, SessionMask.AUCTION_OPEN, nonce));
    }

    function _openAndFreeze() internal returns (uint64 auctionId) {
        auctionId = house.auctionIdOf(address(nvda), DAY, kindOpen);
        house.openAuction(address(nvda), kindOpen);
        vm.warp(FREEZE_AT);
        _pushFeeds(200e8, uint64(block.timestamp));
        house.freeze(auctionId);
    }

    /// Reaches the point where the opening reference exists, which is 300 seconds
    /// past the bell and not one second earlier. Before that window closes a ROO
    /// intent has nothing to be relative to.
    function _passOpeningReference(int256 price) internal {
        vm.warp(BELL + 10);
        _pushFeeds(price, uint64(block.timestamp));
        vm.warp(BELL + 200);
        _pushFeeds(price, uint64(block.timestamp));
        vm.warp(REFERENCE_AT + 1);
        // forge-lint: disable-next-line(unsafe-typecast)
        oracle.finalizeOpenReference(address(nvda), uint32(BELL / 1 days));
    }

    /// Lets the reference window close without the two feed updates it needs, which
    /// is the case where a ROO intent has to be dropped rather than guessed at.
    function _passOpeningReferenceWithoutUpdates() internal {
        vm.warp(REFERENCE_AT + 1);
    }

    function _fund(address who, uint256 key) internal {
        keyOf[who] = key;
        _fund(who);
    }

    function _fund(address who) internal {
        usdg.mint(who, 100_000e6);
        nvda.mint(who, 100e18);
        vm.startPrank(who);
        usdg.approve(address(permit2), type(uint256).max);
        nvda.approve(address(permit2), type(uint256).max);
        vm.stopPrank();
    }

    function _commitClose(address owner, bool buy, uint256 amount, uint256 nonce) internal {
        _commit(_intent(owner, buy, amount, 0, IntentKind.MOO, 0, SessionMask.AUCTION_CLOSE, nonce));
    }

    function _closeAuctionFrozen() internal returns (uint64 id) {
        id = house.auctionIdOf(address(nvda), DAY, kindClose);
        house.openAuction(address(nvda), kindClose);
        vm.warp(CLOSE_BELL - 300);
        _pushFeeds(200e8, uint64(block.timestamp));
        house.freeze(id);
        vm.warp(CLOSE_BELL);
    }

    function _enterClosingAuction() internal {
        vm.warp(CLOSE_BELL - 1800 + 60);
        _pushFeeds(200e8, uint64(block.timestamp));
    }

    function _exec(uint256 index, uint256 sell, uint256 buy) internal pure returns (Execution memory) {
        return Execution({intentIndex: index, executedSell: sell, executedBuy: buy});
    }
}
