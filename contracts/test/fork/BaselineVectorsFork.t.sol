// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {UniswapV3Adapter} from "../../src/adapters/UniswapV3Adapter.sol";
import {IUniswapV3Pool} from "../../src/interfaces/IUniswapV3Pool.sol";
import {Addresses} from "../../script/Addresses.sol";
import {ForkFixture} from "../fixtures/ForkFixture.sol";

/// @notice The handoff for the offchain baseline calculator, printed rather than
/// written down. desain-baseline.md section 9.5.
///
/// The solver publishes the number a judge checks, so two implementations that
/// disagree mean the claim is unprovable. Prose cannot carry that agreement. This
/// prints the raw state each pool was read at and the answers the shipped adapter
/// gave from it, so the other implementation can be run over the same bytes and
/// compared to the wei.
///
/// Both directions, because the token order is not the same across pools. USDG is
/// token0 for NVDA and AAPL and token1 for TSLA and GOOGL, measured 16 September
/// 2026, and an implementation that assumes one side passes half of these.
contract BaselineVectorsForkTest is Test {
    UniswapV3Adapter adapter;
    address governor = address(0x60174E);

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

    function test_printVectors() public {
        address[] memory tokens = Addresses.allowlist();
        address[] memory pools = Addresses.pools();
        address quote = Addresses.quote();

        // Both, labelled. On an Arbitrum chain block.number answers for the parent
        // chain, and reading the wrong one is what left every fork test in this repo
        // six weeks stale. pertanyaan-terbuka.md, seventh methodology lesson.
        emit log_named_uint("this chain block, ArbSys", ForkFixture.ARB_SYS.arbBlockNumber());
        emit log_named_uint("parent chain block, block.number", block.number);
        emit log_named_uint("timestamp", block.timestamp);

        for (uint256 k = 0; k < tokens.length; ++k) {
            IUniswapV3Pool pool = IUniswapV3Pool(pools[k]);
            (uint160 sqrtPriceX96, int24 tick,,,,,) = pool.slot0();

            emit log_string("");
            emit log_named_address("pool", pools[k]);
            emit log_named_address("  token0", pool.token0());
            emit log_named_address("  token1", pool.token1());
            emit log_named_uint("  fee", pool.fee());
            emit log_named_int("  tickSpacing", pool.tickSpacing());
            emit log_named_uint("  sqrtPriceX96", sqrtPriceX96);
            emit log_named_int("  tick", tick);
            emit log_named_uint("  liquidity", pool.liquidity());

            _leg("  quote to token", quote, tokens[k], _quoteSizes());
            _leg("  token to quote", tokens[k], quote, _tokenSizes(quote, tokens[k]));
        }
    }

    /// @dev Six sizes spanning the median ticket to ten times the launch cap, which
    /// is the range rencana-uji.md section 7.3 asks the differential to cover.
    function _quoteSizes() internal pure returns (uint256[6] memory sizes) {
        sizes = [uint256(1e6), 57.44e6, 1000e6, 5000e6, 25_000e6, 50_000e6];
    }

    /// @dev The other direction has to be denominated in the stock token, so the
    /// sizes are derived from what the quote side buys rather than guessed.
    function _tokenSizes(address quote, address token) internal view returns (uint256[6] memory sizes) {
        uint256[6] memory inUsd = _quoteSizes();
        for (uint256 n = 0; n < inUsd.length; ++n) {
            sizes[n] = adapter.quoteFromState(quote, token, inUsd[n]);
        }
    }

    function _leg(string memory label, address tokenIn, address tokenOut, uint256[6] memory sizes) internal {
        emit log_string(label);
        for (uint256 n = 0; n < sizes.length; ++n) {
            try adapter.quoteWithStats(tokenIn, tokenOut, sizes[n]) returns (
                uint256 out, uint16 crossings, uint16 steps
            ) {
                emit log_named_uint("    in", sizes[n]);
                emit log_named_uint("      out", out);
                emit log_named_uint("      crossings", crossings);
                emit log_named_uint("      steps", steps);
            } catch {
                emit log_named_uint("    in, refused", sizes[n]);
            }
        }
    }
}
