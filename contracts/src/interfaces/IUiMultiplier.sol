// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

/// @notice ERC-8056 on the Stock Tokens. Four allowlist tokens have already moved
/// off 1e18, so the value is read to detect a corporate action mid flight and
/// never multiplied into an accounting or baseline path.
interface IUiMultiplier {
    function uiMultiplier() external view returns (uint256);
}
