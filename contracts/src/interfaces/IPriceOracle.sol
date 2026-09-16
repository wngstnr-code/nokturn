// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

interface IPriceOracle {
    event OracleDisagreement(address indexed token, uint256 primary, uint256 secondary, uint16 deviationBps);
    event OracleStale(address indexed token, uint64 lastUpdate, uint32 limit);
    event OracleHealthy(address indexed token);

    function refPrice(address token) external view returns (uint256 price, uint64 ts, bool healthy);

    /// @notice Second source is a Uniswap V3 TWAP. RedStone does not exist on this chain.
    function dualCheck(address token) external view returns (uint256 chainlink, uint256 uniTwap, bool agree);

    /// @notice TWAP over the first 300 seconds of the OPEN session. This is a
    /// reference, not the exchange official open, which is not onchain at all.
    function openReference(address token, uint32 day) external view returns (uint256 price, bool available);

    function stalenessLimit(address token) external view returns (uint32);
}
