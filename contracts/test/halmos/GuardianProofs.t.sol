// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Guarded} from "../../src/Guarded.sol";

contract GuardedProbe is Guarded {
    uint256 public liveCalls;

    constructor(address guardian_) Guarded(guardian_) {}

    function act() external whenLive {
        liveCalls += 1;
    }

    function rotate(address guardian_) external {
        _setGuardian(guardian_);
    }
}

/// @notice The last row of rencana-uji.md section 4, which asks for a proof that no
/// execution path runs from the guardian to a transfer of funds.
///
/// It is proved in two halves, and only one of them belongs to a solver.
///
/// The half here is that pause gives the guardian nothing. It is the only function
/// in the protocol that compares a caller against the guardian address, so whatever
/// it cannot do, the guardian cannot do. What it writes is one deadline. It cannot
/// move value because it holds no token logic, it cannot keep itself alive because
/// there is no unpause, and it cannot make itself permanent because the deadline is
/// always a fixed distance ahead of now.
///
/// The other half is that pause stays the only such comparison. A solver cannot
/// prove that, because it is a statement about source that has not been written
/// yet. tools/guardian-gate.py holds it instead, and CI runs it on every push.
contract GuardianProofs is Test {
    address internal constant GUARDIAN = address(0x6A4D1A4);

    GuardedProbe internal probe;

    function setUp() public {
        probe = new GuardedProbe(GUARDIAN);
    }

    /// Nobody but the guardian gets in. Stated over a symbolic caller rather than
    /// over a handful of addresses, because the pause has no timelock in front of
    /// it and the caller check is therefore the whole of its access control.
    function testFuzz_onlyTheGuardianCanPause(address caller) public {
        vm.assume(caller != GUARDIAN);

        vm.prank(caller);
        _expectRefusal(caller);
    }

    /// The deadline is always exactly six hours ahead of the call, at any moment in
    /// the contract's life. A pause that could reach further than that, by any
    /// arithmetic, would be an indefinite stop wearing a duration.
    function testFuzz_aPauseNeverReachesFurtherThanItsDuration(uint64 at) public {
        vm.assume(at < type(uint64).max - probe.PAUSE_DURATION());
        vm.warp(at);

        vm.prank(GUARDIAN);
        probe.pause();

        assertEq(probe.pausedUntil(), at + probe.PAUSE_DURATION(), "the pause reached a different deadline");
    }

    /// And it always lapses. Whatever the guardian did, once the clock passes the
    /// deadline the protocol answers again, and no call from the guardian was
    /// needed to make that happen.
    function testFuzz_thePauseAlwaysLapses(uint64 at, uint64 later) public {
        vm.assume(at < type(uint64).max - probe.PAUSE_DURATION());
        vm.warp(at);

        vm.prank(GUARDIAN);
        probe.pause();

        vm.assume(later >= at + probe.PAUSE_DURATION());
        vm.warp(later);

        assertFalse(probe.isPaused(), "a pause outlived its own deadline");
        probe.act();
    }

    /// Pausing changes the deadline and nothing else. In particular it never
    /// touches who the guardian is, so a guardian cannot entrench itself against
    /// the rotation that bounds the damage a leaked key can do.
    function testFuzz_pausingNeverChangesWhoTheGuardianIs(uint64 at) public {
        vm.assume(at < type(uint64).max - probe.PAUSE_DURATION());
        vm.warp(at);

        vm.prank(GUARDIAN);
        probe.pause();

        assertEq(probe.guardian(), GUARDIAN, "the guardian rewrote itself");
    }

    /// A rotation takes effect at once. The old address loses the only power it had
    /// in the same transaction, which is what makes forty eight hours the ceiling
    /// on a compromised key rather than a starting point.
    function testFuzz_aRotationEndsTheOldGuardianImmediately(address replacement) public {
        vm.assume(replacement != GUARDIAN);

        probe.rotate(replacement);

        vm.prank(GUARDIAN);
        _expectRefusal(GUARDIAN);
    }

    /// @dev A raw call rather than expectRevert. Halmos does not implement that
    /// cheat code, and a proof that only runs under forge is a fuzz test wearing
    /// the wrong name.
    function _expectRefusal(address caller) internal {
        (bool ok, bytes memory data) = address(probe).call(abi.encodeCall(Guarded.pause, ()));

        assertFalse(ok, "pause answered somebody who is not the guardian");
        assertEq(
            data, abi.encodeWithSelector(Guarded.NotGuardian.selector, caller), "refused for the wrong reason"
        );
    }
}
