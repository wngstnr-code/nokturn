// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
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
        address treasury = vm.envAddress("NOKTURN_TREASURY");
        address[] memory proposers = vm.envAddress("NOKTURN_TIMELOCK_PROPOSERS", ",");
        address[] memory executors = vm.envAddress("NOKTURN_TIMELOCK_EXECUTORS", ",");
        require(proposers.length > 0, "no timelock proposer");
        require(executors.length > 0, "no timelock executor");

        vm.startBroadcast();

        // Admin is the zero address on purpose. The timelock administers itself,
        // so no account can grant itself a role afterwards and the delay can only
        // be changed by a proposal that goes through the delay in force.
        TimelockController timelock = new TimelockController(0, proposers, executors, address(0));
        address governor = address(timelock);

        SessionManager sessions = new SessionManager(governor);
        ClearingVerifier verifier = new ClearingVerifier();
        PriceOracle oracle = new PriceOracle(ISessionManager(address(sessions)), governor);
        SolverRegistry solvers = new SolverRegistry(IERC20(Addresses.USDG), treasury, governor);

        Settlement settlement = new Settlement(
            ISessionManager(address(sessions)),
            IPriceOracle(address(oracle)),
            IClearingVerifier(address(verifier)),
            ISolverRegistry(address(solvers)),
            ISignatureTransfer(Addresses.PERMIT2),
            treasury,
            governor
        );

        AuctionHouse auctionHouse = new AuctionHouse(
            ISessionManager(address(sessions)),
            IPriceOracle(address(oracle)),
            ISolverRegistry(address(solvers)),
            ISignatureTransfer(Addresses.PERMIT2),
            IERC20(Addresses.USDG),
            treasury,
            governor
        );

        AgentMandate mandates = new AgentMandate(
            ISessionManager(address(sessions)),
            IPriceOracle(address(oracle)),
            ISignatureTransfer(Addresses.PERMIT2),
            address(settlement),
            address(auctionHouse)
        );

        UniswapV3Adapter adapter = new UniswapV3Adapter(governor);

        vm.stopBroadcast();

        d = Deployment({
            treasury: treasury,
            proposers: proposers,
            executors: executors,
            timelock: governor,
            sessions: address(sessions),
            verifier: address(verifier),
            oracle: address(oracle),
            solvers: address(solvers),
            settlement: address(settlement),
            auctionHouse: address(auctionHouse),
            mandates: address(mandates),
            adapter: address(adapter)
        });

        _write(d);
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
        vm.serializeAddress(key, "proposers", d.proposers);
        vm.serializeAddress(key, "executors", d.executors);
        vm.serializeAddress(key, "usdg", Addresses.USDG);
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
