// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {ISessionManager} from "./interfaces/ISessionManager.sol";
import {Session} from "./types/Types.sol";

/// @title Market session state machine
/// @notice sessionAt is a pure function of two tables, with no runtime owner input,
/// which is what lets anyone reproduce it offchain and lets Halmos prove it.
/// Tables are explicit rather than derived. A reviewer can compare 32 DST numbers
/// against a public calendar in five minutes. Nobody can audit a DST rule that fast.
/// See desain-session-engine.md section 5 and section 6.
contract SessionManager is ISessionManager {
    struct CalendarEntry {
        uint8 kind; // 0 none, 1 holiday, 2 early close
        uint32 closeTime; // seconds from ET midnight, only read when kind is 2
    }

    uint32 internal constant SECONDS_PER_DAY = 86_400;
    uint32 internal constant PRE_MARKET_START = 14_400; // 04:00 ET
    uint32 internal constant AUCTION_OPEN_START = 32_400; // 09:00 ET
    uint32 internal constant OPEN_START = 34_200; // 09:30 ET
    uint32 internal constant REGULAR_CLOSE = 57_600; // 16:00 ET
    uint32 internal constant POST_MARKET_END = 72_000; // 20:00 ET
    uint32 internal constant AUCTION_WINDOW = 1800; // parameter.md 3, DISCLOSURE_WINDOW

    uint32 internal constant EST_OFFSET = 18_000; // UTC-5
    uint32 internal constant EDT_OFFSET = 14_400; // UTC-4

    uint32 public constant GUARD_BAND = 60;

    uint8 internal constant KIND_HOLIDAY = 1;
    uint8 internal constant KIND_EARLY_CLOSE = 2;

    uint8 internal constant HEALTHY_UPDATES_TO_EXIT = 3;

    /// Enough to cross a three day weekend plus a holiday, boundary by boundary.
    uint256 internal constant MAX_TRANSITION_STEPS = 64;

    address public immutable governor;

    uint64[] public dstBoundaries;
    mapping(uint32 => CalendarEntry) public calendar;

    mapping(address => bool) public protective;
    mapping(address => uint8) internal healthyStreak;

    error NotGovernor();
    error BoundariesNotAscending(uint256 index);
    error CalendarKindInvalid(uint8 kind);
    error CloseTimeOutOfRange(uint32 closeTime);
    error TokenNotProtective(address token);

    constructor(address governor_) {
        governor = governor_;
    }

    modifier onlyGovernor() {
        if (msg.sender != governor) revert NotGovernor();
        _;
    }

    /// @notice Replaces the whole DST table. Boundaries alternate, starting with a
    /// shift into EDT, so the parity of the search result decides the offset.
    function setDstBoundaries(uint64[] calldata boundaries) external onlyGovernor {
        for (uint256 i = 1; i < boundaries.length; ++i) {
            if (boundaries[i] <= boundaries[i - 1]) revert BoundariesNotAscending(i);
        }
        dstBoundaries = boundaries;
        emit DstTableUpdated(boundaries);
    }

    function setCalendarEntries(uint32[] calldata dates, uint8[] calldata kinds, uint32[] calldata closeTimes)
        external
        onlyGovernor
    {
        for (uint256 i = 0; i < dates.length; ++i) {
            uint8 kind = kinds[i];
            if (kind > KIND_EARLY_CLOSE) revert CalendarKindInvalid(kind);
            if (kind == KIND_EARLY_CLOSE && (closeTimes[i] <= OPEN_START || closeTimes[i] > REGULAR_CLOSE)) {
                revert CloseTimeOutOfRange(closeTimes[i]);
            }
            calendar[dates[i]] = CalendarEntry({kind: kind, closeTime: closeTimes[i]});
            emit CalendarUpdated(dates[i], kind, closeTimes[i]);
        }
    }

    function setProtective(address token, bytes32 reason) external onlyGovernor {
        protective[token] = true;
        healthyStreak[token] = 0;
        emit TokenProtective(token, reason);
    }

    /// @notice Leaving PROTECTIVE takes three consecutive healthy observations, so a
    /// flapping feed cannot oscillate the market in and out of protection.
    function reportHealthy(address token) external onlyGovernor {
        if (!protective[token]) revert TokenNotProtective(token);
        uint8 streak = healthyStreak[token] + 1;
        if (streak >= HEALTHY_UPDATES_TO_EXIT) {
            protective[token] = false;
            healthyStreak[token] = 0;
            emit TokenProtectiveCleared(token, HEALTHY_UPDATES_TO_EXIT);
        } else {
            healthyStreak[token] = streak;
        }
    }

    function sessionAt(uint64 timestamp) public view returns (Session) {
        if (!_covered(timestamp)) return Session.PROTECTIVE;

        (uint32 day, uint32 secondOfDay) = _easternDay(timestamp);

        uint8 dow = _dayOfWeek(day);
        if (dow == 0 || dow == 6) return Session.CLOSED_WEEKEND;

        CalendarEntry memory entry = calendar[day];
        if (entry.kind == KIND_HOLIDAY) return Session.HOLIDAY;

        uint32 close = entry.kind == KIND_EARLY_CLOSE ? entry.closeTime : REGULAR_CLOSE;

        if (secondOfDay < PRE_MARKET_START) return Session.CLOSED_OVERNIGHT;
        if (secondOfDay < AUCTION_OPEN_START) return Session.PRE_MARKET;
        if (secondOfDay < OPEN_START) return Session.AUCTION_OPEN;
        if (secondOfDay < close - AUCTION_WINDOW) return Session.OPEN;
        if (secondOfDay < close) return Session.AUCTION_CLOSE;
        if (secondOfDay < POST_MARKET_END) return Session.POST_MARKET;
        return Session.CLOSED_OVERNIGHT;
    }

    function currentSession() external view returns (Session) {
        return sessionAt(uint64(block.timestamp));
    }

    function tokenSession(address token) external view returns (Session) {
        if (protective[token]) return Session.PROTECTIVE;
        return sessionAt(uint64(block.timestamp));
    }

    function batchDuration(Session s) public pure returns (uint32) {
        if (s == Session.OPEN) return 10;
        if (s == Session.PRE_MARKET || s == Session.POST_MARKET) return 30;
        if (s == Session.CLOSED_OVERNIGHT) return 45;
        if (s == Session.CLOSED_WEEKEND) return 60;
        if (s == Session.HOLIDAY) return 120;
        if (s == Session.PROTECTIVE) return 180;
        return 0; // auction phases run no ordinary batch
    }

    function maxDeviationBps(Session s) public pure returns (uint16) {
        if (s == Session.OPEN) return 30;
        if (s == Session.PRE_MARKET || s == Session.POST_MARKET) return 60;
        if (s == Session.CLOSED_OVERNIGHT) return 100;
        if (s == Session.CLOSED_WEEKEND || s == Session.HOLIDAY) return 150;
        if (s == Session.PROTECTIVE) return 20;
        return 200; // auction collar, parameter.md 3
    }

    /// @notice True within GUARD_BAND seconds either side of a session boundary.
    /// Callers take the more conservative of the two sessions while this holds,
    /// because the Orbit sequencer sets block.timestamp and it can drift.
    function inGuardBand(uint64 timestamp) public view returns (bool) {
        Session before = sessionAt(timestamp - GUARD_BAND);
        Session current = sessionAt(timestamp);
        Session later = sessionAt(timestamp + GUARD_BAND);
        return before != current || later != current;
    }

    /// @notice First second after `from` whose session differs from the session at
    /// `from`. Walks the real boundaries instead of bisecting, because sessions are
    /// not monotonic. Friday evening and Saturday evening are both closed, so a
    /// bisection would happily report no transition across the whole weekend.
    function nextTransition(uint64 from) external view returns (uint64) {
        Session start = sessionAt(from);
        uint64 t = from;
        for (uint256 step = 0; step < MAX_TRANSITION_STEPS; ++step) {
            uint64 candidate = _nextBoundary(t);
            if (candidate == 0) return 0;
            if (sessionAt(candidate) != start) return candidate;
            t = candidate;
        }
        return 0;
    }

    /// @dev Next instant at which the session could change: an intraday boundary,
    /// the start of the next Eastern day, or a DST shift, whichever comes first.
    function _nextBoundary(uint64 timestamp) internal view returns (uint64) {
        if (!_covered(timestamp)) return 0;

        (uint32 day, uint32 secondOfDay) = _easternDay(timestamp);
        uint32 offset = _utcOffset(timestamp);

        CalendarEntry memory entry = calendar[day];
        uint32 close = entry.kind == KIND_EARLY_CLOSE ? entry.closeTime : REGULAR_CLOSE;

        uint32[6] memory marks = [
            PRE_MARKET_START, AUCTION_OPEN_START, OPEN_START, close - AUCTION_WINDOW, close, POST_MARKET_END
        ];

        uint64 dayStartUtc = uint64(day) * SECONDS_PER_DAY + offset;
        uint64 next = dayStartUtc + SECONDS_PER_DAY;
        for (uint256 i = 0; i < marks.length; ++i) {
            if (marks[i] > secondOfDay) {
                next = dayStartUtc + marks[i];
                break;
            }
        }

        uint64 dst = _nextDstBoundary(timestamp);
        return (dst != 0 && dst < next) ? dst : next;
    }

    function _nextDstBoundary(uint64 timestamp) internal view returns (uint64) {
        uint256 index = _boundariesBefore(timestamp);
        return index < dstBoundaries.length ? dstBoundaries[index] : 0;
    }

    /// @notice Whether the DST table still covers this timestamp on both sides.
    /// Outside it the Eastern offset is a guess, and guessing the offset moves the
    /// open by a full hour. Section 2.2 of desain-session-engine.md says fail safe,
    /// so sessionAt answers PROTECTIVE rather than inventing a session.
    function _covered(uint64 timestamp) internal view returns (bool) {
        uint256 n = dstBoundaries.length;
        if (n == 0) return false;
        return timestamp >= dstBoundaries[0] && timestamp < dstBoundaries[n - 1];
    }

    function coveredUntil() external view returns (uint64) {
        uint256 n = dstBoundaries.length;
        return n == 0 ? 0 : dstBoundaries[n - 1];
    }

    function _easternDay(uint64 timestamp) internal view returns (uint32 day, uint32 secondOfDay) {
        // _covered has already bounded timestamp by the last table entry, which is
        // far below uint32 seconds, so neither cast can truncate.
        uint64 local = timestamp - _utcOffset(timestamp);
        // forge-lint: disable-next-line(unsafe-typecast)
        day = uint32(local / SECONDS_PER_DAY);
        // forge-lint: disable-next-line(unsafe-typecast)
        secondOfDay = uint32(local % SECONDS_PER_DAY);
    }

    function _utcOffset(uint64 timestamp) internal view returns (uint32) {
        uint256 crossed = _boundariesBefore(timestamp);
        return crossed % 2 == 1 ? EDT_OFFSET : EST_OFFSET;
    }

    function _boundariesBefore(uint64 timestamp) internal view returns (uint256) {
        uint256 lo = 0;
        uint256 hi = dstBoundaries.length;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (dstBoundaries[mid] <= timestamp) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    /// @dev Day 0 is 1 January 1970, a Thursday. 0 is Sunday, 6 is Saturday.
    function _dayOfWeek(uint32 day) internal pure returns (uint8) {
        return uint8((day + 4) % 7);
    }
}
