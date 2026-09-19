// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @notice Closes the bootstrap window by raising the timelock delay to the forty
/// eight hours CLAUDE.md rule 6 requires.
///
/// This is the transaction the whole deploy is arranged around. Before it, an
/// operator can change an allowlist in one block. After it, nothing changes without
/// two days of notice that anybody can watch, and the timelock will not lower
/// itself again except through its own delay.
///
/// It is a separate script rather than the tail of the bootstrap, so that it leaves
/// its own transaction with its own hash. A window that closes inside somebody
/// else's transaction is a window nobody can point at afterwards.
contract Lock is Script {
    uint256 public constant DELAY = 48 hours;

    function run() external {
        string memory record = vm.readFile(string.concat("deployments/", vm.toString(block.chainid), ".json"));
        runWith(vm.parseJsonAddress(record, ".timelock"));
    }

    function runWith(address timelock_) public {
        TimelockController timelock = TimelockController(payable(timelock_));
        uint256 current = timelock.getMinDelay();
        require(current < DELAY, "delay is already at or above the requirement");

        bytes memory payload = abi.encodeCall(TimelockController.updateDelay, (DELAY));

        vm.startBroadcast();
        timelock.schedule(timelock_, 0, payload, bytes32(0), bytes32(0), current);
        // At a delay of zero this executes in the same transaction batch. Run
        // again after the wait if the window was already partly closed.
        timelock.execute(timelock_, 0, payload, bytes32(0), bytes32(0));
        vm.stopBroadcast();

        require(timelock.getMinDelay() == DELAY, "the delay did not move");
        console2.log("timelock delay is now", DELAY);
    }
}
