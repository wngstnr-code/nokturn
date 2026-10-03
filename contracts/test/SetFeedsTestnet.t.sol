// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {PriceOracle} from "../src/PriceOracle.sol";
import {Addresses} from "../script/Addresses.sol";
import {SetFeeds} from "../script/SetFeeds.s.sol";

/// @notice The batch SetFeeds sends is chosen by chain id, so both branches are
/// read back here call by call. The mainnet branch is also exercised against the
/// live oracle in test/fork/SetFeeds.fork.t.sol.
contract SetFeedsTestnetTest is Test {
    address constant ORACLE = address(0x0AC1E);
    address constant ADAPTER = address(0xADA);

    function test_testnetPointsEveryTokenAtItsMirror() public {
        vm.chainId(Addresses.TESTNET);
        _expect(
            [
                Addresses.TESTNET_NVDA,
                Addresses.TESTNET_AAPL,
                Addresses.TESTNET_TSLA,
                Addresses.TESTNET_GOOGL,
                Addresses.TESTNET_GME
            ],
            [
                Addresses.TESTNET_FEED_NVDA,
                Addresses.TESTNET_FEED_AAPL,
                Addresses.TESTNET_FEED_TSLA,
                Addresses.TESTNET_FEED_GOOGL,
                Addresses.TESTNET_FEED_GME
            ],
            Addresses.TESTNET_QUOTE,
            Addresses.TESTNET_FEED_QUOTE
        );
    }

    function test_mainnetStillPointsAtTheChainlinkProxies() public {
        vm.chainId(Addresses.MAINNET);
        _expect(
            [Addresses.NVDA, Addresses.AAPL, Addresses.TSLA, Addresses.GOOGL, Addresses.GME],
            [
                Addresses.FEED_NVDA,
                Addresses.FEED_AAPL,
                Addresses.FEED_TSLA,
                Addresses.FEED_GOOGL,
                Addresses.FEED_GME
            ],
            Addresses.USDG,
            Addresses.FEED_USDG
        );
    }

    function _expect(address[5] memory tokens, address[5] memory feeds, address quote, address quoteFeed)
        internal
    {
        (address[] memory targets,, bytes[] memory payloads) = new SetFeeds().batch(ORACLE, ADAPTER);
        assertEq(targets.length, 11);

        uint32[] memory open = Addresses.stalenessOpen();
        uint32[] memory closed = Addresses.stalenessClosed();
        for (uint256 i = 0; i < 5; ++i) {
            assertEq(
                payloads[i], abi.encodeCall(PriceOracle.setFeed, (tokens[i], feeds[i], open[i], closed[i]))
            );
            assertEq(
                payloads[5 + i],
                abi.encodeCall(PriceOracle.setTwapSource, (tokens[i], ADAPTER, quote, Addresses.TWAP_WINDOW))
            );
        }
        assertEq(
            payloads[10],
            abi.encodeCall(
                PriceOracle.setFeed, (quote, quoteFeed, Addresses.STALENESS_USDG, Addresses.STALENESS_USDG)
            )
        );
    }
}
