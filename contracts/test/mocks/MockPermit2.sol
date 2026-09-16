// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISignatureTransfer} from "../../src/interfaces/IPermit2.sol";

/// @notice Stands in for Permit2 in unit tests. It enforces the nonce bitmap and
/// the deadline, and it moves the tokens, but it does not check signatures. The
/// real Permit2 is exercised in the fork tests instead, because it is already
/// deployed on both networks and mocking signature recovery would only test the
/// mock. rencana-uji.md section 6 asks for exactly that split.
contract MockPermit2 is ISignatureTransfer {
    mapping(address => mapping(uint256 => uint256)) internal bitmap;

    error NonceUsed(address owner, uint256 nonce);
    error PermitExpired(uint256 deadline);
    error AmountExceedsPermitted(uint256 requested, uint256 permitted);

    function permitWitnessTransferFrom(
        PermitTransferFrom memory permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes32,
        string calldata,
        bytes calldata
    ) external {
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > permit.deadline) revert PermitExpired(permit.deadline);
        if (transferDetails.requestedAmount > permit.permitted.amount) {
            revert AmountExceedsPermitted(transferDetails.requestedAmount, permit.permitted.amount);
        }

        uint256 word = permit.nonce >> 8;
        uint256 bit = 2 ** (permit.nonce & 0xff);
        if (bitmap[owner][word] & bit != 0) revert NonceUsed(owner, permit.nonce);
        bitmap[owner][word] |= bit;

        IERC20 token = IERC20(permit.permitted.token);
        address to = transferDetails.to;
        uint256 amount = transferDetails.requestedAmount;
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        token.transferFrom(owner, to, amount);
    }

    function nonceBitmap(address owner, uint256 word) external view returns (uint256) {
        return bitmap[owner][word];
    }
}
