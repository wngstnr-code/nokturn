// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IVenueAdapter} from "../../src/interfaces/IVenueAdapter.sol";

contract MockAdapter is IVenueAdapter {
    uint256 public twapPrice;

    function setTwap(uint256 price) external {
        twapPrice = price;
    }

    function twap(address, address, uint32) external view returns (uint256) {
        return twapPrice;
    }

    function swap(address, address, uint256, uint256) external pure returns (uint256) {
        revert("not used");
    }

    function quoteFromState(address, address, uint256) external pure returns (uint256) {
        revert("not used");
    }

    function isQuotable() external pure returns (bool) {
        return true;
    }
}
