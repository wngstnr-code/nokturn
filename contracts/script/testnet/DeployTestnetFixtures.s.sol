// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";

import {Addresses} from "../Addresses.sol";
import {StockTokenGate} from "../StockTokenGate.sol";
import {MirrorFeed} from "./MirrorFeed.sol";
import {TestQuoteToken} from "./TestQuoteToken.sol";
import {TestStockToken} from "./TestStockToken.sol";
import {TestV3Pool} from "./TestV3Pool.sol";

/// @title What chain 46630 does not have, put there on purpose
/// @notice Runs once, before Deploy, and only on the testnet. It exists because
/// the rehearsal is worth doing and 46630 carries none of the four things the
/// protocol reads. Permit2 is the single exception and it is already there at the
/// canonical address.
///
/// Prices are not chosen here. Every feed is a MirrorFeed of the mainnet proxy in
/// Addresses, and every pool takes its price from those feeds, so the pools stay
/// uninitialized until tools/mirror.py has pushed a first round and called sync.
/// Bootstrap refuses an uninitialized pool, which keeps that order honest.
///
/// Its output is a list of addresses that goes into parameter.md and then into
/// Addresses as constants, the same way every other address this protocol does not
/// own gets there. Nothing is read from the environment.
contract DeployTestnetFixtures is Script {
    /// Fee, spacing and in range liquidity of each mainnet pool in Addresses, read
    /// at block 78,833,447 on 3 October 2026. Both sides have the same decimals on
    /// both chains, so the raw liquidity carries over as depth. parameter.md 10.6.
    uint24 internal constant FEE_NVDA = 500;
    uint24 internal constant FEE_AAPL = 500;
    uint24 internal constant FEE_TSLA = 3000;
    uint24 internal constant FEE_GOOGL = 500;
    uint24 internal constant FEE_GME = 500;

    int24 internal constant SPACING_NVDA = 10;
    int24 internal constant SPACING_AAPL = 10;
    int24 internal constant SPACING_TSLA = 60;
    int24 internal constant SPACING_GOOGL = 10;
    int24 internal constant SPACING_GME = 10;

    uint128 internal constant LIQUIDITY_NVDA = 19_531_557_485_415_257_411;
    uint128 internal constant LIQUIDITY_AAPL = 520_436_072_689_231_175;
    uint128 internal constant LIQUIDITY_TSLA = 352_474_549_280_711_413;
    uint128 internal constant LIQUIDITY_GOOGL = 1_931_105_946_085_635_895;
    uint128 internal constant LIQUIDITY_GME = 788_065_785_292_685_059;

    /// Every mainnet feed in Addresses answers in eight decimals, measured on
    /// 19 September and 3 October 2026. tools/mirror.py refuses to push into a
    /// mirror whose decimals differ from its source.
    uint8 internal constant FEED_DECIMALS = 8;

    /// Enough of each side to pay out a price move of a half in either direction
    /// at the deepest pool above. A flat range with no reserve behind it would
    /// quote a swap it cannot pay.
    uint256 internal constant STOCK_RESERVE = 1e27;
    uint256 internal constant QUOTE_RESERVE = 1e18;

    struct Pair {
        string name;
        string symbol;
        uint256 multiplier;
        address source;
        uint24 fee;
        int24 spacing;
        uint128 liquidity;
    }

    function run() external {
        require(block.chainid == Addresses.TESTNET, "fixtures are for the testnet rehearsal only");

        Pair[] memory pairs = _pairs();

        vm.startBroadcast();
        (, address operator,) = vm.readCallers();

        TestQuoteToken quote = new TestQuoteToken();
        MirrorFeed quoteFeed =
            new MirrorFeed(operator, Addresses.FEED_USDG, FEED_DECIMALS, "mirror of USDG / USD on 4663");

        address[] memory tokens = new address[](pairs.length);
        address[] memory feeds = new address[](pairs.length);
        address[] memory pools = new address[](pairs.length);
        for (uint256 k = 0; k < pairs.length; ++k) {
            Pair memory p = pairs[k];
            TestStockToken token = new TestStockToken(p.name, p.symbol, StockTokenGate.BEACON, p.multiplier);
            MirrorFeed feed = new MirrorFeed(
                operator, p.source, FEED_DECIMALS, string.concat("mirror of ", p.symbol, " / USD on 4663")
            );
            TestV3Pool pool = new TestV3Pool(
                address(token),
                address(quote),
                address(feed),
                address(quoteFeed),
                p.fee,
                p.spacing,
                p.liquidity
            );
            token.mint(address(pool), STOCK_RESERVE);
            quote.mint(address(pool), QUOTE_RESERVE);

            tokens[k] = address(token);
            feeds[k] = address(feed);
            pools[k] = address(pool);
        }

        vm.stopBroadcast();

        console2.log("operator ", operator);
        console2.log("quote    ", address(quote));
        console2.log("quoteFeed", address(quoteFeed));
        for (uint256 k = 0; k < pairs.length; ++k) {
            console2.log(pairs[k].symbol);
            console2.log("  token", tokens[k]);
            console2.log("  feed ", feeds[k]);
            console2.log("  pool ", pools[k]);
        }

        _write(operator, address(quote), address(quoteFeed), tokens, feeds, pools);
    }

    /// @dev Same order as Addresses.allowlist, because the feed and pool tables
    /// are read against it by index.
    ///
    /// The multipliers mirror the mainnet drift measured on 16 September 2026,
    /// because a gate that only ever sees exactly one would not be exercised by a
    /// rehearsal at all. See parameter.md section 10.1.
    function _pairs() internal pure returns (Pair[] memory pairs) {
        pairs = new Pair[](5);
        pairs[0] = Pair(
            "Nokturn Test NVDA",
            "tNVDA",
            1.0032e18,
            Addresses.FEED_NVDA,
            FEE_NVDA,
            SPACING_NVDA,
            LIQUIDITY_NVDA
        );
        pairs[1] = Pair(
            "Nokturn Test AAPL",
            "tAAPL",
            1.0011e18,
            Addresses.FEED_AAPL,
            FEE_AAPL,
            SPACING_AAPL,
            LIQUIDITY_AAPL
        );
        pairs[2] = Pair(
            "Nokturn Test TSLA", "tTSLA", 1e18, Addresses.FEED_TSLA, FEE_TSLA, SPACING_TSLA, LIQUIDITY_TSLA
        );
        pairs[3] = Pair(
            "Nokturn Test GOOGL",
            "tGOOGL",
            1.0007e18,
            Addresses.FEED_GOOGL,
            FEE_GOOGL,
            SPACING_GOOGL,
            LIQUIDITY_GOOGL
        );
        pairs[4] =
            Pair("Nokturn Test GME", "tGME", 1e18, Addresses.FEED_GME, FEE_GME, SPACING_GME, LIQUIDITY_GME);
    }

    function _write(
        address operator,
        address quote,
        address quoteFeed,
        address[] memory tokens,
        address[] memory feeds,
        address[] memory pools
    ) internal {
        string memory key = "fixtures";
        vm.serializeAddress(key, "operator", operator);
        vm.serializeAddress(key, "quote", quote);
        vm.serializeAddress(key, "quoteFeed", quoteFeed);
        vm.serializeAddress(key, "tokens", tokens);
        vm.serializeAddress(key, "feeds", feeds);
        string memory out = vm.serializeAddress(key, "pools", pools);
        string memory path = string.concat("deployments/", vm.toString(block.chainid), "-fixtures.json");
        // Same reason as Deploy. A simulation writes addresses no chain holds, and
        // this file is the committed record the constants in Addresses came from.
        if (vm.isContext(VmSafe.ForgeContext.ScriptDryRun)) {
            console2.log("dry run, left", path, "alone");
            return;
        }
        vm.writeJson(out, path);
    }
}
