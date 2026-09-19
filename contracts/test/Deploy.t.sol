// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {AgentMandate} from "../src/AgentMandate.sol";
import {AuctionHouse} from "../src/AuctionHouse.sol";
import {PriceOracle} from "../src/PriceOracle.sol";
import {SessionManager} from "../src/SessionManager.sol";
import {Settlement} from "../src/Settlement.sol";
import {SolverRegistry} from "../src/SolverRegistry.sol";
import {UniswapV3Adapter} from "../src/adapters/UniswapV3Adapter.sol";

import {MockERC20} from "./mocks/MockERC20.sol";
import {Addresses} from "../script/Addresses.sol";
import {Deploy} from "../script/Deploy.s.sol";

/// @notice The deploy script, run in memory. A deploy script that is only ever
/// exercised against a live chain is a script whose first real test costs gas and
/// cannot be undone.
contract DeployTest is Test {
    Deploy internal script;

    address internal treasury = address(0x7EA);
    address internal proposer = address(0xB0A4D);
    address internal executor = address(0xE8EC);

    function setUp() public {
        // AuctionHouse asks the quote token for its decimals in its constructor,
        // which is the one thing here that needs USDG to exist. Six decimals is
        // the real answer, and the immutable in the mock bakes it into the code
        // that gets etched.
        MockERC20 usdg = new MockERC20("Global Dollar", "USDG", 6);
        vm.etch(Addresses.USDG, address(usdg).code);

        script = new Deploy();
        vm.setEnv("NOKTURN_TREASURY", vm.toString(treasury));
        vm.setEnv("NOKTURN_TIMELOCK_PROPOSERS", vm.toString(proposer));
        vm.setEnv("NOKTURN_TIMELOCK_EXECUTORS", vm.toString(executor));
    }

    function test_everyContractPointsAtTheOneBeforeIt() public {
        Deploy.Deployment memory d = script.run();

        assertEq(address(Settlement(d.settlement).sessions()), d.sessions, "settlement sessions");
        assertEq(address(Settlement(d.settlement).oracle()), d.oracle, "settlement oracle");
        assertEq(address(Settlement(d.settlement).verifier()), d.verifier, "settlement verifier");
        assertEq(address(Settlement(d.settlement).solvers()), d.solvers, "settlement solvers");
        assertEq(address(Settlement(d.settlement).permit2()), Addresses.PERMIT2, "settlement permit2");

        assertEq(address(AuctionHouse(d.auctionHouse).sessions()), d.sessions, "auction sessions");
        assertEq(address(AuctionHouse(d.auctionHouse).oracle()), d.oracle, "auction oracle");
        assertEq(address(AuctionHouse(d.auctionHouse).quote()), Addresses.USDG, "auction quote");

        assertEq(address(PriceOracle(d.oracle).sessions()), d.sessions, "oracle sessions");
        assertEq(address(SolverRegistry(d.solvers).bondToken()), Addresses.USDG, "bond token");
    }

    /// The whole reason the timelock is deployed first. Every one of these is
    /// immutable, so a wrong governor here is a redeploy rather than a fix.
    function test_theTimelockIsTheGovernorOfEverythingThatHasOne() public {
        Deploy.Deployment memory d = script.run();

        assertEq(SessionManager(d.sessions).governor(), d.timelock, "sessions");
        assertEq(PriceOracle(d.oracle).governor(), d.timelock, "oracle");
        assertEq(SolverRegistry(d.solvers).governor(), d.timelock, "solvers");
        assertEq(Settlement(d.settlement).governor(), d.timelock, "settlement");
        assertEq(AuctionHouse(d.auctionHouse).governor(), d.timelock, "auction house");
        assertEq(UniswapV3Adapter(d.adapter).governor(), d.timelock, "adapter");
    }

    /// The timelock administers itself and nothing else does. An account that
    /// could grant itself the proposer role would make the delay decorative.
    function test_nobodyOutsideTheTimelockCanChangeItsRoles() public {
        Deploy.Deployment memory d = script.run();
        TimelockController timelock = TimelockController(payable(d.timelock));

        assertTrue(timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), d.timelock), "self administered");
        assertFalse(timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), proposer), "no admin proposer");
        assertFalse(timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), executor), "no admin executor");
        assertTrue(timelock.hasRole(timelock.PROPOSER_ROLE(), proposer), "proposer");
        assertTrue(timelock.hasRole(timelock.EXECUTOR_ROLE(), executor), "executor");
    }

    /// The bootstrap window is meant to be open when the deploy ends, and closing
    /// it is a separate step that leaves its own transaction behind.
    function test_theDelayStartsAtZeroSoTheCalendarCanBeLoadedAtAll() public {
        Deploy.Deployment memory d = script.run();
        assertEq(TimelockController(payable(d.timelock)).getMinDelay(), 0, "bootstrap window open");
    }

    function test_theAgentMandateKnowsBothVenues() public {
        Deploy.Deployment memory d = script.run();
        assertEq(AgentMandate(d.mandates).settlement(), d.settlement, "settlement");
        assertEq(AgentMandate(d.mandates).auctionHouse(), d.auctionHouse, "auction house");
    }
}
