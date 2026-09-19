// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Execution} from "../src/types/Types.sol";
import {MonitorChecks} from "../script/MonitorChecks.sol";
import {AuctionFixture} from "./fixtures/AuctionFixture.sol";

/// The monitor is a reader, so what these prove is that it sees each of the five
/// state signals and that only the three that parameter.md section 8.3 lists as
/// pausing ever set the flag. Whether the invariants themselves hold is the
/// invariant suite's question, not this one.
contract MonitorTest is AuctionFixture {
    address settlementTarget = address(0x5E77);
    address timelockTarget = address(0x71E10C);

    function _targets() internal view returns (MonitorChecks.Targets memory t) {
        address[] memory tokens = new address[](1);
        tokens[0] = address(nvda);
        t = MonitorChecks.Targets({
            settlement: settlementTarget,
            auctionHouse: address(house),
            timelock: timelockTarget,
            oracle: address(oracle),
            quote: address(usdg),
            tokens: tokens
        });
    }

    function _findings() internal view returns (MonitorChecks.Finding[] memory) {
        return MonitorChecks.evaluate(_targets());
    }

    function test_aHealthyChainProducesNothingToReport() public {
        _fund(alice, ALICE_KEY);
        _fund(bob, BOB_KEY);
        _enterClosingAuction();
        _commitClose(alice, true, 1200e6, 1);
        _commitClose(bob, false, 6e18, 2);
        _closeAuctionFrozen();

        assertEq(_findings().length, 0, "a healthy chain gave the monitor something to say");
    }

    function test_aTokenLeftInTheSettlementCoreCallsForAPause() public {
        nvda.mint(settlementTarget, 1);

        MonitorChecks.Finding[] memory f = _findings();
        assertEq(f.length, 1);
        assertEq(f[0].code, "M1");
        assertEq(f[0].token, address(nvda));
        assertEq(f[0].observed, 1, "one wei of a stock token is still a leak");
        assertTrue(f[0].pause);
        assertTrue(MonitorChecks.pausesNeeded(f));
    }

    /// The quote asset is watched beside the stock tokens rather than instead of
    /// them, because the fee wedge is taken in whichever leg the batch withheld.
    function test_theQuoteAssetIsWatchedTooAndSoIsTheGovernor() public {
        usdg.mint(settlementTarget, 1);
        usdg.mint(timelockTarget, 1);

        MonitorChecks.Finding[] memory f = _findings();
        assertEq(f.length, 2);
        assertEq(f[0].code, "M1");
        assertEq(f[1].code, "M2");
        assertEq(f[1].subject, timelockTarget);
        assertTrue(MonitorChecks.pausesNeeded(f));
    }

    function test_escrowThatIsNoLongerThereCallsForAPause() public {
        _fund(alice, ALICE_KEY);
        _fund(bob, BOB_KEY);
        _enterClosingAuction();
        _commitClose(alice, true, 1200e6, 1);
        _commitClose(bob, false, 6e18, 2);
        _closeAuctionFrozen();

        assertEq(_findings().length, 0, "the escrow starts where it belongs");

        uint256 held = nvda.balanceOf(address(house));
        vm.prank(address(house));
        IERC20(address(nvda)).transfer(address(0xDEAD), 1);

        MonitorChecks.Finding[] memory f = _findings();
        assertEq(f.length, 1);
        assertEq(f[0].code, "M3");
        assertEq(f[0].token, address(nvda));
        assertEq(f[0].observed, held - 1);
        assertEq(f[0].expected, held);
        assertTrue(f[0].pause);
    }

    /// Escrow is only pulled at the freeze, so a book that has committed and not
    /// frozen owes nothing yet and the house holding nothing is correct.
    function test_aBookBeforeItsFreezeIsNotAnUnbackedEscrow() public {
        _fund(alice, ALICE_KEY);
        _enterClosingAuction();
        _commitClose(alice, true, 1200e6, 1);
        house.openAuction(address(nvda), kindClose);

        assertEq(usdg.balanceOf(address(house)), 0, "nothing is in custody before the freeze");
        assertEq(_findings().length, 0, "the monitor asked for money that was never pulled");
    }

    function test_anOracleDisagreementAlertsAndNeverPauses() public {
        adapter.setTwapRate(address(nvda), address(usdg), 200e18);
        nvdaFeed.push(210e8, block.timestamp);

        MonitorChecks.Finding[] memory f = _findings();
        assertEq(f.length, 1);
        assertEq(f[0].code, "M4");
        assertEq(f[0].expected, 210e18, "the feed is the primary source");
        assertEq(f[0].observed, 200e18, "the twap is the second opinion");
        assertFalse(f[0].pause, "an oracle that disagrees is not a reason to stop the protocol");
        assertFalse(MonitorChecks.pausesNeeded(f));
    }

    /// A withheld print writes no round at all, so it cannot be read off lastClose.
    /// An executed closing auction whose day holds no round is the only shape it has,
    /// and getting this wrong once already made the check unable to ever fire.
    function test_aWithheldPrintAlertsAndNeverPauses() public {
        _fund(alice, ALICE_KEY);
        _fund(bob, BOB_KEY);
        _enterClosingAuction();
        _commitClose(alice, true, 1200e6, 1);
        _commitClose(bob, false, 6e18, 2);
        uint64 id = _closeAuctionFrozen();

        Execution[] memory e = new Execution[](2);
        e[0] = _exec(0, 1200e6, 6e18);
        e[1] = _exec(1, 6e18, 1200e6);
        vm.prank(solver);
        house.submitCross(id, 200e6, e);
        vm.warp(block.timestamp + 121);
        house.executeCross(id);

        MonitorChecks.Finding[] memory f = _findings();
        assertEq(f.length, 1);
        assertEq(f[0].code, "M5");
        assertEq(f[0].token, address(nvda));
        assertEq(f[0].observed, 2, "two participants, against the five a print needs");
        assertEq(f[0].expected, 6e18, "and what the auction did match");
        assertFalse(f[0].pause, "refusing to publish is the feature, not an incident");
    }

    /// An opening auction publishes no print, so an executed one must not be read as
    /// a print that went missing.
    function test_anExecutedOpeningAuctionIsNotAMissingPrint() public {
        _buyMoo(alice, 400e6, 1);
        _sellMoo(bob, 2e18, 2);
        uint64 id = _openAndFreeze();
        _passOpeningReference(200e8);

        Execution[] memory e = new Execution[](2);
        e[0] = _exec(0, 400e6, 2e18);
        e[1] = _exec(1, 2e18, 400e6);
        vm.prank(solver);
        house.submitCross(id, 200e6, e);
        vm.warp(block.timestamp + 121);
        house.executeCross(id);

        (,, uint8 phase,,,) = house.auctionState(id);
        assertEq(phase, 4, "the opening cross executed");
        assertEq(house.latestPrintDay(address(nvda)), 0, "an opening auction never prints");
        assertEq(_findings().length, 0, "an opening auction was read as a withheld print");
    }
}
