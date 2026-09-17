// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

/// @title Day index to calendar date
/// @notice The protocol counts days as days since 1 January 1970, because that is
/// what the session tables use. The closing print has to be addressed the way a
/// human reads a date instead, since parameter.md section 3.1 fixes the Chainlink
/// round id at YYYYMMDD so that getRoundData(20260910) answers on its own.
///
/// Both directions are the civil calendar algorithm published by Howard Hinnant,
/// shifted to a March based year so that the leap day lands at the end.
library CivilDate {
    error DateOutOfRange(uint32 ymd);

    function toYmd(uint32 dayIndex) internal pure returns (uint32) {
        uint256 z = uint256(dayIndex) + 719_468;
        uint256 era = z / 146_097;
        uint256 doe = z % 146_097;
        uint256 yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        uint256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        uint256 mp = (5 * doy + 2) / 153;
        uint256 day = doy - (153 * mp + 2) / 5 + 1;
        uint256 month = mp < 10 ? mp + 3 : mp - 9;
        uint256 year = era * 400 + yoe + (month <= 2 ? 1 : 0);
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint32(year * 10_000 + month * 100 + day);
    }

    function toDayIndex(uint32 ymd) internal pure returns (uint32) {
        uint256 year = ymd / 10_000;
        uint256 month = (ymd / 100) % 100;
        uint256 day = ymd % 100;
        if (year < 1970 || month == 0 || month > 12 || day == 0 || day > 31) revert DateOutOfRange(ymd);

        uint256 y = month <= 2 ? year - 1 : year;
        uint256 era = y / 400;
        uint256 yoe = y - era * 400;
        uint256 mp = month > 2 ? month - 3 : month + 9;
        uint256 doy = (153 * mp + 2) / 5 + day - 1;
        uint256 doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        // forge-lint: disable-next-line(unsafe-typecast)
        uint32 index = uint32(era * 146_097 + doe - 719_468);
        // A date that does not exist, 31 February for instance, encodes to the day
        // that follows the real end of the month, so the round trip catches it.
        if (toYmd(index) != ymd) revert DateOutOfRange(ymd);
        return index;
    }
}
