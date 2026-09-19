// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ClearingMath} from "../../src/libraries/ClearingMath.sol";

/// @notice Where the solver stops on 256 bit division, measured rather than assumed.
///
/// This contract is evidence, not a gate. tools/halmos.sh names the four proof
/// contracts one at a time and this is deliberately not among them, because a probe
/// that is expected to time out would turn the gate red every night. What runs here
/// under forge is a bounded fuzz, which proves nothing and is not meant to.
///
/// It is kept because rencana-uji.md section 4.1 states a limit, and a limit nobody
/// can rerun is a limit the next person has to take on faith. Run one function at a
/// time with the halmos profile and a three hundred second assertion timeout.
///
/// The finding, measured 20 September 2026 with halmos 0.3.3. The wall is on the
/// width of the number being divided, not on the width of the inputs, and it sits
/// between 2 to the 65 and 2 to the 73. Four solvers land on it in the same place,
/// and neither reducing the number of divisions nor moving them behind witnesses
/// moves it.
contract DivisionWall is Test {
    uint256 internal constant WAD = 1e18;

    /// Dividend at most 2 to the 65. Closes.
    function testFuzz_floor64(uint64 x, uint64 y) public pure {
        uint256 whole = (uint256(x) + y) / WAD;
        uint256 split = uint256(x) / WAD + uint256(y) / WAD;
        assertLe(split, whole);
        assertLe(whole - split, 1);
    }

    /// Dividend at most 2 to the 73, the next width solidity has. Times out. There
    /// is no type between these two, so this is as fine as the boundary can be put.
    function testFuzz_floor72(uint72 x, uint72 y) public pure {
        uint256 whole = (uint256(x) + y) / WAD;
        uint256 split = uint256(x) / WAD + uint256(y) / WAD;
        assertLe(split, whole);
        assertLe(whole - split, 1);
    }

    /// Two divisions instead of three, and the claim stated multiplicatively, which
    /// is the same content because split <= whole follows from it by the definition
    /// of floor. Same wall, so the count of divisions is not what binds.
    function testFuzz_mul96(uint96 x, uint96 y) public pure {
        assertLe((uint256(x) / WAD + uint256(y) / WAD) * WAD, uint256(x) + y);
    }

    /// The euclidean axiom about the evm operations themselves, at full width. This
    /// is what a two lemma split would have to rest on, and it times out, which is
    /// why the split does not help. Written out, the other half of that split turns
    /// into a statement about a carry bit and carries no content at all.
    function testFuzz_euclid256(uint256 x) public pure {
        uint256 q = x / WAD;
        uint256 r = x % WAD;
        assertLt(r, WAD);
        assertEq(q * WAD + r, x);
    }

    /// The composed statement with a dividend of 2 to the 129, because the product
    /// is formed before the division. Times out although the inputs are the width
    /// that closes above, which is what shows the wall is on the dividend.
    function testFuzz_composed64(uint64 a, uint64 b, uint64 price) public pure {
        uint256 whole = ClearingMath.quoteOf(uint256(a) + b, price);
        uint256 split = ClearingMath.quoteOf(a, price) + ClearingMath.quoteOf(b, price);
        assertLe(split, whole);
        assertLe(whole - split, 1);
    }
}
