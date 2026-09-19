// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {UniswapV3Adapter} from "../../src/adapters/UniswapV3Adapter.sol";
import {IUniswapV3Pool} from "../../src/interfaces/IUniswapV3Pool.sol";
import {Addresses} from "../../script/Addresses.sol";
import {ForkFixture} from "../fixtures/ForkFixture.sol";

/// @notice The same depth measurement PoolDepthFork runs over the allowlist, run
/// over a token that is not on it.
///
/// META passes every filter the allowlist applies except the one nobody thought to
/// check. Its feed is the third steadiest measured, it nets better per batch than
/// anything on the allowlist, and it carries more volume than TSLA. Its flow is on
/// Uniswap V4, which the v1.0 adapter cannot quote, and the V3 pool left behind
/// prices about a hundred bps away from its own oracle.
///
/// Kept as a running test rather than a note, because the measurement that rejected
/// it is a live market number and a note would go stale without saying so.
contract CandidateDepthForkTest is Test {
    address constant META = 0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35;
    address constant POOL_META = 0x107a7Cb40d8665360ba10E59471Af06150A50922;

    /// parameter.md section 6. The per batch exposure cap at launch.
    uint256 constant CAP_PER_BATCH_USD = 5000e6;

    UniswapV3Adapter adapter;
    address governor = address(0x60174E);

    function setUp() public {
        ForkFixture.selectMainnet();
        adapter = new UniswapV3Adapter(governor);
        vm.prank(governor);
        adapter.setPool(POOL_META);
    }

    function test_printMetaDepth() public {
        emit log_named_address("pool", POOL_META);
        emit log_named_uint("  fee", IUniswapV3Pool(POOL_META).fee());
        emit log_named_uint("  liquidity in range", IUniswapV3Pool(POOL_META).liquidity());

        uint256[6] memory sizes = [uint256(5000e6), 10_000e6, 50_000e6, 250_000e6, 500_000e6, 1_000_000e6];
        for (uint256 n = 0; n < sizes.length; ++n) {
            try adapter.quoteWithStats(Addresses.quote(), META, sizes[n]) returns (
                uint256 out, uint16 crossings, uint16 steps
            ) {
                emit log_named_uint("usd in", sizes[n] / 1e6);
                emit log_named_uint("  crossings", crossings);
                emit log_named_uint("  steps", steps);
                emit log_named_uint("  effective usd per token", (sizes[n] * 1e18) / out);
                emit log_named_uint("  impact bps vs 5k", _impactBps(META, sizes[n]));
            } catch {
                emit log_named_uint("usd in, refused", sizes[n] / 1e6);
            }
        }
        emit log_named_uint("largest quotable usd", _largestQuotableFor(META));
    }

    /// @dev How much worse the effective price is than at the launch cap. A pool
    /// that still answers at a million dollars while charging ten times the price
    /// is not deep, and a quotable size on its own does not say that.
    function _impactBps(address token, uint256 amountIn) internal view returns (uint256) {
        uint256 baseOut = adapter.quoteFromState(Addresses.quote(), token, 5000e6);
        uint256 basePrice = (5000e6 * 1e18) / baseOut;
        uint256 out = adapter.quoteFromState(Addresses.quote(), token, amountIn);
        uint256 price = (amountIn * 1e18) / out;
        if (price <= basePrice) return 0;
        return ((price - basePrice) * 10_000) / basePrice;
    }

    function _largestQuotableFor(address token) internal view returns (uint256) {
        uint256 lo = 0;
        uint256 hi = 4_000_000e6;
        for (uint256 k = 0; k < 24; ++k) {
            uint256 mid = (lo + hi) / 2;
            try adapter.quoteWithStats(Addresses.quote(), token, mid) returns (uint256, uint16, uint16) {
                lo = mid;
            } catch {
                hi = mid;
            }
        }
        return lo / 1e6;
    }
}
