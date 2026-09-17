// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Intent, Mandate} from "../types/Types.sol";

interface IAgentMandate {
    event MandateCreated(bytes32 indexed id, address indexed owner, address indexed agent, uint64 expiry);
    event MandateAccountDeployed(bytes32 indexed id, address indexed account);
    event MandateRevoked(bytes32 indexed id);
    event MandateUsed(bytes32 indexed id, bytes32 indexed intentHash, uint256 notionalUsd);
    event MandateRejected(bytes32 indexed id, bytes32 rule);
    event MandateBudgetReleased(bytes32 indexed id, bytes32 indexed intentHash, uint256 notionalUsd);

    function createMandate(Mandate calldata m) external returns (bytes32 id);
    function revokeMandate(bytes32 id) external;

    /// @notice Runs every rule, books the notional against today's budget, and
    /// marks the Permit2 digest the agent signed as good. Anyone may relay it,
    /// because the agent signature is what carries the authority.
    function authorize(bytes32 id, Intent calldata i, bytes calldata agentSig)
        external
        returns (bytes32 digest);

    /// @notice Gives back the budget an intent reserved but never spent. Proven
    /// against the Permit2 nonce bitmap rather than taken on trust.
    function releaseUnspent(bytes32 id, Intent calldata i) external;

    /// @notice The rules that do not depend on the budget, so a caller can run it
    /// at settlement without double counting what authorize already booked.
    function validate(bytes32 id, Intent calldata i) external view returns (bool ok, bytes32 reason);

    function spentToday(bytes32 id) external view returns (uint256);
    function accountOf(bytes32 id) external view returns (address);
    function mandateOf(address account) external view returns (bytes32);
    function accountOwner(address account) external view returns (address);
    function accountAuthorized(address account, bytes32 digest) external view returns (bool);
}
