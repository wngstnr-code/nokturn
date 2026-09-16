// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";

/// @notice Selects a mainnet fork a little behind the head.
///
/// Two measurements decide this. Blocks here are about 100ms, so the head moves
/// while a test is still fetching state from it, and the endpoint answers
/// "Unknown block" for a block it has just served. And the drpc endpoint keeps
/// state for roughly the last 20 to 40 thousand blocks rather than for all of
/// history, so a pinned block number committed today stops resolving within the
/// hour. Measured 16 September 2026: block 64640000 answered and 64620000 did not,
/// against a head of 64658016.
///
/// So fork tests follow the head and step back far enough to be settled, which is
/// the only pinning this endpoint supports.
library ForkFixture {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// Thirty seconds at 100ms blocks.
    uint256 internal constant HEAD_MARGIN = 300;

    function selectMainnet() internal {
        vm.createSelectFork(vm.rpcUrl("mainnet"));
        vm.rollFork(block.number - HEAD_MARGIN);
    }
}
