// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IntentLib} from "../src/libraries/IntentLib.sol";
import {Intent, Session, SessionMask} from "../src/types/Types.sol";

contract IntentLibTest is Test {
    /// Frozen on day one. The coordinator, the solver and the frontend all hardcode
    /// this value, so a change here breaks every signature already in flight.
    bytes32 constant GOLDEN_TYPEHASH = 0x8ebd7b3cd239d387958c175546883600864ae3d16e2e9c87d8d5714bf8c138a4;

    Harness harness = new Harness();

    function test_typehashIsFrozen() public pure {
        assertEq(IntentLib.INTENT_TYPEHASH, GOLDEN_TYPEHASH);
    }

    /// Computed outside Solidity with cast abi-encode plus cast keccak, so the two
    /// stage encode inside IntentLib cannot silently drift from a single abi.encode.
    /// The coordinator reproduces this same value in TypeScript.
    function test_intentHashMatchesIndependentEncoding() public view {
        assertEq(harness.hash(_intent()), 0x2a3790f0160a0a9cb1114849acb82feb2aac723bdf7c2d750bbc0d7d2cb5a850);
    }

    function test_domainSeparatorBindsChainAndContract() public pure {
        bytes32 a = IntentLib.domainSeparator(4663, address(0xBEEF));
        bytes32 b = IntentLib.domainSeparator(46_630, address(0xBEEF));
        bytes32 c = IntentLib.domainSeparator(4663, address(0xCAFE));
        assertTrue(a != b);
        assertTrue(a != c);
    }

    function testFuzz_hashChangesWithNonce(uint256 n1, uint256 n2) public view {
        vm.assume(n1 != n2);
        Intent memory i = _intent();
        i.nonce = n1;
        bytes32 h1 = harness.hash(i);
        i.nonce = n2;
        assertTrue(h1 != harness.hash(i));
    }

    function test_digestBindsDomainAndStruct() public pure {
        bytes32 sep = IntentLib.domainSeparator(4663, address(0xBEEF));
        bytes32 structHash = keccak256("whatever");
        bytes32 expected = keccak256(abi.encodePacked(hex"1901", sep, structHash));
        assertEq(IntentLib.digest(sep, structHash), expected);
    }

    function test_protectiveHasNoSessionBit() public pure {
        assertEq(SessionMask.bit(Session.PROTECTIVE), 0);
        assertEq(SessionMask.bit(Session.OPEN), SessionMask.OPEN);
        assertEq(SessionMask.bit(Session.CLOSED_WEEKEND), SessionMask.CLOSED_WEEKEND);
    }

    function _intent() internal pure returns (Intent memory i) {
        i = Intent({
            owner: address(0xA11CE),
            receiver: address(0xA11CE),
            sellToken: address(0x1),
            buyToken: address(0x2),
            sellAmount: 1e18,
            minBuyAmount: 1e6,
            validAfter: 0,
            validUntil: type(uint32).max,
            flags: 0,
            kind: 0,
            maxDevFromRefBps: 0,
            allowedSessions: type(uint8).max,
            batchSpan: 1,
            nonce: 0
        });
    }
}

contract Harness {
    function hash(Intent calldata i) external pure returns (bytes32) {
        return IntentLib.hash(i);
    }
}
