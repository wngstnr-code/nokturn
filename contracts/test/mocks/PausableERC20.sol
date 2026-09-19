// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice A token whose issuer can stop it moving. P0-1 proved there is no KYC
/// gate on transfer today, but Stock Tokens are beacon proxies and the absence of
/// a blocklist cannot be proved from outside. See rencana-uji.md A10.
contract PausableERC20 is ERC20 {
    error TransferPaused();

    uint8 private immutable _decimals;
    uint256 public uiMultiplier = 1e18;
    bool public paused;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setPaused(bool value) external {
        paused = value;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (paused && from != address(0)) revert TransferPaused();
        super._update(from, to, value);
    }
}
