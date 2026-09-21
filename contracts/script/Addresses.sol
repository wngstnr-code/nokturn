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

    /// The 46630 rehearsal fixtures, parameter.md section 10.6. Chain 46630 carries
    /// none of the four things above, so they are put there by
    /// script/testnet/DeployTestnetFixtures.s.sol before the deploy runs. They are
    /// constants here for the same reason the mainnet ones are, which is that an
    /// address read from a dotenv file differs between three laptops.
    ///
    /// Replaced wholesale on 20 September 2026 when GME joined the allowlist. The
    /// first batch of four is dead and none of its addresses appear here.
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

    address internal constant TESTNET_QUOTE = 0x4559EF47891FD74571c76852De21E0966409Edce;

    address internal constant TESTNET_NVDA = 0x43945b9Cd5E5ea57470961D28476aB9749fD6835;
    address internal constant TESTNET_AAPL = 0xc471d303fb69F8D710c31Bd3667145646f3d093D;
    address internal constant TESTNET_TSLA = 0x67157B1ee27c3Bd5f2Cf76f0847A8df98D2FC246;
    address internal constant TESTNET_GOOGL = 0x357F431e365f1A6c65304A4aC7002345D8B60481;
    address internal constant TESTNET_GME = 0xb3953D77e5dDb251B3F9C9C38a49B4cB28cbe92d;

    address internal constant TESTNET_POOL_NVDA = 0x1B72BEddb369A5A2F69c66F262aBF49D048fa093;
    address internal constant TESTNET_POOL_AAPL = 0x6c28c436BB2743482Bfd59E8d5A1aC95c41d6e79;
    address internal constant TESTNET_POOL_TSLA = 0xEd7Bbc056fb1bE91f692dbDb289BEbA1e83dB2DC;
    address internal constant TESTNET_POOL_GOOGL = 0x2Cd4A3d3d3dF3Cdc72655Fd6E28Ab0B3395FE2d1;
    address internal constant TESTNET_POOL_GME = 0x0C36D92bd5Ac4564C1010937B191dE21B7c2C302;

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
    /// nothing reverts. Chain 46630 carries no Chainlink feed at all, so this
    /// answers only for mainnet and the rehearsal sets its own.
    function feeds() internal pure returns (address[] memory addrs) {
        addrs = new address[](5);
        addrs[0] = FEED_NVDA;
        addrs[1] = FEED_AAPL;
        addrs[2] = FEED_TSLA;
        addrs[3] = FEED_GOOGL;
        addrs[4] = FEED_GME;
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
