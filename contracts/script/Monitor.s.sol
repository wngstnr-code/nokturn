// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {Guarded} from "../src/Guarded.sol";

import {Addresses} from "./Addresses.sol";
import {MonitorChecks} from "./MonitorChecks.sol";

/// @notice Reads the live chain and says whether the protocol should be stopped.
///
/// Running it with no arguments reads and reports and needs no key at all. Calling
/// pause needs pauseIfBreached and a named account, because a monitor that holds a
/// hot guardian key by default is a monitor that leaks one. parameter.md section 8.3.
///
/// The verdict goes out as a single greppable line rather than as an exit code, so a
/// run that died on its way to a conclusion is silence rather than a quiet all
/// clear. tools/monitor.py refuses a pass that has no verdict line.
contract Monitor is Script {
    string internal constant VERDICT_OK = "nokturn monitor verdict: ok";
    string internal constant VERDICT_ALERT = "nokturn monitor verdict: alert";
    string internal constant VERDICT_PAUSE = "nokturn monitor verdict: pause";

    function run() external view {
        (MonitorChecks.Targets memory t,) = _targets();
        report(t);
    }

    function pauseIfBreached() external {
        (MonitorChecks.Targets memory t,) = _targets();
        if (!report(t)) return;

        vm.startBroadcast();
        Guarded(t.settlement).pause();
        Guarded(t.auctionHouse).pause();
        vm.stopBroadcast();
        console2.log(
            "paused settlement and the auction house, lapses in", Guarded(t.settlement).PAUSE_DURATION()
        );
    }

    /// @dev Public so the test suite drives the same code a run does rather than a
    /// copy of it that can drift.
    function report(MonitorChecks.Targets memory t) public view returns (bool pauseNeeded) {
        MonitorChecks.Finding[] memory findings = MonitorChecks.evaluate(t);

        for (uint256 k = 0; k < findings.length; ++k) {
            MonitorChecks.Finding memory f = findings[k];
            console2.log(
                string.concat(
                    f.code,
                    f.pause ? " PAUSE " : " alert ",
                    f.reason,
                    " token ",
                    vm.toString(f.token),
                    " at ",
                    vm.toString(f.subject)
                )
            );
            console2.log("  observed", f.observed, "expected", f.expected);
        }

        pauseNeeded = MonitorChecks.pausesNeeded(findings);
        if (pauseNeeded) console2.log(VERDICT_PAUSE);
        else if (findings.length > 0) console2.log(VERDICT_ALERT);
        else console2.log(VERDICT_OK);
    }

    function _targets() internal view returns (MonitorChecks.Targets memory t, string memory record) {
        record = vm.readFile(string.concat("deployments/", vm.toString(block.chainid), ".json"));
        t = MonitorChecks.Targets({
            settlement: vm.parseJsonAddress(record, ".settlement"),
            auctionHouse: vm.parseJsonAddress(record, ".auctionHouse"),
            timelock: vm.parseJsonAddress(record, ".timelock"),
            oracle: vm.parseJsonAddress(record, ".oracle"),
            quote: Addresses.quote(),
            tokens: Addresses.allowlist()
        });
    }
}
