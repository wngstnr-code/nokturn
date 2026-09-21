// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IntentLib} from "../../src/libraries/IntentLib.sol";
import {Intent} from "../../src/types/Types.sol";

/// @notice IntentLib.hash takes calldata and a solution is built in memory. This
/// exists so the hash comes from the library every signature depends on rather than
/// from a second copy of the encoding kept in step by hand. The fork tests use the
/// same shape for the same reason.
contract IntentHasher {
    function hashOf(Intent calldata i) external pure returns (bytes32) {
        return IntentLib.hash(i);
    }
}
