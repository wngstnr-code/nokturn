// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {SessionManager} from "../../src/SessionManager.sol";
import {Session} from "../../src/types/Types.sol";

/// @dev Echidna calls the target contract, so a call that has to come from
/// somewhere else needs somewhere else to exist. This is it.
contract SessionStranger {
    function setProtective(SessionManager sessions, address token) external {
        sessions.setProtective(token, "not yours");
    }

    function reportHealthy(SessionManager sessions, address token) external {
        sessions.reportHealthy(token);
    }
}

/// @notice I12 under echidna. The session engine takes one runtime input, the per
/// token protective flag, and that input must never reach sessionAt. Thirty two
/// timestamps are answered once at construction and then answered again after
/// every action for the rest of the campaign, and the two answers have to agree
/// forever.
///
/// The table here is synthetic and the campaign says so. Two DST boundaries
/// bracket the run, one day inside the window is a holiday and another is an early
/// close, which is enough to put every session kind in front of a probe. Whether
/// the real NYSE calendar is loaded correctly is a different question, answered by
/// the foundry suite against sixteen years of the committed fixture. What is being
/// asked here is whether the answer for a fixed second can be moved at runtime.
contract EchidnaSession {
    uint256 internal constant PROBES = 32;

    SessionManager internal sessions;
    SessionStranger internal stranger;

    address[3] internal tokens;

    uint64[PROBES] internal probeAt;
    uint8[PROBES] internal probeAnswer;

    uint256 public protectiveSets;
    uint256 public protectiveClears;
    uint256 public strangerGotIn;
    uint256 public answerChanged;

    constructor() {
        sessions = new SessionManager(address(this));
        stranger = new SessionStranger();

        uint64 origin = uint64(block.timestamp);
        uint64[] memory dst = new uint64[](2);
        dst[0] = origin - 30 days;
        dst[1] = origin + 300 days;
        sessions.setDstBoundaries(dst);

        // One holiday and one early close, placed by day number rather than by
        // date, because a synthetic table has no dates to be right about.
        // The calendar is keyed by days since the epoch in Eastern time, and the
        // bracketing table above puts the whole window one boundary in, which is
        // the EDT side at UTC minus four.
        uint32 day = uint32((origin - 14_400) / 86_400);
        uint32[] memory dates = new uint32[](2);
        uint8[] memory kinds = new uint8[](2);
        uint32[] memory closeTimes = new uint32[](2);
        dates[0] = day + 3;
        kinds[0] = 1; // holiday
        dates[1] = day + 10;
        kinds[1] = 2; // early close
        closeTimes[1] = 46_800; // 13:00 ET, the half day the NYSE actually keeps
        sessions.setCalendarEntries(dates, kinds, closeTimes);

        tokens[0] = address(0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC);
        tokens[1] = address(0x322F0929c4625eD5bAd873c95208D54E1c003b2d);
        tokens[2] = address(0x117cc2133c37B721F49dE2A7a74833232B3B4C0C);

        // Spread across the covered window, at an odd stride so the probes do not
        // all land at the same time of day and answer the same thing.
        for (uint256 k = 0; k < PROBES; ++k) {
            uint64 at = origin + uint64(k) * 19_777;
            probeAt[k] = at;
            probeAnswer[k] = uint8(sessions.sessionAt(at));
        }
    }

    function actSetProtective(uint256 seed) public {
        try sessions.setProtective(tokens[seed % 3], "feed silent") {
            protectiveSets += 1;
        } catch {}
        _checkInvariants();
    }

    function actReportHealthy(uint256 seed) public {
        try sessions.reportHealthy(tokens[seed % 3]) {
            protectiveClears += 1;
        } catch {}
        _checkInvariants();
    }

    /// @notice The protective flag is the one runtime input the engine has, so it
    /// has to stay shut to everyone who is not the governor.
    function actStrangerTries(uint256 seed) public {
        address token = tokens[seed % 3];
        try stranger.setProtective(sessions, token) {
            strangerGotIn += 1;
        } catch {}
        try stranger.reportHealthy(sessions, token) {
            strangerGotIn += 1;
        } catch {}
        _checkInvariants();
    }

    /// @notice Reading the engine is not writing to it. Echidna moves the clock
    /// between transactions, so this asks the same questions from a different
    /// second every time it is called.
    function actRead(uint256 seed) public {
        sessions.sessionAt(uint64(block.timestamp));
        sessions.tokenSession(tokens[seed % 3]);
        sessions.currentSession();
        sessions.inGuardBand(uint64(block.timestamp));
        _checkInvariants();
    }

    function _checkInvariants() internal {
        for (uint256 k = 0; k < PROBES; ++k) {
            if (uint8(sessions.sessionAt(probeAt[k])) != probeAnswer[k]) answerChanged += 1;
        }
        // I12.
        assert(answerChanged == 0);
        assert(strangerGotIn == 0);
    }
}
