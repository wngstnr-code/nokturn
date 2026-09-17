// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IAgentMandate} from "./interfaces/IAgentMandate.sol";

/// @title Holding account for one owner and one agent
/// @notice Deployed as a clone by AgentMandate, one per mandate, and named as the
/// owner on every intent that agent signs. Permit2 only accepts a signature from
/// the intent owner, so an agent signature can move nothing unless the owner
/// address answers EIP-1271. This is that address, and it holds only what the
/// owner deposited for that one agent.
/// @dev parameter.md section 5B
contract MandateAccount is IERC1271 {
    using SafeERC20 for IERC20;

    bytes4 internal constant ERC1271_ACCEPT = 0x1626ba7e;
    bytes4 internal constant ERC1271_REJECT = 0xffffffff;

    IAgentMandate public immutable registry;
    address public immutable permit2;

    error NotOwner();

    constructor(IAgentMandate registry_, address permit2_) {
        registry = registry_;
        permit2 = permit2_;
    }

    /// @notice Permit2 asks this before it moves anything. The agent signature is
    /// not re-read here. It was checked when authorize ran, which is the only call
    /// that can write, and EIP-1271 is a view.
    function isValidSignature(bytes32 digest, bytes calldata) external view returns (bytes4) {
        return registry.accountAuthorized(address(this), digest) ? ERC1271_ACCEPT : ERC1271_REJECT;
    }

    /// @notice Open to anyone on purpose. The only address this can ever approve
    /// is Permit2, and Permit2 moves nothing without a digest authorize booked.
    function approvePermit2(IERC20 token) external {
        token.forceApprove(permit2, type(uint256).max);
    }

    function withdraw(IERC20 token, uint256 amount, address to) external {
        if (msg.sender != registry.accountOwner(address(this))) revert NotOwner();
        token.safeTransfer(to, amount);
    }
}
