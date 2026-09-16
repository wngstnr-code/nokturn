// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockERC20 is ERC20 {
    uint8 private immutable _decimals;
    uint256 public uiMultiplier = 1e18;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// Four allowlist tokens have already moved off 1e18 on mainnet, and three of
    /// those moves landed inside the OPEN session, so a batch has to survive it.
    function setUiMultiplier(uint256 m) external {
        uiMultiplier = m;
    }
}
