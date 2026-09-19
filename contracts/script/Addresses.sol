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

    /// The Uniswap V3 pools each token quotes against USDG, parameter.md section
    /// 10.4. The adapter is agnostic about the factory, so these are addresses
    /// rather than a factory lookup.
    address internal constant POOL_NVDA = 0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3;
    address internal constant POOL_AAPL = 0xAae0d815EE56e4092a5E5C2911E676Fea50B2d6D;
    address internal constant POOL_TSLA = 0xf4ACdAEEB7022862A763C9B1B885e11191c889E3;
    address internal constant POOL_GOOGL = 0x34D0dC122CF9A8Eb296fC5e0D3A233625D7d19b7;

    /// The 46630 rehearsal fixtures, parameter.md section 10.6. Chain 46630 carries
    /// none of the four things above, so they are put there by
    /// script/testnet/DeployTestnetFixtures.s.sol before the deploy runs. They are
    /// constants here for the same reason the mainnet ones are, which is that an
    /// address read from a dotenv file differs between three laptops.
    address internal constant TESTNET_QUOTE = 0xDC2b135b0406B07B46876653825D7933B5A44B7A;

    address internal constant TESTNET_NVDA = 0x4696687FDf6f2DDB8007E869c5c04505aa33663a;
    address internal constant TESTNET_AAPL = 0xf34c7a37Fd014DE45B6a4C9828b23Dfcf5565aAB;
    address internal constant TESTNET_TSLA = 0x3D434cECeFC14CCc470eC7dA8bF2C063b6F561F0;
    address internal constant TESTNET_GOOGL = 0x2974FA37d2f7Da3EaeC2AFedaa08E5DB4E7c8552;

    address internal constant TESTNET_POOL_NVDA = 0x6cB0599875d2335b613a0d3e2A96403a56488EFF;
    address internal constant TESTNET_POOL_AAPL = 0xD7f33F30B91D109527C89b6B124194da8fd13F7F;
    address internal constant TESTNET_POOL_TSLA = 0x32194297aFf703c9305e7E1f04051daFAb707aB9;
    address internal constant TESTNET_POOL_GOOGL = 0xE287eE9a0AEf2F6B88fcF9232cE2dFFccA2e6b2a;

    /// @dev The quote side of every pair. Reading chain id rather than taking a
    /// parameter, because a deploy that can be pointed at the wrong quote token by
    /// a flag is a deploy that will be, once.
    function quote() internal view returns (address) {
        return block.chainid == TESTNET ? TESTNET_QUOTE : USDG;
    }

    function allowlist() internal view returns (address[] memory tokens) {
        tokens = new address[](4);
        if (block.chainid == TESTNET) {
            tokens[0] = TESTNET_NVDA;
            tokens[1] = TESTNET_AAPL;
            tokens[2] = TESTNET_TSLA;
            tokens[3] = TESTNET_GOOGL;
            return tokens;
        }
        tokens[0] = NVDA;
        tokens[1] = AAPL;
        tokens[2] = TSLA;
        tokens[3] = GOOGL;
    }

    function pools() internal view returns (address[] memory addrs) {
        addrs = new address[](4);
        if (block.chainid == TESTNET) {
            addrs[0] = TESTNET_POOL_NVDA;
            addrs[1] = TESTNET_POOL_AAPL;
            addrs[2] = TESTNET_POOL_TSLA;
            addrs[3] = TESTNET_POOL_GOOGL;
            return addrs;
        }
        addrs[0] = POOL_NVDA;
        addrs[1] = POOL_AAPL;
        addrs[2] = POOL_TSLA;
        addrs[3] = POOL_GOOGL;
    }
}
