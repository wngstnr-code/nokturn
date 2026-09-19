// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AgentMandate} from "../../src/AgentMandate.sol";
import {MandateAccount} from "../../src/MandateAccount.sol";
import {PriceOracle} from "../../src/PriceOracle.sol";
import {SessionManager} from "../../src/SessionManager.sol";
import {IAgentMandate} from "../../src/interfaces/IAgentMandate.sol";
import {IPriceOracle} from "../../src/interfaces/IPriceOracle.sol";
import {ISessionManager} from "../../src/interfaces/ISessionManager.sol";
import {ISignatureTransfer} from "../../src/interfaces/IPermit2.sol";
import {CalendarFixture} from "../../script/Calendar.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockPermit2} from "../mocks/MockPermit2.sol";
import {MockSwapAdapter} from "../mocks/MockSwapAdapter.sol";
import {MandateHandler} from "./MandateHandler.sol";

/// @notice Invariant I14 from rencana-uji.md section 1, plus the budget and
/// revocation properties the mandate design rests on. The claim being defended is
/// that an agent signature moves an owner's funds only inside the envelope the
/// owner wrote, and that pulling the mandate takes effect at once rather than at
/// the next authorize.
contract MandateInvariants is Test {
    SessionManager sessions;
    PriceOracle oracle;
    MockPermit2 permit2;
    AgentMandate mandates;

    MockERC20 usdg;
    MockERC20 nvda;
    MockERC20 googl;
    MockAggregator usdgFeed;
    MockAggregator nvdaFeed;

    MockSwapAdapter twapSource;

    MandateHandler handler;

    address governor = address(0x60174E);
    address settlement = address(0x5E771E);
    address auctionHouse = address(0xA0C7104);

    uint256 constant AGENT_KEY = 0xA9E47;
    uint256 constant IMPOSTOR_KEY = 0xDECAF;

    uint64 constant BELL = 1_773_235_800;

    function setUp() public {
        sessions = new SessionManager(governor);
        vm.startPrank(governor);
        sessions.setDstBoundaries(CalendarFixture.loadDst());
        CalendarFixture.loadCalendar(sessions, CalendarFixture.loadDays());
        vm.stopPrank();

        usdg = new MockERC20("Global Dollar", "USDG", 6);
        nvda = new MockERC20("Nvidia", "RHNVDA", 18);
        googl = new MockERC20("Alphabet", "RHGOOGL", 18);
        usdgFeed = new MockAggregator(8, "USDG / USD");
        nvdaFeed = new MockAggregator(8, "RHNVDA / USD");

        // A weekend or a holiday swaps the oracle roles, and a mandate has to be
        // measurable in those sessions too, so the TWAP side is wired here rather
        // than left to revert and quietly skip every weekend action.
        twapSource = new MockSwapAdapter();
        twapSource.setRate(address(usdg), address(nvda), 1e18);
        twapSource.setRate(address(nvda), address(usdg), 200e18);
        twapSource.setRate(address(googl), address(usdg), 200e18);

        oracle = new PriceOracle(ISessionManager(address(sessions)), governor);
        vm.startPrank(governor);
        oracle.setFeed(address(usdg), address(usdgFeed), 6000, 20_000);
        oracle.setFeed(address(nvda), address(nvdaFeed), 6000, 20_000);
        oracle.setFeed(address(googl), address(nvdaFeed), 6000, 20_000);
        oracle.setTwapSource(address(usdg), address(twapSource), address(nvda), 1800);
        oracle.setTwapSource(address(nvda), address(twapSource), address(usdg), 1800);
        oracle.setTwapSource(address(googl), address(twapSource), address(usdg), 1800);
        vm.stopPrank();

        permit2 = new MockPermit2();
        mandates = new AgentMandate(
            ISessionManager(address(sessions)),
            IPriceOracle(address(oracle)),
            ISignatureTransfer(address(permit2)),
            settlement,
            auctionHouse
        );

        vm.warp(BELL + 3600);
        usdgFeed.push(1e8, block.timestamp);
        nvdaFeed.push(200e8, block.timestamp);

        handler = new MandateHandler(
            mandates,
            sessions,
            oracle,
            permit2,
            usdg,
            nvda,
            googl,
            usdgFeed,
            nvdaFeed,
            settlement,
            AGENT_KEY,
            IMPOSTOR_KEY
        );

        targetContract(address(handler));
    }

    /// I14. An intent that broke a mandate rule never becomes authorized, so it
    /// never reaches Permit2 either, because the account answers EIP-1271 from
    /// exactly this mark.
    function invariant_noIntentOutsideItsMandateIsEverAuthorized() public view {
        uint256 n = handler.attemptCount();
        for (uint256 k = 0; k < n; ++k) {
            MandateHandler.Attempt memory a = handler.attemptAt(k);
            if (a.brokenRule == bytes32(0)) continue;
            assertFalse(a.accepted, "an intent outside the mandate was authorized");
            assertFalse(
                mandates.accountAuthorized(a.account, a.digest), "and the account would have signed it"
            );
        }
    }

    /// Revocation and expiry are read at signature time, not only at authorize, so
    /// pulling a mandate stops intents that were already booked.
    function invariant_pullingAMandateStopsTheIntentsItAlreadyBooked() public view {
        uint256 n = handler.attemptCount();
        for (uint256 k = 0; k < n; ++k) {
            MandateHandler.Attempt memory a = handler.attemptAt(k);
            if (!a.accepted) continue;
            (,,, uint64 expiry,,,, bool revoked) = mandates.mandate(a.id);
            if (!revoked && block.timestamp < expiry) continue;
            assertFalse(
                mandates.accountAuthorized(a.account, a.digest),
                "a pulled mandate still answered for an intent"
            );
            assertEq(
                MandateAccount(a.account).isValidSignature(a.digest, ""),
                bytes4(0xffffffff),
                "and the account still returned the magic value"
            );
        }
    }

    /// The daily budget is the number the owner actually wrote down, so it holds
    /// across authorize, release and the Eastern day rollover alike.
    function invariant_theDailyBudgetNeverPassesItsCap() public view {
        uint256 n = handler.idCount();
        for (uint256 k = 0; k < n; ++k) {
            bytes32 id = handler.idAt(k);
            assertLe(mandates.spentToday(id), handler.maxPerDay(id), "daily budget over its cap");
        }
    }

    /// No single authorized intent is larger than the per batch cap, whatever the
    /// oracle did between the mandate being written and the intent being signed.
    function invariant_noAuthorizedIntentPassesThePerBatchCap() public view {
        uint256 n = handler.attemptCount();
        for (uint256 k = 0; k < n; ++k) {
            MandateHandler.Attempt memory a = handler.attemptAt(k);
            if (!a.accepted) continue;
            assertLe(a.notionalUsd, handler.maxPerBatch(a.id), "an authorized intent passed the batch cap");
        }
    }

    /// Every clone answers for one owner and one registry, and the registry itself
    /// is not a place funds can come to rest.
    function invariant_everyAccountAnswersForItsOwnOwnerOnly() public view {
        uint256 n = handler.idCount();
        for (uint256 k = 0; k < n; ++k) {
            bytes32 id = handler.idAt(k);
            address account = mandates.accountOf(id);
            assertEq(mandates.accountOwner(account), handler.creator(id), "account owner drifted");
            assertEq(mandates.mandateOf(account), id, "account maps back to another mandate");
        }
        assertEq(usdg.balanceOf(address(mandates)), 0, "the registry is holding usdg");
        assertEq(nvda.balanceOf(address(mandates)), 0, "the registry is holding nvda");
    }

    /// The campaign has to reach an authorization for any of the above to mean
    /// something, and every rule has to be reachable as a refusal.
    function test_theHandlerAuthorizesAndRefusesForRealReasons() public {
        handler.actCreateMandate(1);
        for (uint256 shape = 0; shape <= 9; ++shape) {
            handler.actAuthorize((shape << 8) | 0);
        }

        uint256 accepted;
        uint256 refusedForARule;
        for (uint256 k = 0; k < handler.attemptCount(); ++k) {
            MandateHandler.Attempt memory a = handler.attemptAt(k);
            if (a.accepted) accepted += 1;
            if (!a.accepted && a.brokenRule != bytes32(0)) refusedForARule += 1;
        }

        assertGt(accepted, 0, "the conforming shape never got through");
        assertGe(refusedForARule, 7, "the rule breaking shapes were not exercised");
    }
}
