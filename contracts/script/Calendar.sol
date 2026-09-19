// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {SessionManager} from "../src/SessionManager.sol";

/// @notice Loads the committed NYSE calendar into a SessionManager.
/// Lives beside the deploy rather than under test, because the deploy is what puts
/// this table on chain and the tests are what check it. Production importing from
/// a test directory is the wrong way round.
/// Everything comes from nyse-sessions.csv, which holds one row per calendar day
/// from 2020-01-01 to 2035-12-31. Deriving the holiday and early close table from
/// the same file the exhaustive test walks means the two can never disagree.
library CalendarFixture {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    string internal constant DST_PATH = "../data/nyse-calendar/dst-boundaries.csv";
    string internal constant SESSIONS_PATH = "../data/nyse-calendar/nyse-sessions.csv";

    /// 2020-01-01, the first row of the sessions file.
    uint32 internal constant FIRST_DAY_INDEX = 18_262;

    uint8 internal constant KIND_NORMAL = 0;
    uint8 internal constant KIND_HOLIDAY = 1;
    uint8 internal constant KIND_EARLY_CLOSE = 2;

    struct Day {
        uint32 dayIndex;
        uint8 kind;
        uint32 closeTimeEt;
        uint64 openUtc;
        uint64 closeUtc;
    }

    function loadDst() internal view returns (uint64[] memory boundaries) {
        string[] memory lines = _lines(vm.readFile(DST_PATH));
        boundaries = new uint64[](lines.length);
        uint256 n = 0;
        for (uint256 i = 1; i < lines.length; ++i) {
            string[] memory cols = vm.split(lines[i], ",");
            if (cols.length < 4) continue;
            boundaries[n++] = uint64(vm.parseUint(cols[3]));
        }
        assembly {
            mstore(boundaries, n)
        }
    }

    function loadDays() internal view returns (Day[] memory out) {
        string[] memory lines = _lines(vm.readFile(SESSIONS_PATH));
        out = new Day[](lines.length);
        uint32 n = 0;
        for (uint256 i = 1; i < lines.length; ++i) {
            string[] memory cols = vm.split(lines[i], ",");
            if (cols.length < 8) continue;

            Day memory d;
            d.dayIndex = FIRST_DAY_INDEX + n;

            bytes32 kind = keccak256(bytes(cols[2]));
            if (kind == keccak256("holiday")) d.kind = KIND_HOLIDAY;
            else if (kind == keccak256("early_close")) d.kind = KIND_EARLY_CLOSE;
            else d.kind = KIND_NORMAL;

            if (bytes(cols[6]).length > 0) {
                d.openUtc = uint64(vm.parseUint(cols[6]));
                d.closeUtc = uint64(vm.parseUint(cols[7]));
                uint64 dayStartUtc = d.openUtc - 34_200;
                // Bounded by one day, the file holds no close past 20:00 ET.
                // forge-lint: disable-next-line(unsafe-typecast)
                d.closeTimeEt = uint32(d.closeUtc - dayStartUtc);
            }
            out[n++] = d;
        }
        assembly {
            mstore(out, n)
        }
    }

    /// @dev Entries past 2028 are rule derived and must never be loaded on mainnet.
    /// Tests load the whole table on purpose, to exercise every boundary to 2035.
    function loadCalendar(SessionManager manager, Day[] memory allDays) internal {
        uint32[] memory dates = new uint32[](allDays.length);
        uint8[] memory kinds = new uint8[](allDays.length);
        uint32[] memory closes = new uint32[](allDays.length);
        uint256 n = 0;
        for (uint256 i = 0; i < allDays.length; ++i) {
            if (allDays[i].kind == KIND_NORMAL) continue;
            dates[n] = allDays[i].dayIndex;
            kinds[n] = allDays[i].kind;
            closes[n] = allDays[i].kind == KIND_EARLY_CLOSE ? allDays[i].closeTimeEt : 0;
            ++n;
        }
        assembly {
            mstore(dates, n)
            mstore(kinds, n)
            mstore(closes, n)
        }
        manager.setCalendarEntries(dates, kinds, closes);
    }

    function _lines(string memory raw) private pure returns (string[] memory) {
        bytes memory b = bytes(raw);
        bytes memory out = new bytes(b.length);
        uint256 n = 0;
        for (uint256 i = 0; i < b.length; ++i) {
            if (b[i] != 0x0d) out[n++] = b[i];
        }
        assembly {
            mstore(out, n)
        }
        return vm.split(string(out), "\n");
    }
}
