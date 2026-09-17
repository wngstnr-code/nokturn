// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The slice of Permit2 this protocol uses. Deployed at the canonical
/// address on both Robinhood Chain networks, and already used by real people for
/// NVDA, which is why intents ride on it rather than on a bespoke approval flow.
interface ISignatureTransfer {
    struct TokenPermissions {
        address token;
        uint256 amount;
    }

    struct PermitTransferFrom {
        TokenPermissions permitted;
        uint256 nonce;
        uint256 deadline;
    }

    struct SignatureTransferDetails {
        address to;
        uint256 requestedAmount;
    }

    /// @notice Verifies the owner signature over the permit and the witness, then
    /// moves the tokens. The witness is the Intent hash, so one signature covers
    /// both the transfer and the terms of the trade.
    function permitWitnessTransferFrom(
        PermitTransferFrom memory permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes32 witness,
        string calldata witnessTypeString,
        bytes calldata signature
    ) external;

    /// @notice EIP-712 domain of the deployed Permit2. Read rather than rebuilt,
    /// because Permit2 recomputes its own when the chain id changes.
    function DOMAIN_SEPARATOR() external view returns (bytes32);

    /// @notice Unordered nonce bitmap. Cancelling an intent means calling
    /// invalidateUnorderedNonces on Permit2 directly, as its owner.
    function nonceBitmap(address owner, uint256 word) external view returns (uint256);
}
