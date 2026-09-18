// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";
import {SolverRegistry} from "../src/SolverRegistry.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract SolverRegistryTest is Test {
    SolverRegistry registry;
    MockERC20 usdg;

    address governor = address(0x60174E);
    address treasury = address(0x7EA);
    address settlement = address(0x5E77);
    address solver = address(0x501E);

    function setUp() public {
        usdg = new MockERC20("Global Dollar", "USDG", 6);
        registry = new SolverRegistry(IERC20(address(usdg)), treasury, governor);
        vm.prank(governor);
        registry.setSettlement(settlement);

        usdg.mint(solver, 100_000e6);
        vm.prank(solver);
        usdg.approve(address(registry), type(uint256).max);
    }

    function test_bondingIsPermissionlessAndGatesOnTheMinimum() public {
        vm.startPrank(solver);
        registry.bond(4999e6);
        assertFalse(registry.isActive(solver), "below the minimum is not active");

        registry.bond(1e6);
        assertTrue(registry.isActive(solver), "5000 USDG is the entry price");
        vm.stopPrank();
    }

    /// The cooldown exists so behaviour discovered after the fact is still
    /// reachable. A solver on the way out also stops winning batches immediately.
    function test_unbondingTakesSevenDaysAndDeactivatesAtOnce() public {
        vm.startPrank(solver);
        registry.bond(10_000e6);
        registry.requestUnbond();
        assertFalse(registry.isActive(solver), "leaving means leaving now");

        vm.expectRevert();
        registry.withdrawBond();

        vm.warp(block.timestamp + 7 days);
        registry.withdrawBond();
        vm.stopPrank();

        assertEq(usdg.balanceOf(solver), 100_000e6);
    }

    function test_toppingUpCancelsAPendingExit() public {
        vm.startPrank(solver);
        registry.bond(10_000e6);
        registry.requestUnbond();
        registry.bond(1e6);
        vm.stopPrank();

        assertTrue(registry.isActive(solver), "a solver cannot cool down and win at once");
        (, uint64 availableAt) = registry.bondOf(solver);
        assertEq(availableAt, 0);
    }

    function test_withdrawNeedsARequestFirst() public {
        vm.startPrank(solver);
        registry.bond(10_000e6);
        vm.expectRevert(abi.encodeWithSelector(SolverRegistry.UnbondNotRequested.selector, solver));
        registry.withdrawBond();
        vm.stopPrank();
    }

    /// Ten percent for griefing, twenty five for deceiving. The difference is the
    /// point: failing to finalize is costly, claiming a false surplus is worse.
    function test_slashSharesDifferByIntent() public {
        vm.prank(solver);
        registry.bond(10_000e6);

        vm.prank(settlement);
        registry.reportFailedFinalize(solver);
        (uint256 bonded,) = registry.bondOf(solver);
        assertEq(bonded, 9000e6, "ten percent");

        vm.prank(settlement);
        registry.reportInvalidSurplus(solver);
        (bonded,) = registry.bondOf(solver);
        assertEq(bonded, 6750e6, "twenty five percent of what is left");

        assertEq(usdg.balanceOf(treasury), 3250e6, "slashed bond goes to the protocol");

        (,, uint256 failedFinalizes, uint256 slashCount) = registry.stats(solver);
        assertEq(failedFinalizes, 1);
        assertEq(slashCount, 2);
    }

    function test_slashingDeactivatesASolverThatFallsBelowTheMinimum() public {
        vm.prank(solver);
        registry.bond(5100e6);
        assertTrue(registry.isActive(solver));

        vm.prank(settlement);
        registry.reportFailedFinalize(solver);
        assertFalse(registry.isActive(solver), "a thin bond is no bond");
    }

    function test_onlySettlementReportsFacts() public {
        vm.prank(solver);
        registry.bond(10_000e6);

        vm.expectRevert(SolverRegistry.NotSettlement.selector);
        registry.recordWin(solver, 1e18);

        vm.expectRevert(SolverRegistry.NotSettlement.selector);
        registry.reportFailedFinalize(solver);

        vm.expectRevert(SolverRegistry.NotSettlement.selector);
        registry.reportInvalidSurplus(solver);
    }

    /// The scoreboard comes from settlement facts. There is no path that lets a
    /// solver write its own score, which is what makes sybil identities pointless.
    function test_theScoreboardOnlyMovesOnRealSettlements() public {
        vm.prank(solver);
        registry.bond(10_000e6);

        vm.startPrank(settlement);
        registry.recordWin(solver, 250e18);
        registry.recordWin(solver, 100e18);
        vm.stopPrank();

        (uint256 won, uint256 savings,,) = registry.stats(solver);
        assertEq(won, 2);
        assertEq(savings, 350e18);
    }

    function test_governorCanSlashDirectlyButNobodyElseCan() public {
        vm.prank(solver);
        registry.bond(10_000e6);

        vm.expectRevert(SolverRegistry.NotGovernor.selector);
        registry.slash(solver, 1e6, "because");

        vm.prank(governor);
        registry.slash(solver, 1000e6, "manual");
        (uint256 bonded,) = registry.bondOf(solver);
        assertEq(bonded, 9000e6);

        vm.prank(governor);
        vm.expectRevert(abi.encodeWithSelector(SolverRegistry.SlashExceedsBond.selector, 100_000e6, 9000e6));
        registry.slash(solver, 100_000e6, "more than exists");
    }

    function test_settlementAddressIsSetOnceAndOnlyByGovernor() public {
        SolverRegistry fresh = new SolverRegistry(IERC20(address(usdg)), treasury, governor);

        vm.expectRevert(SolverRegistry.NotGovernor.selector);
        fresh.setSettlement(settlement);

        vm.startPrank(governor);
        fresh.setSettlement(settlement);
        vm.expectRevert(SolverRegistry.SettlementAlreadySet.selector);
        fresh.setSettlement(address(0xDEAD));
        vm.stopPrank();
    }

    function test_unbondingRequiresSomethingToUnbond() public {
        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(SolverRegistry.NothingBonded.selector, solver));
        registry.requestUnbond();
    }

    /// A slash may take the whole bond and no more. The bound is inclusive at the
    /// top, because the worst behaviour has to be answerable with everything the
    /// solver put up rather than with all but one unit of it.
    function test_aSlashMayTakeTheWholeBondAndNotOneUnitMore() public {
        vm.prank(solver);
        registry.bond(5000e6);

        vm.prank(governor);
        vm.expectRevert(abi.encodeWithSelector(SolverRegistry.SlashExceedsBond.selector, 5000e6 + 1, 5000e6));
        registry.slash(solver, 5000e6 + 1, "too much");

        vm.prank(governor);
        registry.slash(solver, 5000e6, "everything");
        assertEq(usdg.balanceOf(treasury), 5000e6, "the whole bond reached the treasury");
        assertFalse(registry.isActive(solver), "nothing left to stand on");
    }
}
