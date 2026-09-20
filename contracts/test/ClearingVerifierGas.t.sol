// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ClearingVerifier} from "../src/ClearingVerifier.sol";

/// @notice The solidity half of the table spek-teknis.md section 6 asks for, which is
/// verify() gas at ten, fifty, one hundred, two hundred and five hundred intents.
///
/// What is measured is execution gas only. This is a staticcall from inside the EVM,
/// so what it charges for the input is memory expansion and not the sixteen gas a
/// real transaction pays per non zero calldata byte. The payload length is printed
/// beside each row so that cost can be added back, and it is the same payload on
/// both implementations, so the ratio between them does not move either way.
///
/// The batch is balanced pairs at one price, which is the cheapest shape the verifier
/// ever sees. A batch that routes to a venue or spans more tokens costs more, so
/// these are a floor rather than a typical case, and the Stylus side has to be built
/// the same way for the ratio to mean anything.
contract ClearingVerifierGasTest is Test {
    ClearingVerifier verifier;

    uint256 constant USDG_PRICE = 1e18;
    uint256 constant NVDA_PRICE = 200e18;

    function setUp() public {
        verifier = new ClearingVerifier();
    }

    function test_printVerifyGasByBatchSize() public {
        uint256[5] memory sizes = [uint256(10), 50, 100, 200, 500];
        for (uint256 k = 0; k < sizes.length; ++k) {
            _measure(sizes[k]);
        }
    }

    function _measure(uint256 n) internal {
        (bytes memory intents, bytes memory executions, uint256[] memory baselines) = _batch(n);

        bytes memory payload = abi.encodeCall(
            ClearingVerifier.verify,
            (intents, executions, _tokens(), _prices(), _noDeltas(), _prices(), baselines, 30, 3)
        );

        uint256 before = gasleft();
        (bool ok, bytes memory out) = address(verifier).staticcall(payload);
        uint256 used = before - gasleft();

        require(ok, "verify reverted");
        emit log_named_uint("intents", n);
        emit log_named_uint("  calldata bytes", payload.length);
        emit log_named_uint("  gas", used);
        emit log_named_uint("  gas per intent", used / n);
        emit log_named_uint("  savings usd wad", abi.decode(out, (uint256)));
    }

    /// Half the batch buys a token with the quote asset and half sells it back, every
    /// leg at the same price, so the book nets to nothing and no venue is touched.
    function _batch(uint256 n)
        internal
        pure
        returns (bytes memory intents, bytes memory executions, uint256[] memory baselines)
    {
        baselines = new uint256[](n);
        bytes memory i;
        bytes memory e;
        for (uint256 k = 0; k < n; ++k) {
            if (k % 2 == 0) {
                i = bytes.concat(
                    i,
                    abi.encodePacked(
                        uint16(0), uint16(1), uint8(0), bytes3(0), uint256(200e18), uint256(1e18)
                    )
                );
                e = bytes.concat(e, abi.encodePacked(uint32(k), bytes4(0), uint256(200e18), uint256(1e18)));
                baselines[k] = 0.99e18;
            } else {
                i = bytes.concat(
                    i,
                    abi.encodePacked(
                        uint16(1), uint16(0), uint8(0), bytes3(0), uint256(1e18), uint256(200e18)
                    )
                );
                e = bytes.concat(e, abi.encodePacked(uint32(k), bytes4(0), uint256(1e18), uint256(200e18)));
                baselines[k] = 198e18;
            }
        }
        intents = i;
        executions = e;
    }

    function _tokens() internal pure returns (address[] memory t) {
        t = new address[](2);
        t[0] = address(0x05D6);
        t[1] = address(0x4E7DA);
    }

    function _prices() internal pure returns (uint256[] memory p) {
        p = new uint256[](2);
        p[0] = USDG_PRICE;
        p[1] = NVDA_PRICE;
    }

    function _noDeltas() internal pure returns (int256[] memory d) {
        d = new int256[](2);
    }
}
