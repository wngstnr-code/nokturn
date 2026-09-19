// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {AuctionHouse} from "../src/AuctionHouse.sol";
import {SessionManager} from "../src/SessionManager.sol";
import {Settlement} from "../src/Settlement.sol";
import {SolverRegistry} from "../src/SolverRegistry.sol";
import {UniswapV3Adapter} from "../src/adapters/UniswapV3Adapter.sol";
import {CivilDate} from "../src/libraries/CivilDate.sol";

import {Addresses} from "./Addresses.sol";
import {CalendarFixture} from "./Calendar.sol";
import {StockTokenGate} from "./StockTokenGate.sol";

/// @notice Everything a deployed protocol needs before it can do anything, sent as
/// one batch through the timelock while its delay is still zero.
///
/// One batch rather than a dozen calls, because the protocol is either configured
/// or it is not. A half loaded calendar is a session engine that answers wrongly,
/// and a token allowed in Settlement but not in the AuctionHouse is a token that
/// trades in one venue and not the other.
///
/// The price feeds are deliberately absent. parameter.md section 7.1 says in as
/// many words not to lock PriceOracle before the feed family and the staleness are
/// decided, because the September cadence makes the July numbers throw NVDA into
/// PROTECTIVE during the busiest session. That question is P6-1. Feeds go in their
/// own step once it is answered, and by then the delay is forty eight hours, which
/// is the right amount of scrutiny for the number the whole protocol prices against.
contract Bootstrap is Script {
    /// Entries past 2028 are rule derived rather than published, so they never go
    /// on chain. The exhaustive test walks to 2035 on purpose, which is a different
    /// thing from trusting them.
    uint32 internal constant CALENDAR_END = 20_290_101;

    struct Call {
        address target;
        bytes data;
    }

    Call[] internal calls;

    function run() external {
        string memory record = vm.readFile(string.concat("deployments/", vm.toString(block.chainid), ".json"));
        runWith(
            vm.parseJsonAddress(record, ".timelock"),
            vm.parseJsonAddress(record, ".sessions"),
            vm.parseJsonAddress(record, ".settlement"),
            vm.parseJsonAddress(record, ".auctionHouse"),
            vm.parseJsonAddress(record, ".solvers"),
            vm.parseJsonAddress(record, ".adapter")
        );
    }

    /// @dev Split out from run so a fork test can drive the same batch without a
    /// deployment file, and so the batch a test checks is the batch a deploy sends.
    function runWith(
        address timelock_,
        address sessions,
        address settlement,
        address auctionHouse,
        address solvers,
        address adapter
    ) public {
        TimelockController timelock = TimelockController(payable(timelock_));
        require(timelock.getMinDelay() == 0, "bootstrap window already closed");

        _calendar(sessions);
        _wiring(settlement, solvers);
        _allowlist(settlement, auctionHouse, adapter);
        _checkCaps(settlement);

        (address[] memory targets, uint256[] memory values, bytes[] memory payloads) = _batch();

        vm.startBroadcast();
        timelock.scheduleBatch(targets, values, payloads, bytes32(0), bytes32(0), 0);
        timelock.executeBatch(targets, values, payloads, bytes32(0), bytes32(0));
        vm.stopBroadcast();

        console2.log("bootstrap sent", targets.length, "calls");
    }

    function _calendar(address sessions) internal {
        uint64[] memory boundaries = CalendarFixture.loadDst();
        _push(sessions, abi.encodeCall(SessionManager.setDstBoundaries, (boundaries)));

        CalendarFixture.Day[] memory table = CalendarFixture.loadDays();
        uint32 end = CivilDate.toDayIndex(CALENDAR_END);

        uint32[] memory dates = new uint32[](table.length);
        uint8[] memory kinds = new uint8[](table.length);
        uint32[] memory closes = new uint32[](table.length);
        uint256 n = 0;
        for (uint256 i = 0; i < table.length; ++i) {
            if (table[i].kind == 0) continue;
            if (table[i].dayIndex >= end) break;
            dates[n] = table[i].dayIndex;
            kinds[n] = table[i].kind;
            closes[n] = table[i].kind == 2 ? table[i].closeTimeEt : 0;
            ++n;
        }
        assembly {
            mstore(dates, n)
            mstore(kinds, n)
            mstore(closes, n)
        }
        require(n > 0, "calendar is empty");
        _push(sessions, abi.encodeCall(SessionManager.setCalendarEntries, (dates, kinds, closes)));
        console2.log("calendar entries through 2028:", n);
    }

    /// @dev The one call that can only ever be made once. SolverRegistry and
    /// Settlement reference each other, so the registry learns the address after
    /// both exist and refuses to learn it twice.
    function _wiring(address settlement, address solvers) internal {
        _push(solvers, abi.encodeCall(SolverRegistry.setSettlement, (settlement)));
    }

    function _allowlist(address settlement, address auctionHouse, address adapter) internal {
        // USDG is the quote side of every pair, so it is allowed in Settlement and
        // nowhere else. It is not an auction token and it has no pool of its own.
        _push(settlement, abi.encodeCall(Settlement.setTokenAllowed, (Addresses.quote(), true)));
        _push(settlement, abi.encodeCall(Settlement.setAdapterAllowed, (adapter, true)));
        // The same adapter answers the baseline floor. Without it every batch is a
        // pass through, which is safe but collects nothing. parameter.md 4C.
        _push(settlement, abi.encodeCall(Settlement.setBaselineAdapter, (adapter)));

        address[] memory tokens = Addresses.allowlist();
        address[] memory pools = Addresses.pools();
        for (uint256 k = 0; k < tokens.length; ++k) {
            StockTokenGate.check(tokens[k], vm.load(tokens[k], StockTokenGate.BEACON_SLOT));
            _push(settlement, abi.encodeCall(Settlement.setTokenAllowed, (tokens[k], true)));
            _push(auctionHouse, abi.encodeCall(AuctionHouse.setAuctionTokenAllowed, (tokens[k], true)));
            _push(adapter, abi.encodeCall(UniswapV3Adapter.setPool, (pools[k])));
        }
    }

    /// @dev The launch caps are the constructor defaults, so this asserts rather
    /// than sets. A call that writes the value already there is a call that reads
    /// as if somebody chose it today.
    function _checkCaps(address settlement) internal view {
        Settlement s = Settlement(settlement);
        require(s.capPerBatchUsd() == 5000e18, "batch cap moved from parameter.md 6");
        require(s.capPerTokenDailyUsd() == 50_000e18, "token cap moved from parameter.md 6");
        require(s.capGlobalDailyUsd() == 200_000e18, "global cap moved from parameter.md 6");
    }

    function _push(address target, bytes memory data) internal {
        calls.push(Call({target: target, data: data}));
    }

    function _batch()
        internal
        view
        returns (address[] memory targets, uint256[] memory values, bytes[] memory payloads)
    {
        targets = new address[](calls.length);
        values = new uint256[](calls.length);
        payloads = new bytes[](calls.length);
        for (uint256 k = 0; k < calls.length; ++k) {
            targets[k] = calls[k].target;
            payloads[k] = calls[k].data;
        }
    }
}
