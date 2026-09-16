// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Intent} from "../types/Types.sol";

/// @title EIP-712 encoding for Intent
/// @notice The solver, the coordinator and the frontend all reproduce these two
/// hashes offchain. Any divergence makes every signature unverifiable, so the
/// string and the field order are frozen once published.
library IntentLib {
    bytes32 internal constant INTENT_TYPEHASH = keccak256(
        "Intent(address owner,address receiver,address sellToken,address buyToken,"
        "uint256 sellAmount,uint256 minBuyAmount,uint32 validAfter,uint32 validUntil,"
        "uint8 flags,uint8 kind,uint16 maxDevFromRefBps,uint8 allowedSessions,"
        "uint16 batchSpan,uint256 nonce)"
    );

    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    bytes32 internal constant DOMAIN_NAME = keccak256("Nokturn");
    bytes32 internal constant DOMAIN_VERSION = keccak256("1");

    function hash(Intent calldata i) internal pure returns (bytes32) {
        return keccak256(
            bytes.concat(
                abi.encode(
                    INTENT_TYPEHASH,
                    i.owner,
                    i.receiver,
                    i.sellToken,
                    i.buyToken,
                    i.sellAmount,
                    i.minBuyAmount
                ),
                abi.encode(
                    i.validAfter,
                    i.validUntil,
                    i.flags,
                    i.kind,
                    i.maxDevFromRefBps,
                    i.allowedSessions,
                    i.batchSpan,
                    i.nonce
                )
            )
        );
    }

    function domainSeparator(uint256 chainId, address verifyingContract) internal pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, DOMAIN_NAME, DOMAIN_VERSION, chainId, verifyingContract));
    }

    function digest(bytes32 separator, bytes32 structHash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", separator, structHash));
    }
}
