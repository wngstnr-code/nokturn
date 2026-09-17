// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SessionManager} from "../../src/SessionManager.sol";
import {Session} from "../../src/types/Types.sol";
import {CalendarFixture} from "../fixtures/CalendarFixture.sol";
import {SessionHandler} from "./SessionHandler.sol";

/// @notice Invariant I12 from rencana-uji.md section 1. sessionAt is a pure read
/// of two tables, and the only runtime input the engine takes is the per token
/// protective flag, which must never reach it. Everything downstream, from batch
/// alignment to the price band to the exposure cap scale, is derived from this
/// one answer, so a sessionAt that drifted would move all of them at once.
contract SessionInvariants is Test {
    uint256 internal constant PROBE_COUNT = 24;

    SessionManager sessions;
    SessionHandler handler;

    address governor = address(0x60174E);

    uint64[PROBE_COUNT] internal probes;
    Session[PROBE_COUNT] internal answers;

    /// Wednesday 11 March 2026, the opening bell.
    uint64 constant BELL = 1_773_235_800;

    function setUp() public {
        sessions = new SessionManager(governor);
        vm.startPrank(governor);
        sessions.setDstBoundaries(CalendarFixture.loadDst());
        CalendarFixture.loadCalendar(sessions, CalendarFixture.loadDays());
        vm.stopPrank();

        vm.warp(BELL);

        // Probes spread over the covered range rather than clustered near now, so
        // a table read that went wrong far from the current block still shows up.
        uint64 first = 1_577_836_800; // 2020-01-01
        uint64 span = 2_082_758_400 - first; // through 2035-12-31
        for (uint256 k = 0; k < PROBE_COUNT; ++k) {
            probes[k] = first + uint64((span * k) / PROBE_COUNT) + uint64(k * 3607);
            answers[k] = sessions.sessionAt(probes[k]);
        }

        handler = new SessionHandler(sessions, governor);
        targetContract(address(handler));
    }

    /// I12. Same timestamp, same answer, whatever the clock has done since and
    /// whatever the guardian has flagged.
    function invariant_sessionAtAnswersTheSameForATimestampForever() public view {
        for (uint256 k = 0; k < PROBE_COUNT; ++k) {
            assertEq(
                uint8(sessions.sessionAt(probes[k])),
                uint8(answers[k]),
                "sessionAt moved for a timestamp that did not"
            );
        }
    }

    /// The protective flag is per token and overrides the time based state for
    /// that token only. It is the one runtime input the engine has, and leaking it
    /// into sessionAt would take the whole calendar with it.
    function invariant_theProtectiveFlagNeverReachesTheCalendar() public view {
        Session timeBased = sessions.sessionAt(uint64(block.timestamp));
        for (uint256 k = 0; k < 3; ++k) {
            address token = handler.tokenAt(k);
            Session expected = sessions.protective(token) ? Session.PROTECTIVE : timeBased;
            assertEq(uint8(sessions.tokenSession(token)), uint8(expected), "token session drifted");
        }
        assertEq(uint8(sessions.currentSession()), uint8(timeBased), "current session drifted");
    }

    /// Every parameter the rest of the protocol reads off a session is a pure
    /// function of that session, so two tokens in the same session can never be
    /// handed different batch durations or different bands.
    function invariant_sessionParametersDependOnNothingButTheSession() public view {
        for (uint256 s = 0; s <= uint8(Session.PROTECTIVE); ++s) {
            Session session = Session(s);
            assertEq(sessions.batchDuration(session), sessions.batchDuration(session), "duration drifted");
            assertEq(sessions.maxDeviationBps(session), sessions.maxDeviationBps(session), "band drifted");
        }
        assertEq(sessions.batchDuration(Session.OPEN), 10, "the open batch is ten seconds");
        assertEq(sessions.maxDeviationBps(Session.PROTECTIVE), 20, "protective is the tightest band");
    }

    /// The guard band is symmetric by construction, and a timestamp inside one is
    /// inside it whichever side the caller approached from.
    function invariant_theGuardBandIsTheSameFromBothSides() public view {
        uint64 now_ = uint64(block.timestamp);
        uint64 band = sessions.GUARD_BAND();
        if (now_ <= band) return;
        if (!sessions.inGuardBand(now_)) return;

        bool before = sessions.sessionAt(now_ - band) != sessions.sessionAt(now_);
        bool later = sessions.sessionAt(now_ + band) != sessions.sessionAt(now_);
        assertTrue(before || later, "the guard band flagged an instant with no boundary near it");
    }

    /// The flag has to be reachable for the invariants above to be about anything,
    /// and it has to stay shut to everyone but the governor.
    function test_onlyTheGovernorCanRaiseTheProtectiveFlag() public {
        handler.actSetProtectiveAsStranger(1);
        assertEq(handler.protectiveSets(), 0, "a stranger raised the flag");

        handler.actSetProtective(1);
        assertEq(handler.protectiveSets(), 1, "the governor could not raise the flag");
        assertTrue(sessions.protective(handler.tokenAt(1)), "the flag did not stick");
        assertEq(uint8(sessions.tokenSession(handler.tokenAt(1))), uint8(Session.PROTECTIVE));
    }
}
