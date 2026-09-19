// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

/// @title The emergency stop, and the limits on it
/// @notice parameter.md section 8. A guardian can stop the protocol taking on
/// anything new, instantly and without the timelock, because an emergency stop
/// that waits two days is not one.
///
/// Three things bound it, and each is here rather than in a policy document.
///
/// There is no unpause. The pause carries its own deadline and lapses, so the
/// guardian cannot lift it either, and a mistaken pause costs six hours rather than
/// the forty eight a timelock proposal would.
///
/// The address is a parameter the timelock owns, not an immutable. A guardian can
/// pause again the moment the last one lapses, so a leaked key can hold the
/// protocol down. What it cannot do is hold it down past a rotation, which is what
/// puts a ceiling of forty eight hours on the damage.
///
/// And whenLive never guards a way out. See section 8.2 for the list, and the tests
/// that walk every exit while paused.
abstract contract Guarded {
    uint32 public constant PAUSE_DURATION = 6 hours;

    address public guardian;
    uint64 public pausedUntil;

    error NotGuardian(address caller);
    error ProtocolPaused(uint64 until);

    event GuardianChanged(address indexed guardian);
    event Paused(address indexed guardian, uint64 until);

    constructor(address guardian_) {
        guardian = guardian_;
        emit GuardianChanged(guardian_);
    }

    /// @notice Stops everything that would take on new value, for six hours.
    /// @dev Callable again while already paused. An incident does not agree to last
    /// six hours, and the ceiling on abusing that is the rotation, not the clock.
    function pause() external {
        if (msg.sender != guardian) revert NotGuardian(msg.sender);

        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 until = uint64(block.timestamp) + PAUSE_DURATION;
        pausedUntil = until;
        emit Paused(msg.sender, until);
    }

    function isPaused() public view returns (bool) {
        // forge-lint: disable-next-line(block-timestamp)
        return block.timestamp < pausedUntil;
    }

    modifier whenLive() {
        if (isPaused()) revert ProtocolPaused(pausedUntil);
        _;
    }

    function _setGuardian(address guardian_) internal {
        guardian = guardian_;
        emit GuardianChanged(guardian_);
    }
}
