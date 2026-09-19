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

    function allowlist() internal pure returns (address[] memory tokens) {
        tokens = new address[](4);
        tokens[0] = NVDA;
        tokens[1] = AAPL;
        tokens[2] = TSLA;
        tokens[3] = GOOGL;
    }

    function pools() internal pure returns (address[] memory addrs) {
        addrs = new address[](4);
        addrs[0] = POOL_NVDA;
        addrs[1] = POOL_AAPL;
        addrs[2] = POOL_TSLA;
        addrs[3] = POOL_GOOGL;
    }
}
