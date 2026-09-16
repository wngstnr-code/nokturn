// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

interface IVenueAdapter {
    event AdapterAllowlisted(address indexed adapter, bool quotable);
    event AdapterRemoved(address indexed adapter);
    event VenueRouted(
        uint64 indexed batchId,
        address indexed adapter,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );

    error PoolNotInitialized(address pool);
    error TokenNotInPool(address pool, address token);
    error LiquidityExhausted(address pool, uint256 amountRemaining);
    error TooManyTickCrossings(address pool, uint16 crossings);
    error DynamicFeeUnsupported(address pool);

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut)
        external
        returns (uint256 amountOut);

    /// @notice Baseline read straight from pool state. The Uniswap Quoter cannot be
    /// staticcalled because it tries to SSTORE, so this recomputes the swap instead.
    /// Reverts rather than guessing when the venue is not computable from state.
    /// Rounds the received amount UP. See parameter.md section 4B for why that
    /// exception to the usual rounding direction exists.
    function quoteFromState(address tokenIn, address tokenOut, uint256 amountIn)
        external
        view
        returns (uint256 amountOut);

    function twap(address tokenIn, address tokenOut, uint32 window) external view returns (uint256 price);

    /// @notice False means the venue cannot back a contract verifiable baseline.
    /// Settlement may only use quotable adapters for baseline computation.
    function isQuotable() external view returns (bool);
}
