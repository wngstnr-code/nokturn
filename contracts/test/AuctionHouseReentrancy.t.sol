// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";

import {AuctionHouse} from "../src/AuctionHouse.sol";
import {PriceOracle} from "../src/PriceOracle.sol";
import {SessionManager} from "../src/SessionManager.sol";
import {IPriceOracle} from "../src/interfaces/IPriceOracle.sol";
import {ISessionManager} from "../src/interfaces/ISessionManager.sol";
import {ISignatureTransfer} from "../src/interfaces/IPermit2.sol";
import {ISolverRegistry} from "../src/interfaces/ISolverRegistry.sol";
import {IntentLib} from "../src/libraries/IntentLib.sol";
import {Permit2Witness} from "../src/libraries/Permit2Witness.sol";
import {Intent, IntentFlags, IntentKind, SessionMask} from "../src/types/Types.sol";
import {CalendarFixture} from "./fixtures/CalendarFixture.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockPermit2} from "./mocks/MockPermit2.sol";
import {MockSolverRegistry} from "./mocks/MockSolverRegistry.sol";
import {MockSwapAdapter} from "./mocks/MockSwapAdapter.sol";
import {ReentrantERC20} from "./mocks/ReentrantERC20.sol";

contract Hasher {
    function hashOf(Intent calldata i) external pure returns (bytes32) {
        return IntentLib.hash(i);
    }
}

/// @notice A commitment owner that is a contract, which the signature check already
/// allows through EIP-1271. It is the link that turns a transfer hook into a call
/// the auction house will accept as coming from the owner.
contract HostileOwner {
    bytes4 internal constant ERC1271_ACCEPT = 0x1626ba7e;

    AuctionHouse internal house;
    bytes32 internal target;
    bool public struck;

    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        return ERC1271_ACCEPT;
    }

    function approveMax(IERC20 token, address spender) external {
        token.approve(spender, type(uint256).max);
    }

    function arm(AuctionHouse house_, bytes32 target_) external {
        house = house_;
        target = target_;
    }

    function strike() external {
        (struck,) = address(house).call(abi.encodeCall(AuctionHouse.cancelBeforeFreeze, (target)));
    }
}

/// @notice The freeze walks the book and pulls escrow through Permit2, which means
/// it hands control to the token in the middle of a loop over its own storage. The
/// book closes at the freeze, so anything that can add to it or take from it while
/// that loop runs breaks the one number this auction promises to be true.
///
/// Stock Tokens are beacon proxies to an implementation their issuer controls, so a
/// transfer hook is one upgrade away rather than impossible. That is the reason this
/// file exists rather than an assumption that allowlisted means well behaved.
contract AuctionHouseReentrancyTest is Test {
    SessionManager sessions;
    PriceOracle oracle;
    AuctionHouse house;
    MockPermit2 permit2;
    MockSolverRegistry registry;
    MockSwapAdapter adapter;
    Hasher hasher;

    MockERC20 usdg;
    ReentrantERC20 nvda;
    MockAggregator usdgFeed;
    MockAggregator nvdaFeed;

    address governor = address(0x60174E);
    address treasury = address(0x7EA);
    address solver = address(0x501E);
    address relayer = address(0xBE1A4);

    uint256 constant ALICE_KEY = 0xA11CE;
    uint256 constant BOB_KEY = 0xB0B;
    uint256 constant CAROL_KEY = 0xCA401;
    address alice = vm.addr(ALICE_KEY);
    address bob = vm.addr(BOB_KEY);
    address carol = vm.addr(CAROL_KEY);

    uint64 constant BELL = 1_773_235_800;
    uint64 constant AUCTION_OPEN_AT = BELL - 1800;
    uint64 constant FREEZE_AT = BELL - 300;
    uint64 constant CLOSE_BELL = BELL + 23_400;

    uint8 kindOpen;

    function setUp() public {
        sessions = new SessionManager(governor);
        vm.startPrank(governor);
        sessions.setDstBoundaries(CalendarFixture.loadDst());
        CalendarFixture.loadCalendar(sessions, CalendarFixture.loadDays());
        vm.stopPrank();

        usdg = new MockERC20("Global Dollar", "USDG", 6);
        nvda = new ReentrantERC20("Nvidia", "NVDA", 18);
        usdgFeed = new MockAggregator(8, "USDG / USD");
        nvdaFeed = new MockAggregator(8, "RHNVDA / USD");
        adapter = new MockSwapAdapter();
        hasher = new Hasher();

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
        nvda.mint(bob, 100e18);
        nvda.mint(carol, 100e18);

        vm.prank(alice);
        usdg.approve(address(permit2), type(uint256).max);
        vm.prank(bob);
        nvda.approve(address(permit2), type(uint256).max);
        vm.prank(carol);
        nvda.approve(address(permit2), type(uint256).max);

        kindOpen = house.KIND_OPEN();

        vm.warp(AUCTION_OPEN_AT + 60);
        usdgFeed.push(1e8, block.timestamp);
        nvdaFeed.push(200e8, block.timestamp);
    }

    /// The book closes at the freeze. A token that calls back into the commit path
    /// while the escrow loop runs would slip an entry in after seeing which pulls
    /// succeeded, and the loop rereads the book length, so that entry would be
    /// escrowed in the same pass.
    function test_aTokenCannotAddToTheBookWhileTheFreezeWalksIt() public {
        _commit(_buy(alice, 2000e6, 1));
        _commit(_sell(bob, 10e18, 2));

        Intent memory latecomer = _sell(carol, 5e18, 3);
        bytes32 latecomerHash = hasher.hashOf(latecomer);
        nvda.armFor(
            address(house),
            abi.encodeCall(house.commitAuctionIntent, (latecomer, _sign(CAROL_KEY, latecomer)))
        );

        uint64 auctionId = house.auctionIdOf(address(nvda), 20_260_311, kindOpen);
        house.openAuction(address(nvda), kindOpen);

        vm.warp(FREEZE_AT);
        usdgFeed.push(1e8, block.timestamp);
        nvdaFeed.push(200e8, block.timestamp);
        house.freeze(auctionId);

        assertTrue(nvda.fired(), "the token did get its callback");
        assertFalse(nvda.reentered(), "and the guard refused it");
        assertEq(house.bookLength(auctionId), 2, "the book still holds who it held at the freeze");
        assertEq(house.commitment(latecomerHash).owner, address(0), "the latecomer never joined");
    }

    /// The other half, and the one that costs the auction money. The callback lands
    /// before the pull records the escrow, so an owner that cancels itself there
    /// ends up both escrowed and cancelled. Its funds are counted in the frozen
    /// imbalance that liquidity providers act on, and it can still take them back
    /// through the refund afterwards.
    function test_anOwnerCannotCancelItselfOutWhileItsOwnEscrowIsBeingPulled() public {
        HostileOwner hostile = new HostileOwner();
        nvda.mint(address(hostile), 10e18);
        hostile.approveMax(IERC20(address(nvda)), address(permit2));

        _commit(_buy(alice, 2000e6, 1));
        Intent memory sale = _sell(address(hostile), 10e18, 2);
        bytes32 hostileHash = hasher.hashOf(sale);
        vm.prank(relayer);
        house.commitAuctionIntent(sale, "");

        hostile.arm(house, hostileHash);
        nvda.armFor(address(hostile), abi.encodeCall(HostileOwner.strike, ()));

        uint64 auctionId = house.auctionIdOf(address(nvda), 20_260_311, kindOpen);
        house.openAuction(address(nvda), kindOpen);

        vm.warp(FREEZE_AT);
        usdgFeed.push(1e8, block.timestamp);
        nvdaFeed.push(200e8, block.timestamp);
        house.freeze(auctionId);

        assertTrue(nvda.fired(), "the hook ran");
        assertFalse(hostile.struck(), "and the cancel inside it was refused");
        assertTrue(house.commitment(hostileHash).escrowed);
        assertFalse(house.commitment(hostileHash).cancelled, "so nothing is escrowed and cancelled at once");
    }

    function _buy(address owner, uint256 usdgAmount, uint256 nonce) internal view returns (Intent memory) {
        return _intent(owner, true, usdgAmount, nonce);
    }

    function _sell(address owner, uint256 tokenAmount, uint256 nonce) internal view returns (Intent memory) {
        return _intent(owner, false, tokenAmount, nonce);
    }

    function _intent(address owner, bool buy, uint256 sellAmount, uint256 nonce)
        internal
        view
        returns (Intent memory)
    {
        return Intent({
            owner: owner,
            receiver: owner,
            sellToken: buy ? address(usdg) : address(nvda),
            buyToken: buy ? address(nvda) : address(usdg),
            sellAmount: sellAmount,
            minBuyAmount: 0,
            validAfter: 0,
            // forge-lint: disable-next-line(unsafe-typecast)
            validUntil: uint32(CLOSE_BELL + 1 days),
            flags: IntentFlags.AUCTION,
            kind: uint8(IntentKind.MOO),
            maxDevFromRefBps: 0,
            allowedSessions: SessionMask.AUCTION_OPEN,
            batchSpan: 1,
            nonce: nonce
        });
    }

    function _commit(Intent memory i) internal returns (bytes32 hash) {
        hash = hasher.hashOf(i);
        vm.prank(relayer);
        house.commitAuctionIntent(i, _sign(_keyOf(i.owner), i));
    }

    function _keyOf(address who) internal view returns (uint256) {
        if (who == alice) return ALICE_KEY;
        if (who == bob) return BOB_KEY;
        return CAROL_KEY;
    }

    function _sign(uint256 key, Intent memory i) internal view returns (bytes memory) {
        bytes32 digest = Permit2Witness.digest(
            permit2.DOMAIN_SEPARATOR(),
            house.permitTypeHash(),
            i.sellToken,
            i.sellAmount,
            address(house),
            i.nonce,
            i.validUntil,
            hasher.hashOf(i)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }
}
