// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";

/// @notice Selects a mainnet fork a little behind the head.
///
/// Two measurements decide the margin. Blocks here are about 100ms, so the head
/// moves while a test is still fetching state from it, and the endpoint answers
/// "Unknown block" for a block it has just served. And the drpc endpoint keeps
/// state for roughly the last 20 to 40 thousand blocks rather than for all of
/// history, so a pinned block number committed today stops resolving within the
/// hour.
///
/// So fork tests follow the head and step back far enough to be settled, which is
/// the only pinning this endpoint supports.
///
/// The number they step back from has to come from ArbSys. On an Arbitrum chain
/// block.number is the parent chain's number, not this one's, and the two are
/// nowhere near each other. Measured 19 September 2026, block.number answered
/// 26,011,883 while the chain was at 67,121,275, and the gap widens every day.
/// Feeding the first into rollFork, which takes the second, silently landed every
/// fork test on 2 August state for six weeks.
library ForkFixture {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    IArbSys internal constant ARB_SYS = IArbSys(0x0000000000000000000000000000000000000064);

    /// Thirty seconds at 100ms blocks.
    uint256 internal constant HEAD_MARGIN = 300;

    function selectMainnet() internal {
        vm.createSelectFork(vm.rpcUrl("mainnet"));
        vm.rollFork(ARB_SYS.arbBlockNumber() - HEAD_MARGIN);
    }
}

interface IArbSys {
    function arbBlockNumber() external view returns (uint256);
}
