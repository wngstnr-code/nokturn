// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {PriceOracle} from "../src/PriceOracle.sol";

import {Addresses} from "./Addresses.sol";

/// @notice Gives PriceOracle the two sources it prices against, as one timelock
/// proposal that has to wait out the full forty eight hours.
///
/// This is deliberately not part of the bootstrap. The bootstrap runs while the
/// delay is still zero, and the number the whole protocol prices against should not
/// be settable in one block by whoever holds the deploy key. parameter.md section
/// 7.1 held these back until P6-1 was answered, and P6-1 was answered on
/// 19 September 2026 with the RH feed family and a p99 staleness per feed.
///
/// Both sources go in one batch because an oracle with a feed and no TWAP has no
/// second opinion on a weekday and no price at all on a weekend, and one with a
/// TWAP and no feed anchors the market to itself.
///
/// Run it twice. The first run schedules and prints when it can be executed, the
/// second run executes. There is no flag for that, because a script that can be
/// told to skip the wait is a script somebody will tell to skip the wait.
contract SetFeeds is Script {
    bytes32 public constant SALT = keccak256("nokturn.oracle.sources.v1");

    function run() external {
        string memory record = vm.readFile(string.concat("deployments/", vm.toString(block.chainid), ".json"));
        runWith(
            vm.parseJsonAddress(record, ".timelock"),
            vm.parseJsonAddress(record, ".oracle"),
            vm.parseJsonAddress(record, ".adapter")
        );
    }

    function runWith(address timelock_, address oracle, address adapter) public {
        require(
            block.chainid == Addresses.MAINNET, "chain 46630 has no chainlink feed, see parameter.md 10.6"
        );

        TimelockController timelock = TimelockController(payable(timelock_));
        (address[] memory targets, uint256[] memory values, bytes[] memory payloads) = batch(oracle, adapter);
        bytes32 id = timelock.hashOperationBatch(targets, values, payloads, bytes32(0), SALT);

        if (timelock.isOperationReady(id)) {
            vm.startBroadcast();
            timelock.executeBatch(targets, values, payloads, bytes32(0), SALT);
            vm.stopBroadcast();
            console2.log("executed, the oracle now prices", targets.length / 2, "tokens");
            return;
        }

        if (timelock.isOperationPending(id)) {
            console2.log("already scheduled, executable at", timelock.getTimestamp(id));
            return;
        }

        vm.startBroadcast();
        timelock.scheduleBatch(targets, values, payloads, bytes32(0), SALT, timelock.getMinDelay());
        vm.stopBroadcast();
        console2.log("scheduled, executable at", timelock.getTimestamp(id));
    }

    /// @dev Public so a fork test checks the batch a deploy actually sends rather
    /// than a copy of it that can drift.
    function batch(address oracle, address adapter)
        public
        view
        returns (address[] memory targets, uint256[] memory values, bytes[] memory payloads)
    {
        address[] memory tokens = Addresses.allowlist();
        address[] memory aggregators = Addresses.feeds();
        uint32[] memory open = Addresses.stalenessOpen();
        uint32[] memory closed = Addresses.stalenessClosed();

        // The quote asset takes a feed and no twap source. It is priced in every
        // solution and there is no pool of USDG against itself to read.
        uint256 n = tokens.length * 2 + 1;
        targets = new address[](n);
        values = new uint256[](n);
        payloads = new bytes[](n);

        for (uint256 i = 0; i < tokens.length; i++) {
            targets[i] = oracle;
            payloads[i] = abi.encodeCall(PriceOracle.setFeed, (tokens[i], aggregators[i], open[i], closed[i]));

            uint256 j = tokens.length + i;
            targets[j] = oracle;
            payloads[j] = abi.encodeCall(
                PriceOracle.setTwapSource, (tokens[i], adapter, Addresses.quote(), Addresses.TWAP_WINDOW)
            );
        }

        targets[n - 1] = oracle;
        payloads[n - 1] = abi.encodeCall(
            PriceOracle.setFeed,
            (Addresses.quote(), Addresses.FEED_USDG, Addresses.STALENESS_USDG, Addresses.STALENESS_USDG)
        );
    }
}
