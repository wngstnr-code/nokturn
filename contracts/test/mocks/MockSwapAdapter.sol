// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IVenueAdapter} from "../../src/interfaces/IVenueAdapter.sol";
import {MockERC20} from "./MockERC20.sol";

/// @notice A venue that swaps at a fixed rate out of its own inventory. The real
/// UniswapV3Adapter computes from pool state and is exercised against a mainnet
/// fork instead, because a mock pool would let us choose our own baseline, which
/// is the one number this protocol must never choose for itself.
contract MockSwapAdapter is IVenueAdapter {
    mapping(address => mapping(address => uint256)) public rate; // tokenIn to tokenOut, 1e18
    bool public quotable = true;

    /// The oracle reads a WAD price per smallest unit, the swap path reads raw
    /// units. They are different functions of the same pool in reality, and holding
    /// them in one mapping made a test that set one silently change the other.
    mapping(address => mapping(address => uint256)) public twapRate;

    function setRate(address tokenIn, address tokenOut, uint256 rate_) external {
        rate[tokenIn][tokenOut] = rate_;
    }

    function setQuotable(bool value) external {
        quotable = value;
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut)
        external
        returns (uint256 amountOut)
    {
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        amountOut = quoteFromState(tokenIn, tokenOut, amountIn);
        require(amountOut >= minOut, "min out");
        MockERC20(tokenOut).mint(msg.sender, amountOut);
    }

    function quoteFromState(address tokenIn, address tokenOut, uint256 amountIn)
        public
        view
        returns (uint256)
    {
        return (amountIn * rate[tokenIn][tokenOut]) / 1e18;
    }

    /// The mid price, deliberately not the quote. An oracle comparison reads the
    /// market's price, not the price after a fee.
    function twap(address tokenIn, address tokenOut, uint32) external view returns (uint256) {
        uint256 set = twapRate[tokenIn][tokenOut];
        return set == 0 ? rate[tokenIn][tokenOut] : set;
    }

    function setTwapRate(address tokenIn, address tokenOut, uint256 rate_) external {
        twapRate[tokenIn][tokenOut] = rate_;
    }

    function isQuotable() external view returns (bool) {
        return quotable;
    }
}
