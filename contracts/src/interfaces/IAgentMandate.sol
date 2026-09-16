// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Intent, Mandate} from "../types/Types.sol";

interface IAgentMandate {
    event MandateCreated(bytes32 indexed id, address indexed owner, address indexed agent, uint64 expiry);
    event MandateRevoked(bytes32 indexed id);
    event MandateUsed(bytes32 indexed id, bytes32 indexed intentHash, uint256 notionalUsd);
    event MandateRejected(bytes32 indexed id, bytes32 rule);

    function createMandate(Mandate calldata m) external returns (bytes32 id);
    function revokeMandate(bytes32 id) external;
    function validate(bytes32 id, Intent calldata i) external view returns (bool ok, bytes32 reason);
    function spentToday(bytes32 id) external view returns (uint256);
}
