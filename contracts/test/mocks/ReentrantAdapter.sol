// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IVenueAdapter} from "../../src/interfaces/IVenueAdapter.sol";
import {MockERC20} from "./MockERC20.sol";

/// @notice A venue that calls back into its caller mid swap. An adapter reaches
/// the allowlist through a timelock, so this is what a mistake at that gate would
/// look like from inside a batch. See rencana-uji.md A3.
contract ReentrantAdapter is IVenueAdapter {
    uint256 public rate;
    address public target;
    bytes public payload;
    bool public fired;
    bool public reentered;
    bytes public revertData;

    function setRate(uint256 rate_) external {
        rate = rate_;
    }

    function armFor(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
        fired = false;
        reentered = false;
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut)
        external
        returns (uint256 amountOut)
    {
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        if (target != address(0) && !fired) {
            fired = true;
            bytes memory data;
            (reentered, data) = target.call(payload);
            revertData = data;
        }
        amountOut = quoteFromState(tokenIn, tokenOut, amountIn);
        require(amountOut >= minOut, "min out");
        MockERC20(tokenOut).mint(msg.sender, amountOut);
    }

    function quoteFromState(address, address, uint256 amountIn) public view returns (uint256) {
        return (amountIn * rate) / 1e18;
    }

    function twap(address, address, uint32) external view returns (uint256) {
        return rate;
    }

    function isQuotable() external pure returns (bool) {
        return true;
    }
}
