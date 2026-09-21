// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {console2} from "forge-std/console2.sol";

import {AuctionHouse} from "../../src/AuctionHouse.sol";
import {SolverRegistry} from "../../src/SolverRegistry.sol";
import {ISessionManager} from "../../src/interfaces/ISessionManager.sol";
import {Permit2Witness} from "../../src/libraries/Permit2Witness.sol";
import {Execution, Intent, IntentFlags, IntentKind, Session, SessionMask} from "../../src/types/Types.sol";

import {Addresses} from "../Addresses.sol";
import {DemoBase} from "./DemoBase.sol";
import {IntentHasher} from "./IntentHasher.sol";

/// @notice The closing cross for NVDA, run on a fork of mainnet 4663.
///
/// This is the one screen the batch demo cannot show, because a closing auction
/// only exists in the half hour before the bell and the batch demo stands in the
/// weekend. It needs its own fork at its own block, and the reason is measured
/// rather than assumed. NVDA's open session staleness bound is 19,000 seconds, and
/// the weekend pin is already 131,777 seconds past the last feed write, so warping
/// a weekend fork forward to the next close leaves every feed dead and the oracle
/// answering unhealthy. See tools/fork-auction.sh.
///
/// Five committers, because the print is withheld below five participants and the
/// point of the closing cross is the print. Two sell, three buy, one solver crosses
/// them, and everything they trade came out of the real pools.
contract ForkAuction is DemoBase {
    string internal constant AUCTION_PATH = "deployments/demo-auction.txt";

    uint8 internal constant KIND_CLOSE = 1;

    /// Each seller's leg. Ten NVDA across the two of them is a little over two
    /// thousand dollars, which clears the thousand dollar floor the print needs.
    uint256 internal constant SELL_NVDA_EACH = 5e18;

    /// Each buyer commits more than a third of that, so the cross is limited by the
    /// sell side and the buy side has room left over. An auction where both sides
    /// happen to be equal hides which one set the volume.
    uint256 internal constant BUY_USDG_EACH = 1000e6;

    function _sellers(Actors memory a) internal pure returns (address[2] memory who, uint256[2] memory keys) {
        who = [a.users[1], a.users[3]];
        keys = [a.userKeys[1], a.userKeys[3]];
    }

    function _buyers(Actors memory a) internal pure returns (address[3] memory who, uint256[3] memory keys) {
        who = [a.users[0], a.users[2], a.solvers[1]];
        keys = [a.userKeys[0], a.userKeys[2], a.solverKeys[1]];
    }

    /// @notice Refuses to go on unless the fork is standing where a close can happen.
    function prepare() external {
        Deployed memory d = _deployed();
        Actors memory a = _actors();

        Session session = ISessionManager(d.sessions).sessionAt(uint64(block.timestamp));
        require(session == Session.AUCTION_CLOSE, "the fork clock is not inside a closing auction");

        address usdg = Addresses.quote();
        address nvda = Addresses.NVDA;

        (address[2] memory sellers,) = _sellers(a);
        for (uint256 k = 0; k < 2; ++k) {
            require(IERC20(nvda).balanceOf(sellers[k]) >= SELL_NVDA_EACH, "a seller is short of nvda");
            require(
                IERC20(nvda).allowance(sellers[k], Addresses.PERMIT2) >= SELL_NVDA_EACH,
                "a seller has not approved permit2"
            );
        }

        (address[3] memory buyers, uint256[3] memory buyerKeys) = _buyers(a);
        for (uint256 k = 0; k < 3; ++k) {
            require(IERC20(usdg).balanceOf(buyers[k]) >= BUY_USDG_EACH, "a buyer is short of usdg");
        }

        // The fifth committer is the second solver, and make fund only opens Permit2
        // for the four named users. The approval is granted here by the account that
        // owns the funds, which is what any participant does before committing, and
        // nothing is moved to anybody.
        if (IERC20(usdg).allowance(buyers[2], Addresses.PERMIT2) < BUY_USDG_EACH) {
            vm.startBroadcast(buyerKeys[2]);
            IERC20(usdg).approve(Addresses.PERMIT2, type(uint256).max);
            vm.stopBroadcast();
        }

        // The cross carries its own bond, separate from the registry stake, and it is
        // pulled with a plain transferFrom rather than through Permit2.
        uint256 bond = AuctionHouse(d.auctionHouse).bond();
        require(IERC20(usdg).balanceOf(a.solvers[0]) >= bond, "the crossing solver cannot cover the bond");
        require(SolverRegistry(d.solvers).isActive(a.solvers[0]), "the crossing solver is not bonded");

        vm.startBroadcast(a.solverKeys[0]);
        IERC20(usdg).approve(d.auctionHouse, bond);
        IntentHasher hasher = new IntentHasher();
        vm.stopBroadcast();
        vm.writeFile(HASHER_PATH, vm.toString(address(hasher)));

        console2.log("session", uint8(session));
        console2.log("auction bond", bond);
    }

    /// @notice Opens the cross and puts five intents into the book.
    function open() external {
        Deployed memory d = _deployed();
        Actors memory a = _actors();
        AuctionHouse house = AuctionHouse(d.auctionHouse);

        vm.startBroadcast(a.solverKeys[0]);
        house.openAuction(Addresses.NVDA, KIND_CLOSE);
        vm.stopBroadcast();

        uint64 auctionId = house.auctionCount();
        vm.writeFile(AUCTION_PATH, vm.toString(uint256(auctionId)));

        (, uint64 crossAt,) = _timing(house, auctionId);
        bytes32 typeHash = Permit2Witness.typeHash(house.WITNESS_TYPE_STRING());

        (address[2] memory sellers, uint256[2] memory sellerKeys) = _sellers(a);
        for (uint256 k = 0; k < 2; ++k) {
            Intent memory i =
                _intent(sellers[k], Addresses.NVDA, Addresses.quote(), SELL_NVDA_EACH, crossAt, k);
            _commit(house, d.auctionHouse, typeHash, i, sellerKeys[k]);
        }

        (address[3] memory buyers, uint256[3] memory buyerKeys) = _buyers(a);
        for (uint256 k = 0; k < 3; ++k) {
            Intent memory i =
                _intent(buyers[k], Addresses.quote(), Addresses.NVDA, BUY_USDG_EACH, crossAt, k + 2);
            _commit(house, d.auctionHouse, typeHash, i, buyerKeys[k]);
        }

        console2.log("auction", auctionId);
        console2.log("book", house.bookLength(auctionId));
        console2.log("crossAt", crossAt);
    }

    /// @notice Publishes the indicative price, then pulls the escrow.
    function freeze() external {
        Deployed memory d = _deployed();
        Actors memory a = _actors();
        AuctionHouse house = AuctionHouse(d.auctionHouse);
        uint64 auctionId = _auctionId();

        (uint256 before, uint256 matched, int256 imbalance) = house.indicative(auctionId);
        console2.log("indicative price", before);
        console2.log("indicative matched", matched);
        console2.logInt(imbalance);

        vm.startBroadcast(a.solverKeys[0]);
        house.publishIndicative(auctionId);
        house.freeze(auctionId);
        vm.stopBroadcast();

        console2.log("frozen", auctionId);
    }

    /// @notice Crosses the book at the price the search found.
    function cross() external {
        Deployed memory d = _deployed();
        Actors memory a = _actors();
        AuctionHouse house = AuctionHouse(d.auctionHouse);
        uint64 auctionId = _auctionId();

        (uint256 price, uint256 matched,) = house.indicative(auctionId);
        require(matched > 0, "nothing matched at any price in the collar");

        Execution[] memory e = _executions(house, auctionId, price);

        vm.startBroadcast(a.solverKeys[0]);
        house.submitCross(auctionId, price, e);
        vm.stopBroadcast();

        console2.log("crossed at", price);
        console2.log("matched", matched);
    }

    /// @notice Executes after the challenge window and reads the print back.
    function execute() external {
        Deployed memory d = _deployed();
        Actors memory a = _actors();
        AuctionHouse house = AuctionHouse(d.auctionHouse);
        uint64 auctionId = _auctionId();

        vm.startBroadcast(a.solverKeys[0]);
        house.executeCross(auctionId);
        vm.stopBroadcast();

        // Everyone whose commitment was not filled in full gets the rest back, and
        // it does not come back on its own. The escrow is pulled for the whole
        // amount at the freeze, because a book that only holds what turns out to be
        // fillable is a book nobody can price before the cross. So the buyers here
        // are charged for a thousand and filled for what the sell side could
        // supply, and this is the call that closes the difference.
        uint256 book = house.bookLength(auctionId);
        vm.startBroadcast(a.solverKeys[0]);
        for (uint256 k = 0; k < book; ++k) {
            house.refundEscrow(house.bookAt(auctionId, k));
        }
        vm.stopBroadcast();

        (uint256 price, uint256 ts, bool sufficient) = house.lastClose(Addresses.NVDA);
        console2.log("closing print", price);
        console2.log("print at", ts);
        console2.log("print published", sufficient);
    }

    function _commit(AuctionHouse house, address spender, bytes32 typeHash, Intent memory i, uint256 key)
        internal
    {
        bytes memory sig = _signFor(key, spender, typeHash, i);
        vm.startBroadcast(key);
        house.commitAuctionIntent(i, sig);
        vm.stopBroadcast();
    }

    /// @dev Market on auction, so there is no limit to respect and the whole book
    /// participates at whatever price the search lands on. A limit order would be a
    /// second screen, not a better version of this one.
    function _intent(
        address owner,
        address sellToken,
        address buyToken,
        uint256 sellAmount,
        uint64 crossAt,
        uint256 slot
    ) internal pure returns (Intent memory i) {
        i = Intent({
            owner: owner,
            receiver: owner,
            sellToken: sellToken,
            buyToken: buyToken,
            sellAmount: sellAmount,
            minBuyAmount: 0,
            validAfter: 0,
            // forge-lint: disable-next-line(unsafe-typecast)
            validUntil: uint32(crossAt + 1 hours),
            flags: IntentFlags.AUCTION,
            kind: uint8(IntentKind.MOO),
            maxDevFromRefBps: 0,
            allowedSessions: SessionMask.AUCTION_CLOSE,
            batchSpan: 1,
            nonce: uint256(crossAt) * 8 + slot
        });
    }

    /// @dev Sellers fill in full and the buyers absorb exactly what they produced,
    /// split three ways with the remainder on the last one. Conservation is checked
    /// on both tokens by the contract, and the rounding has to fall towards it.
    function _executions(AuctionHouse house, uint64 auctionId, uint256 price)
        internal
        view
        returns (Execution[] memory e)
    {
        e = new Execution[](5);

        uint256 quoteOut;
        for (uint256 k = 0; k < 2; ++k) {
            uint256 proceeds = (SELL_NVDA_EACH * price) / WAD;
            e[k] = Execution({
                // forge-lint: disable-next-line(unsafe-typecast)
                intentIndex: uint32(k),
                executedSell: SELL_NVDA_EACH,
                executedBuy: proceeds
            });
            quoteOut += proceeds;
        }

        uint256 share = quoteOut / 3;
        for (uint256 k = 0; k < 3; ++k) {
            uint256 spend = k == 2 ? quoteOut - 2 * share : share;
            require(spend <= BUY_USDG_EACH, "a buyer cannot cover its share of the cross");
            e[k + 2] = Execution({
                // forge-lint: disable-next-line(unsafe-typecast)
                intentIndex: uint32(k + 2),
                executedSell: spend,
                executedBuy: (spend * WAD) / price
            });
        }

        require(house.bookLength(auctionId) == 5, "the book is not the five intents this builds for");
    }

    function _timing(AuctionHouse house, uint64 auctionId)
        internal
        view
        returns (uint64 freezeAt, uint64 crossAt, uint64 referenceAt)
    {
        return house.auctionTiming(auctionId);
    }

    function _auctionId() internal view returns (uint64) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint64(vm.parseUint(vm.readFile(AUCTION_PATH)));
    }
}
