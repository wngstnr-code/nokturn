// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";

/// @notice Selects the mainnet fork every part of this project is synchronised on.
///
/// The block is not chosen here. It is read from infra/pinned-block.json, which the
/// backend's own fork is started against, so a receipt produced by a fork test and a
/// receipt produced by the coordinator describe the same chain state. Two harnesses
/// on two different blocks would disagree on the baseline and neither would be wrong.
///
/// Pinning is possible because the endpoint serves historical state. That was denied
/// in this file until 21 September 2026, on the strength of one block that failed to
/// resolve. Measured properly at nine depths, eth_call and eth_getStorageAt answer
/// from head minus 300 all the way down to block 920,694, which is 1 July 2026, and
/// they answer with different values at each depth rather than echoing the head.
/// The earlier claim of a twenty to forty thousand block window was wrong.
///
/// The number is an Arbitrum block number, not an Ethereum one. On this chain
/// block.number answers the parent chain's height, and the two are nowhere near each
/// other. Measured 19 September 2026, block.number said 26,011,883 while the chain
/// was at 67,121,275. Feeding the first into a fork selector, which takes the second,
/// silently landed every fork test on 2 August state for six weeks. ArbSys is below
/// so a test that needs the live height has somewhere correct to get it.
library ForkFixture {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    IArbSys internal constant ARB_SYS = IArbSys(0x0000000000000000000000000000000000000064);

    uint256 internal constant MAINNET = 4663;

    string internal constant PIN_FILE = "../infra/pinned-block.json";

    function selectMainnet() internal {
        vm.createSelectFork(vm.rpcUrl("mainnet"), pinnedBlock());
    }

    function pinnedBlock() internal view returns (uint256) {
        string memory pin = vm.readFile(PIN_FILE);
        require(vm.parseJsonUint(pin, ".chainId") == MAINNET, "pinned block is not for mainnet 4663");
        return vm.parseJsonUint(pin, ".block");
    }
}

interface IArbSys {
    function arbBlockNumber() external view returns (uint256);
}
