// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {Addresses} from "../Addresses.sol";
import {StockTokenGate} from "../StockTokenGate.sol";
import {TestQuoteToken} from "./TestQuoteToken.sol";
import {TestStockToken} from "./TestStockToken.sol";
import {TestV3Pool} from "./TestV3Pool.sol";

/// @title What chain 46630 does not have, put there on purpose
/// @notice Runs once, before Deploy, and only on the testnet. It exists because
/// the rehearsal is worth doing and 46630 carries none of the four things the
/// protocol reads. Permit2 is the single exception and it is already there at the
/// canonical address.
///
/// Its output is a list of addresses that goes into parameter.md and then into
/// Addresses as constants, the same way every other address this protocol does not
/// own gets there. Nothing is read from the environment.
contract DeployTestnetFixtures is Script {
    /// Arbitrary round numbers. Nothing on 46630 is priced by a market, so these
    /// are chosen to be readable rather than to be anybody's quote. The tick is
    /// the log of the raw price ratio with the stock token as token0, which is a
    /// stock token at 18 decimals against a quote at 6.
    int24 internal constant TICK_NVDA = -223_338; // 200
    int24 internal constant TICK_AAPL = -221_941; // 230
    int24 internal constant TICK_TSLA = -215_918; // 420
    int24 internal constant TICK_GOOGL = -221_107; // 250

    uint24 internal constant FEE = 3000;
    uint128 internal constant LIQUIDITY = 1e24;

    function run() external {
        require(block.chainid == Addresses.TESTNET, "fixtures are for the testnet rehearsal only");

        vm.startBroadcast();

        TestQuoteToken quote = new TestQuoteToken();

        address[] memory tokens = new address[](4);
        int24[] memory ticks = new int24[](4);
        tokens[0] = address(_stock("Nokturn Test NVDA", "tNVDA", 1.0032e18));
        tokens[1] = address(_stock("Nokturn Test AAPL", "tAAPL", 1.0011e18));
        tokens[2] = address(_stock("Nokturn Test TSLA", "tTSLA", 1e18));
        tokens[3] = address(_stock("Nokturn Test GOOGL", "tGOOGL", 1.0007e18));
        ticks[0] = TICK_NVDA;
        ticks[1] = TICK_AAPL;
        ticks[2] = TICK_TSLA;
        ticks[3] = TICK_GOOGL;

        address[] memory pools = new address[](4);
        for (uint256 k = 0; k < tokens.length; ++k) {
            pools[k] = _pool(tokens[k], address(quote), ticks[k]);
        }

        vm.stopBroadcast();

        console2.log("quote", address(quote));
        for (uint256 k = 0; k < tokens.length; ++k) {
            console2.log("token", tokens[k]);
            console2.log("pool ", pools[k]);
        }

        _write(address(quote), tokens, pools);
    }

    /// @dev The multipliers mirror the mainnet drift measured on 16 September 2026,
    /// because a gate that only ever sees exactly one would not be exercised by a
    /// rehearsal at all. See parameter.md section 10.1.
    function _stock(string memory name_, string memory symbol_, uint256 multiplier)
        internal
        returns (TestStockToken token)
    {
        token = new TestStockToken(name_, symbol_, StockTokenGate.BEACON, multiplier);
    }

    /// @dev The pool sorts its own pair the way a real one does, and the tick is
    /// stated for the stock token as token0. When the addresses come out the other
    /// way round the price is the reciprocal, so the tick flips sign.
    function _pool(address stock, address quote, int24 tick) internal returns (address) {
        (address token0, address token1) = stock < quote ? (stock, quote) : (quote, stock);
        int24 tick0 = token0 == stock ? tick : -tick;
        return address(new TestV3Pool(token0, token1, tick0, FEE, LIQUIDITY));
    }

    function _write(address quote, address[] memory tokens, address[] memory pools) internal {
        string memory key = "fixtures";
        vm.serializeAddress(key, "quote", quote);
        vm.serializeAddress(key, "tokens", tokens);
        string memory out = vm.serializeAddress(key, "pools", pools);
        vm.writeJson(out, string.concat("deployments/", vm.toString(block.chainid), "-fixtures.json"));
    }
}
