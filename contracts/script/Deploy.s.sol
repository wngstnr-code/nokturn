// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {AgentMandate} from "../src/AgentMandate.sol";
import {AuctionHouse} from "../src/AuctionHouse.sol";
import {ClearingVerifier} from "../src/ClearingVerifier.sol";
import {ClosingPrintFeed} from "../src/ClosingPrintFeed.sol";
import {PriceOracle} from "../src/PriceOracle.sol";
import {SessionManager} from "../src/SessionManager.sol";
import {Settlement} from "../src/Settlement.sol";
import {SolverRegistry} from "../src/SolverRegistry.sol";
import {UniswapV3Adapter} from "../src/adapters/UniswapV3Adapter.sol";
import {IAuctionHouse} from "../src/interfaces/IAuctionHouse.sol";
import {IClearingVerifier} from "../src/interfaces/IClearingVerifier.sol";
import {IPriceOracle} from "../src/interfaces/IPriceOracle.sol";
import {ISessionManager} from "../src/interfaces/ISessionManager.sol";
import {ISignatureTransfer} from "../src/interfaces/IPermit2.sol";
import {ISolverRegistry} from "../src/interfaces/ISolverRegistry.sol";

import {Addresses} from "./Addresses.sol";

/// @notice Puts the protocol on chain in the one order its constructors allow.
///
/// The governor is a timelock from the first block, because governor is immutable
/// in every contract here and there is no handing it over later. It starts at a
/// delay of zero so the calendar, the feeds and the allowlists can be loaded at
/// all, and Lock.s.sol raises it to forty eight hours afterwards. That window is
/// visible on chain, it closes with a transaction anybody can check, and while it
/// is open the protocol holds no user funds and allows no tokens.
///
/// Nothing here reads a private key. The signer comes from the forge account flags,
/// so a deploy is signed by a hardware wallet or a keystore and never by a value
/// sitting in a dotenv file.
contract Deploy is Script {
    struct Deployment {
        address treasury;
        address guardian;
        address[] proposers;
        address[] executors;
        address timelock;
        address sessions;
        address verifier;
        address oracle;
        address solvers;
        address settlement;
        address auctionHouse;
        address mandates;
        address adapter;
    }

    function run() external returns (Deployment memory d) {
        d.treasury = vm.envAddress("NOKTURN_TREASURY");
        d.proposers = vm.envAddress("NOKTURN_TIMELOCK_PROPOSERS", ",");
        d.executors = vm.envAddress("NOKTURN_TIMELOCK_EXECUTORS", ",");
        d.guardian = vm.envAddress("NOKTURN_GUARDIAN");
        require(d.proposers.length > 0, "no timelock proposer");
        require(d.executors.length > 0, "no timelock executor");
        require(d.guardian != address(0), "no guardian");

        vm.startBroadcast();

        // Admin is the zero address on purpose. The timelock administers itself,
        // so no account can grant itself a role afterwards and the delay can only
        // be changed by a proposal that goes through the delay in force.
        d.timelock = address(new TimelockController(0, d.proposers, d.executors, address(0)));

        // Written straight into the record rather than through locals. The coverage
        // gate compiles with the optimizer off, and a dozen live addresses here is
        // one past what fits the stack.
        d.sessions = address(new SessionManager(d.timelock));
        d.verifier = address(new ClearingVerifier());
        d.oracle = address(new PriceOracle(ISessionManager(d.sessions), d.timelock));
        d.solvers = address(new SolverRegistry(IERC20(Addresses.quote()), d.treasury, d.timelock));

        d.settlement = address(
            new Settlement(
                ISessionManager(d.sessions),
                IPriceOracle(d.oracle),
                IClearingVerifier(d.verifier),
                ISolverRegistry(d.solvers),
                ISignatureTransfer(Addresses.PERMIT2),
                d.treasury,
                d.timelock,
                d.guardian
            )
        );

        d.auctionHouse = address(
            new AuctionHouse(
                ISessionManager(d.sessions),
                IPriceOracle(d.oracle),
                ISolverRegistry(d.solvers),
                ISignatureTransfer(Addresses.PERMIT2),
                IERC20(Addresses.quote()),
                d.treasury,
                d.timelock,
                d.guardian
            )
        );

        d.mandates = address(
            new AgentMandate(
                ISessionManager(d.sessions),
                IPriceOracle(d.oracle),
                ISignatureTransfer(Addresses.PERMIT2),
                d.settlement,
                d.auctionHouse
            )
        );

        d.adapter = address(new UniswapV3Adapter(d.timelock));

        vm.stopBroadcast();

        // Under test the chain is in memory, so a record written there would look
        // like a deploy that happened and did not.
        if (vm.isContext(VmSafe.ForgeContext.ScriptGroup)) _write(d);
        return d;
    }

    /// @dev One file per chain, so a mainnet run cannot quietly overwrite what a
    /// testnet rehearsal wrote.
    function _write(Deployment memory d) internal {
        string memory key = "deployment";
        // The constructor arguments go in beside the addresses, because a
        // verification that has to guess them is a verification that fails on the
        // one contract whose arguments were unusual.
        vm.serializeAddress(key, "treasury", d.treasury);
        vm.serializeAddress(key, "guardian", d.guardian);
        vm.serializeAddress(key, "proposers", d.proposers);
        vm.serializeAddress(key, "executors", d.executors);
        vm.serializeAddress(key, "usdg", Addresses.quote());
        vm.serializeAddress(key, "permit2", Addresses.PERMIT2);
        vm.serializeAddress(key, "timelock", d.timelock);
        vm.serializeAddress(key, "sessions", d.sessions);
        vm.serializeAddress(key, "verifier", d.verifier);
        vm.serializeAddress(key, "oracle", d.oracle);
        vm.serializeAddress(key, "solvers", d.solvers);
        vm.serializeAddress(key, "settlement", d.settlement);
        vm.serializeAddress(key, "auctionHouse", d.auctionHouse);
        vm.serializeAddress(key, "mandates", d.mandates);
        string memory out = vm.serializeAddress(key, "adapter", d.adapter);

        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        // A dry run produces addresses that no chain will ever hold, and the file
        // it would land in is the committed record the monitor and the docs read.
        // Simulating against a chain that has already been deployed to would
        // replace that record with fiction, and nothing would report it.
        if (vm.isContext(VmSafe.ForgeContext.ScriptDryRun)) {
            console2.log("dry run, left", path, "alone");
            return;
        }
        vm.writeJson(out, path);
        console2.log("wrote", path);
    }

    /// @notice A print feed is one contract per token and is not part of the core
    /// deploy, because a token can join the allowlist long after the protocol is
    /// running. Kept here so both paths build the same way.
    function printFeed(address auctionHouse, address token, string memory description)
        external
        returns (address)
    {
        vm.startBroadcast();
        ClosingPrintFeed feed = new ClosingPrintFeed(IAuctionHouse(auctionHouse), token, description);
        vm.stopBroadcast();
        return address(feed);
    }
}
