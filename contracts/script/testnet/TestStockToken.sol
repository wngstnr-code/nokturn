// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title A stand in for a Stock Token on chain 46630
/// @notice Carries the two things StockTokenGate reads, which are the ERC-1967
/// beacon slot and uiMultiplier. Nothing else about it is a Stock Token. There is
/// no beacon behind that slot on this chain, no issuer, and no transfer
/// restriction.
///
/// Read what this means for the rehearsal honestly. On 46630 the gate is checking
/// a value this contract wrote for it, so passing proves the batch is shaped right
/// and proves nothing about the gate. The gate is proved against the four real
/// mainnet tokens in test/fork/Bootstrap.fork.t.sol, and that is the run that
/// counts.
///
/// The name and symbol carry the test prefix so that nothing here reads as NVDA to
/// a block explorer. Impersonation by symbol is a characteristic of this chain and
/// the answer is not to add to it. See CLAUDE.md section 5.
contract TestStockToken is ERC20 {
    bytes32 internal constant BEACON_SLOT =
        0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50;

    uint256 public immutable uiMultiplier;

    constructor(string memory name_, string memory symbol_, address beacon, uint256 multiplier)
        ERC20(name_, symbol_)
    {
        uiMultiplier = multiplier;
        assembly {
            sstore(BEACON_SLOT, beacon)
        }
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
