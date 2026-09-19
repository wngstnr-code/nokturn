// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {UniswapV3Adapter} from "../../src/adapters/UniswapV3Adapter.sol";
import {IUniswapV3Pool} from "../../src/interfaces/IUniswapV3Pool.sol";
import {Addresses} from "../../script/Addresses.sol";
import {ForkFixture} from "../fixtures/ForkFixture.sol";

/// @notice How much each allowlisted pool can actually absorb, measured rather than
/// assumed. parameter.md section 4B asks for this before a pool joins the adapter
/// allowlist, and all four are already on it.
///
/// MAX_TICK_CROSSINGS is a bound on work, not a policy. What decides whether it is
/// set correctly is the distance between the launch cap and the size at which a
/// pool stops being quotable, and that distance is a live number. So this walks it
/// nightly and prints the table rather than trusting one measured on one day.
contract PoolDepthForkTest is Test {
    UniswapV3Adapter adapter;
    address governor = address(0x60174E);

    /// parameter.md section 6. The per batch exposure cap at launch.
    uint256 constant CAP_PER_BATCH_USD = 5000e6;

    function setUp() public {
        ForkFixture.selectMainnet();
        adapter = new UniswapV3Adapter(governor);

        address[] memory pools = Addresses.pools();
        vm.startPrank(governor);
        for (uint256 k = 0; k < pools.length; ++k) {
            adapter.setPool(pools[k]);
        }
        vm.stopPrank();
    }

    /// At the launch cap every pool quotes without walking far. A pool that needed
    /// many crossings for five thousand dollars would be one where the baseline is
    /// expensive to compute for an ordinary batch, which is the case the cap exists
    /// to keep us out of.
    function test_theLaunchCapBarelyTouchesAnyPool() public view {
        address[] memory tokens = Addresses.allowlist();

        for (uint256 k = 0; k < tokens.length; ++k) {
            (, uint16 crossings,) = adapter.quoteWithStats(Addresses.quote(), tokens[k], CAP_PER_BATCH_USD);
            assertLe(crossings, 4, "a pool crosses more than four ticks at the launch cap");
        }
    }

    /// And every pool still answers at ten times the cap, which is the headroom a
    /// solver needs when several batches net into one route.
    function test_everyPoolQuotesAtTenTimesTheCap() public view {
        address[] memory tokens = Addresses.allowlist();

        for (uint256 k = 0; k < tokens.length; ++k) {
            uint256 out = adapter.quoteFromState(Addresses.quote(), tokens[k], CAP_PER_BATCH_USD * 10);
            assertGt(out, 0, "a pool could not quote ten times the launch cap");
        }
    }

    /// The table parameter.md section 4B carries. Printed rather than asserted,
    /// because the numbers are the live market and a committed copy of them would
    /// be stale by the time anybody read it.
    function test_printTheDepthTable() public {
        address[] memory tokens = Addresses.allowlist();
        address[] memory pools = Addresses.pools();
        uint256[6] memory sizes = [uint256(5000e6), 10_000e6, 50_000e6, 250_000e6, 500_000e6, 1_000_000e6];

        for (uint256 k = 0; k < tokens.length; ++k) {
            emit log_string("");
            emit log_named_address("pool", pools[k]);
            emit log_named_uint("  fee", IUniswapV3Pool(pools[k]).fee());
            emit log_named_uint("  liquidity in range", IUniswapV3Pool(pools[k]).liquidity());

            for (uint256 n = 0; n < sizes.length; ++n) {
                try adapter.quoteWithStats(Addresses.quote(), tokens[k], sizes[n]) returns (
                    uint256, uint16 crossings, uint16 steps
                ) {
                    emit log_named_uint("  usd in", sizes[n] / 1e6);
                    emit log_named_uint("    crossings", crossings);
                    emit log_named_uint("    steps", steps);
                } catch {
                    emit log_named_uint("  usd in, refused", sizes[n] / 1e6);
                }
            }
            emit log_named_uint("  largest quotable usd", _largestQuotable(tokens[k]));
        }
    }

    /// @dev Binary search on the real adapter rather than a copy of its loop. The
    /// answer is the size at which MAX_TICK_CROSSINGS or the pool's own liquidity
    /// stops it, whichever comes first, and which of the two it was shows up as the
    /// crossing count printed above.
    function _largestQuotable(address token) internal view returns (uint256) {
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
