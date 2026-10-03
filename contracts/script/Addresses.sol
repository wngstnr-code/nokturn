// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

/// @title Addresses this protocol does not own
/// @notice Production values that are not secrets, so parameter.md holds them and
/// the code repeats them as constants rather than reading them from the
/// environment. An address that lives in a dotenv file is an address that differs
/// between three laptops, and a fork test pointed at the wrong token stays green
/// while testing the wrong chain.
///
/// The stock tokens are checked against the beacon and the multiplier before they
/// reach an allowlist, because impersonation is a characteristic of this chain
/// rather than an isolated case. See StockTokenGate and CLAUDE.md section 5.
library Addresses {
    uint256 internal constant MAINNET = 4663;
    uint256 internal constant TESTNET = 46_630;

    /// parameter.md section 10.1.
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    address internal constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address internal constant AAPL = 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9;
    address internal constant TSLA = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;
    address internal constant GOOGL = 0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3;
    address internal constant GME = 0x1b0E319c6A659F002271B69dB8A7df2F911c153E;

    /// The Uniswap V3 pools each token quotes against USDG, parameter.md section
    /// 10.4. The adapter is agnostic about the factory, so these are addresses
    /// rather than a factory lookup.
    address internal constant POOL_NVDA = 0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3;
    address internal constant POOL_AAPL = 0xAae0d815EE56e4092a5E5C2911E676Fea50B2d6D;
    address internal constant POOL_TSLA = 0xf4ACdAEEB7022862A763C9B1B885e11191c889E3;
    address internal constant POOL_GOOGL = 0x34D0dC122CF9A8Eb296fC5e0D3A233625D7d19b7;
    address internal constant POOL_GME = 0xE2b46c905E12Ab8E2f864e4821a4325884C1B126;

    /// The Chainlink proxies, parameter.md section 7.1. Proxies rather than the
    /// aggregators behind them, so an aggregator swap does not cut the consumer off.
    /// Verified against the chain on 19 September 2026, all four eight decimals and
    /// describing the Robinhood token rather than the ordinary share.
    address internal constant FEED_NVDA = 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15;
    address internal constant FEED_AAPL = 0x6B22A786bAa607d76728168703a39Ea9C99f2cD0;
    address internal constant FEED_TSLA = 0x4A1166a659A55625345e9515b32adECea5547C38;
    address internal constant FEED_GOOGL = 0xF6f373a037c30F0e5010d854385cA89185AE638b;
    address internal constant FEED_GME = 0x27C71df6A64fB476468EdF256CF72c038baB5B67;

    /// The quote asset needs a feed like everything else, because Settlement prices
    /// every token in a solution and USDG is in every solution. Two proxies answer
    /// the same value from the same aggregator, and this is the one the chain reads,
    /// with 1,340,130 calls from 659 callers in ninety days against 67 from 15.
    /// parameter.md section 7.1.
    address internal constant FEED_USDG = 0x61B7e5650328764B076A108EFF5fa7282a1B9aD2;

    /// One number for every session, which is not a shortcut. The equity feeds stop
    /// for the weekend and USDG does not, measured over its whole history at 107
    /// rounds with a minimum gap of 86,400 seconds and a maximum of 86,487.
    ///
    /// Two heartbeats rather than the p99 rounded up. p99 here is the heartbeat
    /// itself, so rounding it up would leave 513 seconds of tolerance, and USDG
    /// being unhealthy stops every batch on every token. parameter.md 7.1.
    uint32 internal constant STALENESS_USDG = 174_000;

    /// Staleness per feed, parameter.md section 7.1. These are the p99 gap between
    /// updates over the whole eighty eight days of feed history, rounded up to the
    /// nearest thousand, not the p95 over one short window. p95 would drop one batch
    /// in twenty into PROTECTIVE during the busiest session with nothing broken, and
    /// staleness is not what holds losses down. The exposure cap and the price band
    /// are.
    uint32 internal constant STALENESS_OPEN_NVDA = 19_000;
    uint32 internal constant STALENESS_OPEN_AAPL = 64_000;
    uint32 internal constant STALENESS_OPEN_TSLA = 15_000;
    uint32 internal constant STALENESS_OPEN_GOOGL = 55_000;
    uint32 internal constant STALENESS_OPEN_GME = 65_000;

    uint32 internal constant STALENESS_CLOSED_NVDA = 61_000;
    uint32 internal constant STALENESS_CLOSED_AAPL = 67_000;
    uint32 internal constant STALENESS_CLOSED_TSLA = 60_000;
    uint32 internal constant STALENESS_CLOSED_GOOGL = 65_000;
    /// Smaller than the open limit, which is not a typo. The GME feed is steadier
    /// outside market hours than inside them. parameter.md section 7.1.
    uint32 internal constant STALENESS_CLOSED_GME = 56_000;

    /// parameter.md section 7.1.
    uint32 internal constant TWAP_WINDOW = 1800;

    /// The 46630 rehearsal fixtures, parameter.md section 10.6. Chain 46630 carries
    /// none of the things above, so they are put there by
    /// script/testnet/DeployTestnetFixtures.s.sol before the deploy runs. They are
    /// constants here for the same reason the mainnet ones are, which is that an
    /// address read from a dotenv file differs between three laptops.
    ///
    /// The third set, 3 October 2026. Every feed mirrors the mainnet proxy above it
    /// and every pool prices from those feeds, so no number here was chosen by us.
    /// The two earlier sets are dead and none of their addresses appear here.
    address internal constant TESTNET_QUOTE = 0x1C169f5e8A14e87748B2e9E4106d269558b989A4;
    address internal constant TESTNET_FEED_QUOTE = 0x8D4B80775A28FCc0bDA902E39C58185Ac7d5f1B7;

    address internal constant TESTNET_NVDA = 0xe31B7cd77Fe9fFc9829f3B77F7F7ff97ccA8702b;
    address internal constant TESTNET_AAPL = 0x93a09e967Ad75E4725048F6bD76DAE11152C3274;
    address internal constant TESTNET_TSLA = 0xD1E63D6ba57055E4304056d7F7BA2717127Ebe3C;
    address internal constant TESTNET_GOOGL = 0xb238c0EcF5B312B31481337a3B9b291cA394f195;
    address internal constant TESTNET_GME = 0x1353f399d33989a2073D9e975236602DCba934DD;

    address internal constant TESTNET_FEED_NVDA = 0x28077862cC52438007517C406ce88E93E91b322d;
    address internal constant TESTNET_FEED_AAPL = 0xB02C8d7C1FDcB03482BFCC8D8fe0e7C037E2De5C;
    address internal constant TESTNET_FEED_TSLA = 0x7031F277F80185fE30C05dFe1B96557E206f6322;
    address internal constant TESTNET_FEED_GOOGL = 0x91EF120848D2Dd97DB66804AEff6d4fc988d38a9;
    address internal constant TESTNET_FEED_GME = 0x41B895C2300A3Ab61929401efD00d43CBEe6cC7f;

    address internal constant TESTNET_POOL_NVDA = 0xf9885CD0ebAcb46eBbA46c3D4A4D8D0Fe2e171A1;
    address internal constant TESTNET_POOL_AAPL = 0x64a61b53265C021400Bf6812bcC8F10c075e9786;
    address internal constant TESTNET_POOL_TSLA = 0xA819c5993fcb1939F1B1bcFa8D2C7C1d5dAA977d;
    address internal constant TESTNET_POOL_GOOGL = 0xfa037A6aea7951Ce99870C9aed76AB3fFa8873ED;
    address internal constant TESTNET_POOL_GME = 0x0f469e2b4922EBe09A5D77Bf0A9CC9EA6ad9637f;

    /// @dev The quote side of every pair. Reading chain id rather than taking a
    /// parameter, because a deploy that can be pointed at the wrong quote token by
    /// a flag is a deploy that will be, once.
    function quote() internal view returns (address) {
        return block.chainid == TESTNET ? TESTNET_QUOTE : USDG;
    }

    function allowlist() internal view returns (address[] memory tokens) {
        if (block.chainid == TESTNET) {
            tokens = new address[](5);
            tokens[0] = TESTNET_NVDA;
            tokens[1] = TESTNET_AAPL;
            tokens[2] = TESTNET_TSLA;
            tokens[3] = TESTNET_GOOGL;
            tokens[4] = TESTNET_GME;
            return tokens;
        }
        tokens = new address[](5);
        tokens[0] = NVDA;
        tokens[1] = AAPL;
        tokens[2] = TSLA;
        tokens[3] = GOOGL;
        tokens[4] = GME;
    }

    /// @dev Same order as allowlist, because a feed table that drifts out of step
    /// with the token table configures the wrong token against the wrong price and
    /// nothing reverts. On 46630 these are the mirrors of the mainnet proxies, which
    /// keep mainnet timestamps, so the staleness limits below hold on both chains.
    function feeds() internal view returns (address[] memory addrs) {
        addrs = new address[](5);
        if (block.chainid == TESTNET) {
            addrs[0] = TESTNET_FEED_NVDA;
            addrs[1] = TESTNET_FEED_AAPL;
            addrs[2] = TESTNET_FEED_TSLA;
            addrs[3] = TESTNET_FEED_GOOGL;
            addrs[4] = TESTNET_FEED_GME;
            return addrs;
        }
        addrs[0] = FEED_NVDA;
        addrs[1] = FEED_AAPL;
        addrs[2] = FEED_TSLA;
        addrs[3] = FEED_GOOGL;
        addrs[4] = FEED_GME;
    }

    function quoteFeed() internal view returns (address) {
        return block.chainid == TESTNET ? TESTNET_FEED_QUOTE : FEED_USDG;
    }

    function stalenessOpen() internal pure returns (uint32[] memory limits) {
        limits = new uint32[](5);
        limits[0] = STALENESS_OPEN_NVDA;
        limits[1] = STALENESS_OPEN_AAPL;
        limits[2] = STALENESS_OPEN_TSLA;
        limits[3] = STALENESS_OPEN_GOOGL;
        limits[4] = STALENESS_OPEN_GME;
    }

    function stalenessClosed() internal pure returns (uint32[] memory limits) {
        limits = new uint32[](5);
        limits[0] = STALENESS_CLOSED_NVDA;
        limits[1] = STALENESS_CLOSED_AAPL;
        limits[2] = STALENESS_CLOSED_TSLA;
        limits[3] = STALENESS_CLOSED_GOOGL;
        limits[4] = STALENESS_CLOSED_GME;
    }

    function pools() internal view returns (address[] memory addrs) {
        if (block.chainid == TESTNET) {
            addrs = new address[](5);
            addrs[0] = TESTNET_POOL_NVDA;
            addrs[1] = TESTNET_POOL_AAPL;
            addrs[2] = TESTNET_POOL_TSLA;
            addrs[3] = TESTNET_POOL_GOOGL;
            addrs[4] = TESTNET_POOL_GME;
            return addrs;
        }
        addrs = new address[](5);
        addrs[0] = POOL_NVDA;
        addrs[1] = POOL_AAPL;
        addrs[2] = POOL_TSLA;
        addrs[3] = POOL_GOOGL;
        addrs[4] = POOL_GME;
    }
}
