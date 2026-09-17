// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Session} from "../types/Types.sol";

interface ISessionManager {
    event SessionChanged(uint8 indexed from, uint8 indexed to, uint64 timestamp);
    event TokenProtective(address indexed token, bytes32 reason);
    event TokenProtectiveCleared(address indexed token, uint8 healthyUpdates);
    event CalendarUpdated(uint32 indexed date, uint8 kind, uint32 closeTime);
    event DstTableUpdated(uint64[] boundaries);

    /// @notice Pure against the calendar and DST tables. No runtime owner input,
    /// which is what lets Halmos prove it and anyone reproduce it offchain.
    function sessionAt(uint64 timestamp) external view returns (Session);

    function currentSession() external view returns (Session);
    function batchDuration(Session s) external view returns (uint32);
    function maxDeviationBps(Session s) external view returns (uint16);
    function inGuardBand(uint64 timestamp) external view returns (bool);

    /// @notice PROTECTIVE is per token and overrides the time based state.
    function tokenSession(address token) external view returns (Session);

    function nextTransition(uint64 from) external view returns (uint64);

    /// @notice The New York calendar day a timestamp falls on, as YYYYMMDD. Daily
    /// budgets reset on this rather than on UTC midnight, which lands in the
    /// middle of the post market session and would hand out two budgets in one
    /// American evening.
    function easternDay(uint64 timestamp) external view returns (uint32 ymd);
}
