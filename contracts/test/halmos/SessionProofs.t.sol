// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SessionManager} from "../../src/SessionManager.sol";
import {CivilDate} from "../../src/libraries/CivilDate.sol";
import {Session} from "../../src/types/Types.sol";

/// @notice The session row of rencana-uji.md section 4, proved as far as it can
/// honestly be proved and no further.
///
/// Read what is here and what is not. sessionAt reads two storage tables, the
/// daylight boundaries and the calendar, and a symbolic run over those would be
/// proving a statement about an arbitrary calendar rather than about ours. What is
/// proved here instead is everything downstream of the answer, which is that every
/// session the type can hold has a batch duration and a band, that the two never
/// disagree about which sessions run a batch, and that the day arithmetic the
/// lookup is built on round trips over its whole domain.
///
/// The table itself is covered exhaustively rather than symbolically, by
/// CivilDate.t.sol walking all 5,844 committed days in both directions. Exhaustive
/// over the real table beats symbolic over an invented one, and saying which is
/// which is the point.
///
/// A testFuzz name here is run symbolically by tools/halmos.sh and is a proof over
/// the whole stated range. A testBound name is run by forge as a bounded fuzz test
/// and is not. One function below carries the second name and says why.
contract SessionProofs is Test {
    uint8 internal constant SESSION_COUNT = 9;

    SessionManager internal sessions;

    function setUp() public {
        sessions = new SessionManager(address(this));
    }

    /// Every session the enum can hold answers both questions. A session that fell
    /// through would return zero from both, and a zero band would refuse every
    /// price while a zero duration refuses every batch, so the failure would read
    /// as a dead token rather than as a missing case.
    function testFuzz_everySessionHasABandAndKnowsIfItBatches(uint8 raw) public view {
        vm.assume(raw < SESSION_COUNT);
        Session s = Session(raw);

        assertGt(sessions.maxDeviationBps(s), 0, "a session had no band at all");

        bool isAuction = s == Session.AUCTION_OPEN || s == Session.AUCTION_CLOSE;
        assertEq(
            sessions.batchDuration(s) == 0, isAuction, "a session ran no batch without being an auction phase"
        );
    }

    /// No band is ever wider than the auction collar. The collar is the widest
    /// number in parameter.md section 2, and a session quietly wider than it would
    /// let a batch clear further from the oracle than the auction is allowed to.
    function testFuzz_noBandIsWiderThanTheAuctionCollar(uint8 raw) public view {
        vm.assume(raw < SESSION_COUNT);

        assertLe(
            sessions.maxDeviationBps(Session(raw)),
            sessions.maxDeviationBps(Session.AUCTION_OPEN),
            "a session was given a wider band than the auction collar"
        );
    }

    /// PROTECTIVE is the narrowest band and the slowest batch at once. The two move
    /// in opposite directions on purpose, so a session that widened the band while
    /// keeping the batch short would raise the worst case loss exactly when the
    /// price is least certain.
    function testFuzz_protectiveIsTheNarrowestBandAndTheSlowestBatch(uint8 raw) public view {
        vm.assume(raw < SESSION_COUNT);
        Session s = Session(raw);

        assertLe(
            sessions.maxDeviationBps(Session.PROTECTIVE),
            sessions.maxDeviationBps(s),
            "protective was not the narrowest band"
        );
        if (sessions.batchDuration(s) > 0) {
            assertGe(
                sessions.batchDuration(Session.PROTECTIVE),
                sessions.batchDuration(s),
                "protective was not the slowest batch"
            );
        }
    }

    /// The day arithmetic round trips. Every day index the protocol can hold
    /// converts to a date and back to itself, which is what lets a closing print be
    /// addressed as getRoundData(20260910) and still land on the day the session
    /// table meant.
    ///
    /// A testBound name, because this one does not close. Both directions together
    /// are 402 paths of division by constants, and halmos 0.3.3 timed out past 611
    /// seconds on 19 September 2026 with no counterexample. The loss is small.
    /// CivilDate.t.sol already walks all 5,844 committed days in both directions
    /// exhaustively, and those are the only days the protocol is ever asked about.
    /// What the symbolic run would add is the stretch out to 2199.
    function testBound_theDayIndexRoundTripsThroughTheCalendarDate(uint32 dayIndex) public pure {
        // 1 March 1970 forward. The Hinnant algorithm shifts to a March based year,
        // and parameter.md section 3.1 addresses prints from 2020 on, so nothing
        // below this is a date this protocol can be asked about.
        vm.assume(dayIndex >= 59);
        // 31 December 2199. Past this the encoding runs out of a uint32, which is a
        // property of the YYYYMMDD format rather than of the arithmetic.
        vm.assume(dayIndex <= 84_006);

        assertEq(
            CivilDate.toDayIndex(CivilDate.toYmd(dayIndex)),
            dayIndex,
            "a day index did not survive the round trip"
        );
    }

    /// The month it produces is always a month. A zero or a thirteen would encode
    /// and decode through the arithmetic without complaint, and it is the month
    /// that makes getRoundData(20260910) addressable at all, so the shape is
    /// asserted rather than assumed.
    ///
    /// The three bounds are split across three functions on purpose. Together they
    /// are one query the solver closes in about 390 seconds on a good run and times
    /// out on a bad one, and a gate that flips is a gate people learn to ignore.
    function testFuzz_everyDayIndexNamesARealMonth(uint32 dayIndex) public pure {
        uint32 month = (_ymd(dayIndex) / 100) % 100;

        assertGe(month, 1, "a month below one");
        assertLe(month, 12, "a month past twelve");
    }

    function testFuzz_everyDayIndexNamesARealDayOfMonth(uint32 dayIndex) public pure {
        uint32 day = _ymd(dayIndex) % 100;

        assertGe(day, 1, "a day below one");
        assertLe(day, 31, "a day past thirty one");
    }

    function testFuzz_noDayIndexPredatesTheEpoch(uint32 dayIndex) public pure {
        assertGe(_ymd(dayIndex) / 10_000, 1970, "a year before the epoch");
    }

    /// 1 March 1970 forward, because the Hinnant algorithm shifts to a March based
    /// year and parameter.md section 3.1 addresses prints from 2020 on. Up to
    /// 31 December 2199, past which the YYYYMMDD encoding runs out of a uint32,
    /// which is a property of the format rather than of the arithmetic.
    function _ymd(uint32 dayIndex) internal pure returns (uint32) {
        vm.assume(dayIndex >= 59);
        vm.assume(dayIndex <= 84_006);
        return CivilDate.toYmd(dayIndex);
    }
}
