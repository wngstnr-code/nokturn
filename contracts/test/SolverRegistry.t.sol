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
    address auctionHouse = address(0xA0C7);
    address solver = address(0x501E);

    function setUp() public {
        usdg = new MockERC20("Global Dollar", "USDG", 6);
        registry = new SolverRegistry(IERC20(address(usdg)), treasury, governor);
        vm.startPrank(governor);
        registry.setSettlement(settlement);
        registry.setAuctionHouse(auctionHouse);
        vm.stopPrank();

        usdg.mint(solver, 100_000e6);
        vm.prank(solver);
        usdg.approve(address(registry), type(uint256).max);
    }

    function test_theEntryPriceStartsAtTheFloorAndOnlyTheGovernorMovesIt() public {
        assertEq(registry.minBond(), registry.MIN_BOND_FLOOR(), "launch value is the floor");

        vm.expectRevert(SolverRegistry.NotGovernor.selector);
        registry.setMinBond(1000e6);

        vm.prank(governor);
        registry.setMinBond(1000e6);
        assertEq(registry.minBond(), 1000e6);
    }

    /// A zero minimum would read every address that never bonded as active, so the
    /// floor is a gate rather than a preference. parameter.md 5A.
    function test_A17_governanceSetsTheEntryPriceToZero() public {
        uint256 floor_ = registry.MIN_BOND_FLOOR();
        uint256 ceiling = registry.MIN_BOND_CEILING();

        vm.startPrank(governor);
        vm.expectRevert(abi.encodeWithSelector(SolverRegistry.MinBondOutOfRange.selector, 0));
        registry.setMinBond(0);

        vm.expectRevert(abi.encodeWithSelector(SolverRegistry.MinBondOutOfRange.selector, floor_ - 1));
        registry.setMinBond(floor_ - 1);

        vm.expectRevert(abi.encodeWithSelector(SolverRegistry.MinBondOutOfRange.selector, ceiling + 1));
        registry.setMinBond(ceiling + 1);

        registry.setMinBond(ceiling);
        assertEq(registry.minBond(), ceiling, "the ceiling itself is allowed");
        vm.stopPrank();
    }

    /// No grandfathering, the same way a tightened exposure cap applies to everyone
    /// at once. The timelock is what turns this into two days of warning.
    function test_raisingTheEntryPriceDeactivatesWhoeverIsNowBelowIt() public {
        uint256 entry = registry.minBond();
        vm.prank(solver);
        registry.bond(entry);
        assertTrue(registry.isActive(solver), "active at the old price");

        vm.prank(governor);
        registry.setMinBond(entry * 2);
        assertFalse(registry.isActive(solver), "the same bond no longer reaches");

        vm.prank(solver);
        registry.bond(entry);
        assertTrue(registry.isActive(solver), "topping up reaches the new price");
    }

    /// Lowering it must not resurrect a solver on its way out. The cooldown is the
    /// only thing keeping slashing reachable after the behaviour is noticed.
    function test_loweringTheEntryPriceDoesNotUndoAPendingExit() public {
        uint256 entry = registry.minBond();
        vm.startPrank(solver);
        registry.bond(entry * 4);
        registry.requestUnbond();
        vm.stopPrank();
        assertFalse(registry.isActive(solver));

        vm.prank(governor);
        registry.setMinBond(entry);
        assertFalse(registry.isActive(solver), "leaving still means leaving");
    }

    function test_bondingIsPermissionlessAndGatesOnTheMinimum() public {
        uint256 entry = registry.minBond();
        vm.startPrank(solver);
        registry.bond(entry - 1);
        assertFalse(registry.isActive(solver), "below the minimum is not active");

        registry.bond(1);
        assertTrue(registry.isActive(solver), "the minimum itself is the entry price");
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
        // Ten percent above the entry price, so one failed finalize at ten percent
        // of the bond drops it under. Written against minBond rather than against a
        // literal, because the entry price is governed now.
        uint256 thin = (registry.minBond() * 102) / 100;
        vm.prank(solver);
        registry.bond(thin);
        assertTrue(registry.isActive(solver));

        vm.prank(settlement);
        registry.reportFailedFinalize(solver);
        assertFalse(registry.isActive(solver), "a thin bond is no bond");
    }

    function test_onlySettlementReportsFacts() public {
        vm.prank(solver);
        registry.bond(10_000e6);

        vm.expectRevert(SolverRegistry.NotAResultReporter.selector);
        registry.recordWin(solver, 1e18);

        vm.expectRevert(SolverRegistry.NotSettlement.selector);
        registry.reportFailedFinalize(solver);

        vm.expectRevert(SolverRegistry.NotSettlement.selector);
        registry.reportInvalidSurplus(solver);
    }

    /// The auction house reports the crosses it executed and nothing else. It is a
    /// second reporter rather than a second settlement, because the calls that move
    /// a bond stay with the one contract that holds them.
    function test_theAuctionHouseScoresItsCrossesButCannotSlash() public {
        vm.prank(solver);
        registry.bond(10_000e6);

        vm.prank(auctionHouse);
        registry.recordWin(solver, 500e18);

        (uint256 won, uint256 savings,,) = registry.stats(solver);
        assertEq(won, 1, "the cross counted");
        assertEq(savings, 500e18, "and carried its volume");

        vm.prank(auctionHouse);
        vm.expectRevert(SolverRegistry.NotSettlement.selector);
        registry.reportFailedFinalize(solver);

        vm.prank(auctionHouse);
        vm.expectRevert(SolverRegistry.NotSettlement.selector);
        registry.reportInvalidSurplus(solver);

        (,, uint256 failed, uint256 slashes) = registry.stats(solver);
        assertEq(failed, 0, "no failure was recorded against it");
        assertEq(slashes, 0, "and nothing was taken");
    }

    function test_theAuctionHouseAddressIsSetOnceAndOnlyByGovernor() public {
        SolverRegistry fresh = new SolverRegistry(IERC20(address(usdg)), treasury, governor);

        vm.expectRevert(SolverRegistry.NotGovernor.selector);
        fresh.setAuctionHouse(auctionHouse);

        vm.startPrank(governor);
        fresh.setAuctionHouse(auctionHouse);
        vm.expectRevert(SolverRegistry.AuctionHouseAlreadySet.selector);
        fresh.setAuctionHouse(address(0xDEAD));
        vm.stopPrank();
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
