// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SessionManager} from "../../src/SessionManager.sol";

/// @notice Moves everything around the session engine that can be moved at
/// runtime. The clock, the per token protective flag, and the healthy reports
/// that clear it. None of it may reach sessionAt, which is the claim the engine
/// is built on and the reason Halmos can reason about it at all.
contract SessionHandler is Test {
    SessionManager public immutable sessions;
    address public immutable governor;

    address[3] public tokens;

    uint256 public protectiveSets;
    uint256 public protectiveClears;

    constructor(SessionManager sessions_, address governor_) {
        sessions = sessions_;
        governor = governor_;
        tokens[0] = address(0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC);
        tokens[1] = address(0x322F0929c4625eD5bAd873c95208D54E1c003b2d);
        tokens[2] = address(0x117cc2133c37B721F49dE2A7a74833232B3B4C0C);
    }

    function actWarpTime(uint256 seed) external {
        uint64 now_ = uint64(vm.getBlockTimestamp());
        if (seed & 1 == 0) {
            uint64 next = sessions.nextTransition(now_);
            if (next > now_) {
                uint64 band = uint64(bound(seed >> 8, 0, 2 * sessions.GUARD_BAND()));
                uint64 floorAt = sessions.GUARD_BAND();
                uint64 target = next + band > floorAt ? next + band - floorAt : next;
                if (target > now_) {
                    vm.warp(target);
                    return;
                }
            }
        }
        vm.warp(now_ + bound(seed, 1, 30 days));
    }

    function actSetProtective(uint256 seed) external {
        address token = tokens[bound(seed, 0, 2)];
        vm.prank(governor);
        try sessions.setProtective(token, "feed silent") {
            protectiveSets += 1;
        } catch {}
    }

    function actReportHealthy(uint256 seed) external {
        address token = tokens[bound(seed, 0, 2)];
        vm.prank(governor);
        try sessions.reportHealthy(token) {
            protectiveClears += 1;
        } catch {}
    }

    /// @notice A caller that is not the governor, because the protective flag is
    /// the one runtime input the engine has and it must stay shut to everyone else.
    function actSetProtectiveAsStranger(uint256 seed) external {
        address token = tokens[bound(seed, 0, 2)];
        vm.prank(address(uint160(bound(seed >> 8, 1, type(uint160).max))));
        try sessions.setProtective(token, "not yours") {
            protectiveSets += 1;
        } catch {}
    }

    function tokenAt(uint256 index) external view returns (address) {
        return tokens[index];
    }
}
