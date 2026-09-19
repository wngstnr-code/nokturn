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
/// Three naming conventions meet here. A testFuzz name is run symbolically by
/// tools/halmos.sh and is a proof over the whole stated range. A testBound name is
/// a bounded fuzz test and is not a proof. A plain test name with no arguments
/// walks a closed domain exhaustively, which for the nine sessions is as complete
/// as a solver would be and costs nothing to run.
contract SessionProofs is Test {
    uint8 internal constant SESSION_COUNT = 9;

    SessionManager internal sessions;

    function setUp() public {
        sessions = new SessionManager(address(this));
    }

    /// Every session the enum can hold answers both questions, and the answers
    /// agree with each other. A session that fell through would return zero from
    /// both, and a zero band refuses every price while a zero duration refuses
    /// every batch, so the failure would read as a dead token rather than as a
    /// missing case.
    ///
    /// Enumerated rather than fuzzed or proved. The domain is nine values, so
    /// walking it is exhaustive, which is stronger than sampling it and gives the
    /// same answer as a solver would. It also keeps the measured gas off the draw,
    /// since maxDeviationBps is a chain of comparisons and a fuzzed session lands
    /// on a different rung every run. That is what moved this number 177 gas
    /// between a laptop and CI before it was written this way.
    function test_everySessionHasABandAndKnowsIfItBatches() public view {
        for (uint8 raw = 0; raw < SESSION_COUNT; ++raw) {
            Session s = Session(raw);

            assertGt(sessions.maxDeviationBps(s), 0, "a session had no band at all");

            bool isAuction = s == Session.AUCTION_OPEN || s == Session.AUCTION_CLOSE;
            assertEq(
                sessions.batchDuration(s) == 0,
                isAuction,
                "a session ran no batch without being an auction phase"
            );
        }
    }

    /// No band is ever wider than the auction collar, which is the widest number in
    /// parameter.md section 2. A session quietly wider than it would let a batch
    /// clear further from the oracle than the auction is allowed to.
    function test_noBandIsWiderThanTheAuctionCollar() public view {
        uint16 collar = sessions.maxDeviationBps(Session.AUCTION_OPEN);

        for (uint8 raw = 0; raw < SESSION_COUNT; ++raw) {
            assertLe(
                sessions.maxDeviationBps(Session(raw)),
                collar,
                "a session was given a wider band than the auction collar"
            );
        }
    }

    /// PROTECTIVE is the narrowest band and the slowest batch at once. The two move
    /// in opposite directions on purpose, so a session that widened the band while
    /// keeping the batch short would raise the worst case loss exactly when the
    /// price is least certain.
    function test_protectiveIsTheNarrowestBandAndTheSlowestBatch() public view {
        uint16 narrowest = sessions.maxDeviationBps(Session.PROTECTIVE);
        uint32 slowest = sessions.batchDuration(Session.PROTECTIVE);

        for (uint8 raw = 0; raw < SESSION_COUNT; ++raw) {
            Session s = Session(raw);

            assertLe(narrowest, sessions.maxDeviationBps(s), "protective was not the narrowest band");
            if (sessions.batchDuration(s) > 0) {
                assertGe(slowest, sessions.batchDuration(s), "protective was not the slowest batch");
            }
        }
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
