// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice A token that calls back into its caller's counterparty during a
/// transfer. Stock Tokens are beacon proxies to an implementation their issuer
/// controls, so a transfer hook is one upgrade away rather than impossible, and
/// rencana-uji.md section 6 asks for exactly this kind of token in the suite.
contract ReentrantERC20 is ERC20 {
    uint8 private immutable _decimals;
    uint256 public uiMultiplier = 1e18;

    address public target;
    bytes public payload;
    bool public fired;
    bool public reentered;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function armFor(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
        fired = false;
        reentered = false;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        bool ok = super.transferFrom(from, to, amount);
        if (target != address(0) && !fired) {
            fired = true;
            // The call is allowed to fail. Whether it does is the whole question.
            (reentered,) = target.call(payload);
        }
        return ok;
    }
}
