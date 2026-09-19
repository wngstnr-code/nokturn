// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IUiMultiplier} from "../src/interfaces/IUiMultiplier.sol";

/// @title The check every stock token passes before it reaches an allowlist
/// @notice At least nine contracts on this chain carry the symbol USDG, and a
/// memecoin called GameStop traded thirty million dollars in a month without being
/// a stock token at all. Grouping by symbol is how a number ends up thirty percent
/// wrong, so nothing here reads the symbol.
///
/// Two facts are checked instead. The ERC-1967 beacon slot has to point at the one
/// implementation every real stock token shares, and uiMultiplier has to answer.
/// The multiplier is checked to be at least one, never to equal one. Four of them
/// have already drifted above it, so a gate demanding equality would refuse the
/// anchors of our own allowlist. CLAUDE.md section 5.
library StockTokenGate {
    bytes32 internal constant BEACON_SLOT =
        0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50;
    address internal constant BEACON = 0xe10b6f6B275de231345c20D14Ab812db62151b00;
    uint256 internal constant MIN_MULTIPLIER = 1e18;

    error BeaconMismatch(address token, address found);
    error MultiplierMissing(address token);
    error MultiplierBelowOne(address token, uint256 multiplier);

    function check(address token, bytes32 beaconSlotValue) internal view {
        address beacon = address(uint160(uint256(beaconSlotValue)));
        if (beacon != BEACON) revert BeaconMismatch(token, beacon);

        try IUiMultiplier(token).uiMultiplier() returns (uint256 multiplier) {
            if (multiplier < MIN_MULTIPLIER) revert MultiplierBelowOne(token, multiplier);
        } catch {
            revert MultiplierMissing(token);
        }
    }
}
