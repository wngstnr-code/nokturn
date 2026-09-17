// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

/// @title The digest Permit2 verifies for a witnessed transfer
/// @notice Reproduced here so a commitment can be checked against the owner's
/// signature at the moment it is made, rather than only when Permit2 is finally
/// called. Getting this wrong fails closed, since a digest that does not match is
/// a commitment refused, and the fork test against the deployed Permit2 is what
/// proves it matches at all.
library Permit2Witness {
    bytes32 internal constant TOKEN_PERMISSIONS_TYPEHASH =
        keccak256("TokenPermissions(address token,uint256 amount)");

    /// @dev The type string Permit2 prepends before the caller's witness type.
    bytes internal constant TYPEHASH_STUB =
        "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,";

    function typeHash(string memory witnessTypeString) internal pure returns (bytes32) {
        return keccak256(bytes.concat(TYPEHASH_STUB, bytes(witnessTypeString)));
    }

    /// @param spender The contract that will call Permit2, since Permit2 binds the
    /// signature to its own msg.sender and nobody else can spend it.
    function digest(
        bytes32 domainSeparator,
        bytes32 witnessTypeHash,
        address token,
        uint256 amount,
        address spender,
        uint256 nonce,
        uint256 deadline,
        bytes32 witness
    ) internal pure returns (bytes32) {
        bytes32 permitted = keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, token, amount));
        bytes32 dataHash =
            keccak256(abi.encode(witnessTypeHash, permitted, spender, nonce, deadline, witness));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, dataHash));
    }
}
