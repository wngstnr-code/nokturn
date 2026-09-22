// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {Addresses} from "./Addresses.sol";

/// @notice Reads a finished deployment back off the chain and checks it says what
/// the deploy meant to say.
///
/// Every rehearsal so far verified this by hand, one cast call at a time, and a
/// check done that way is a check nobody else can repeat. It reads only, signs
/// nothing, and needs no key.
///
///     forge script script/VerifyDeployment.s.sol:VerifyDeployment --rpc-url $RPC
contract VerifyDeployment is Script {
    uint256 internal failures;

    struct Deployed {
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

    function run() external {
        runWith(_load());
    }

    /// @dev The checks, separated from where the addresses came from, so a test can
    /// point them at a deployment that was never written to a file. Returns the
    /// count as well as reverting on it, because a caller in memory wants the
    /// number and an operator at a terminal wants the non zero exit.
    function runWith(Deployed memory d) public returns (uint256) {
        failures = 0;

        _codeAt("timelock", d.timelock);
        _codeAt("sessions", d.sessions);
        _codeAt("verifier", d.verifier);
        _codeAt("oracle", d.oracle);
        _codeAt("solvers", d.solvers);
        _codeAt("settlement", d.settlement);
        _codeAt("auctionHouse", d.auctionHouse);
        _codeAt("mandates", d.mandates);
        _codeAt("adapter", d.adapter);

        _governance(d);
        _wiring(d);
        _allowlist(d);

        if (failures > 0) {
            console2.log("failed checks", failures);
            revert("the deployment does not match what the scripts meant to put there");
        }
        console2.log("every check passed");
        return 0;
    }

    function _governance(Deployed memory d) internal {
        _uintIs("timelock minDelay", d.timelock, abi.encodeCall(TimelockController.getMinDelay, ()), 48 hours);
        _addrIs("sessions governor", d.sessions, abi.encodeWithSignature("governor()"), d.timelock);
        (bool floorRead, uint256 floor) = _readUint(d.solvers, abi.encodeWithSignature("MIN_BOND_FLOOR()"));
        if (!floorRead) {
            _bad("registry MIN_BOND_FLOOR", "the deployed registry does not answer it");
        } else {
            _uintIs("registry minBond", d.solvers, abi.encodeWithSignature("minBond()"), floor);
        }
    }

    /// @dev The references that cannot be changed after deployment, read back from
    /// the contracts themselves rather than from the record that claims them.
    function _wiring(Deployed memory d) internal {
        _addrIs("settlement sessions", d.settlement, abi.encodeWithSignature("sessions()"), d.sessions);
        _addrIs("settlement oracle", d.settlement, abi.encodeWithSignature("oracle()"), d.oracle);
        _addrIs("settlement verifier", d.settlement, abi.encodeWithSignature("verifier()"), d.verifier);
        _addrIs("settlement solvers", d.settlement, abi.encodeWithSignature("solvers()"), d.solvers);
        _addrIs(
            "settlement baselineAdapter",
            d.settlement,
            abi.encodeWithSignature("baselineAdapter()"),
            d.adapter
        );

        _addrIs("auctionHouse sessions", d.auctionHouse, abi.encodeWithSignature("sessions()"), d.sessions);
        _addrIs("auctionHouse oracle", d.auctionHouse, abi.encodeWithSignature("oracle()"), d.oracle);
        _addrIs("auctionHouse solvers", d.auctionHouse, abi.encodeWithSignature("solvers()"), d.solvers);

        _addrIs("mandates settlement", d.mandates, abi.encodeWithSignature("settlement()"), d.settlement);
        _addrIs(
            "mandates auctionHouse", d.mandates, abi.encodeWithSignature("auctionHouse()"), d.auctionHouse
        );

        _addrIs("registry settlement", d.solvers, abi.encodeWithSignature("settlement()"), d.settlement);
        // The one that was missing until 22 September 2026. Without it every cross
        // reverts at its last step, and nothing else on chain shows it.
        _addrIs("registry auctionHouse", d.solvers, abi.encodeWithSignature("auctionHouse()"), d.auctionHouse);
    }

    function _allowlist(Deployed memory d) internal {
        address[] memory tokens = Addresses.allowlist();
        address[] memory pools = Addresses.pools();

        for (uint256 k = 0; k < tokens.length; ++k) {
            _boolIs(
                string.concat("settlement allows token ", vm.toString(k)),
                d.settlement,
                abi.encodeWithSignature("tokenAllowed(address)", tokens[k])
            );
            _boolIs(
                string.concat("auctionHouse allows token ", vm.toString(k)),
                d.auctionHouse,
                abi.encodeWithSignature("auctionTokenAllowed(address)", tokens[k])
            );
            _addrIs(
                string.concat("adapter pool ", vm.toString(k)),
                d.adapter,
                abi.encodeWithSignature("poolFor(address,address)", tokens[k], Addresses.quote()),
                pools[k]
            );
        }

        _boolIs(
            "settlement allows the quote asset",
            d.settlement,
            abi.encodeWithSignature("tokenAllowed(address)", Addresses.quote())
        );
        _boolIs(
            "settlement allows the adapter",
            d.settlement,
            abi.encodeWithSignature("adapterAllowed(address)", d.adapter)
        );
    }

    function _load() internal view returns (Deployed memory d) {
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        string memory record = vm.readFile(path);
        d.timelock = vm.parseJsonAddress(record, ".timelock");
        d.sessions = vm.parseJsonAddress(record, ".sessions");
        d.verifier = vm.parseJsonAddress(record, ".verifier");
        d.oracle = vm.parseJsonAddress(record, ".oracle");
        d.solvers = vm.parseJsonAddress(record, ".solvers");
        d.settlement = vm.parseJsonAddress(record, ".settlement");
        d.auctionHouse = vm.parseJsonAddress(record, ".auctionHouse");
        d.mandates = vm.parseJsonAddress(record, ".mandates");
        d.adapter = vm.parseJsonAddress(record, ".adapter");
    }

    function _codeAt(string memory label, address who) internal {
        _ok(string.concat(label, " has code"), who.code.length > 0);
    }

    /// @dev Every check goes through a raw staticcall rather than a typed call.
    /// The whole point of this script is to be pointed at a deployment older than
    /// itself, and a typed call to a selector that address does not carry takes the
    /// script down with it. A verifier that dies instead of reporting is worse than
    /// no verifier, because the operator reads a crash and not a finding. Measured
    /// on the fourth testnet rehearsal, which predates registry auctionHouse.
    function _read(address target, bytes memory data) internal view returns (bool, bytes memory) {
        if (target.code.length == 0) return (false, "");
        (bool success, bytes memory out) = target.staticcall(data);
        if (!success || out.length < 32) return (false, "");
        return (true, out);
    }

    function _readUint(address target, bytes memory data) internal view returns (bool, uint256) {
        (bool got, bytes memory out) = _read(target, data);
        if (!got) return (false, 0);
        return (true, abi.decode(out, (uint256)));
    }

    function _addrIs(string memory label, address target, bytes memory data, address want) internal {
        (bool got, bytes memory out) = _read(target, data);
        if (!got) {
            _bad(label, "the deployed contract does not answer this call");
            return;
        }
        _eq(label, abi.decode(out, (address)), want);
    }

    function _uintIs(string memory label, address target, bytes memory data, uint256 want) internal {
        (bool got, uint256 value) = _readUint(target, data);
        if (!got) {
            _bad(label, "the deployed contract does not answer this call");
            return;
        }
        _eqUint(label, value, want);
    }

    function _boolIs(string memory label, address target, bytes memory data) internal {
        (bool got, bytes memory out) = _read(target, data);
        if (!got) {
            _bad(label, "the deployed contract does not answer this call");
            return;
        }
        _ok(label, abi.decode(out, (bool)));
    }

    function _eq(string memory label, address got, address want) internal {
        if (got == want) {
            console2.log("ok  ", label);
            return;
        }
        console2.log("BAD ", label);
        console2.log("  got ", got);
        console2.log("  want", want);
        failures += 1;
    }

    function _eqUint(string memory label, uint256 got, uint256 want) internal {
        if (got == want) {
            console2.log("ok  ", label, got);
            return;
        }
        console2.log("BAD ", label);
        console2.log("  got ", got);
        console2.log("  want", want);
        failures += 1;
    }

    function _ok(string memory label, bool value) internal {
        if (value) {
            console2.log("ok  ", label);
            return;
        }
        console2.log("BAD ", label);
        failures += 1;
    }

    function _bad(string memory label, string memory why) internal {
        console2.log("BAD ", label);
        console2.log("  ", why);
        failures += 1;
    }
}
