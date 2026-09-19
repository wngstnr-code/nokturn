// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title The quote side of the 46630 rehearsal
/// @notice Chain 46630 carries no canonical USDG, verified in pertanyaan-terbuka.md
/// P2-6 and again on 19 September 2026 by reading the code size at the mainnet
/// address and finding it empty. The rehearsal needs something with six decimals
/// on the quote side, so it deploys this.
///
/// The name and symbol say what it is. Nothing here claims to be USDG, and the
/// mainnet deploy never sees this contract, because Addresses picks by chain id.
contract TestQuoteToken is ERC20 {
    constructor() ERC20("Nokturn Test Quote", "tQUOTE") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
