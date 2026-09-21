// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";

import {Settlement} from "../../src/Settlement.sol";
import {IPriceOracle} from "../../src/interfaces/IPriceOracle.sol";
import {ISignatureTransfer} from "../../src/interfaces/IPermit2.sol";
import {Permit2Witness} from "../../src/libraries/Permit2Witness.sol";
import {Intent} from "../../src/types/Types.sol";

import {Addresses} from "../Addresses.sol";
import {IntentHasher} from "./IntentHasher.sol";

/// @notice What both demo scripts need to stand on the fork the backend runs.
///
/// Neither script makes a fork of its own. The deployment, the accounts and the
/// block all come from infra, so a receipt the demo shows is a receipt the
/// coordinator could have produced for the same intent.
abstract contract DemoBase is Script {
    string internal constant PIN_FILE = "../infra/pinned-block.json";
    string internal constant ACCOUNTS_FILE = "../infra/accounts.json";
    string internal constant DEPLOYMENT_FILE = "../infra/fork-deployment.json";

    /// Written by a prepare stage and read by every later one, because a script
    /// contract is ephemeral and cannot hash a struct it is holding in memory.
    string internal constant HASHER_PATH = "deployments/demo-hasher.txt";

    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;

    struct Deployed {
        address timelock;
        address sessions;
        address oracle;
        address settlement;
        address auctionHouse;
        address solvers;
        address adapter;
    }

    struct Actors {
        address[4] users;
        uint256[4] userKeys;
        address[2] solvers;
        uint256[2] solverKeys;
    }

    function _deployed() internal view returns (Deployed memory d) {
        string memory record = vm.readFile(DEPLOYMENT_FILE);
        d.timelock = vm.parseJsonAddress(record, ".timelock");
        d.sessions = vm.parseJsonAddress(record, ".sessions");
        d.oracle = vm.parseJsonAddress(record, ".oracle");
        d.settlement = vm.parseJsonAddress(record, ".settlement");
        d.auctionHouse = vm.parseJsonAddress(record, ".auctionHouse");
        d.solvers = vm.parseJsonAddress(record, ".solvers");
        d.adapter = vm.parseJsonAddress(record, ".adapter");
    }

    /// @dev The people are the accounts the backend already funds, read from the
    /// file that names them. Anvil's own defaults cannot be used on this chain at
    /// all, because their keys are public and somebody has left an EIP-7702
    /// delegation on every one of them on mainnet 4663. Permit2 sees the code, takes
    /// the EIP-1271 path instead of ecrecover, and rejects a good signature with an
    /// empty revert.
    function _actors() internal view returns (Actors memory a) {
        string memory accounts = vm.readFile(ACCOUNTS_FILE);
        string memory mnemonic = vm.parseJsonString(accounts, "._mnemonic");

        for (uint256 k = 0; k < 4; ++k) {
            a.users[k] = vm.parseJsonAddress(accounts, string.concat(".users[", vm.toString(k), "]"));
            a.userKeys[k] = _keyFor(mnemonic, a.users[k]);
        }
        a.solvers[0] = vm.parseJsonAddress(accounts, ".solverA");
        a.solvers[1] = vm.parseJsonAddress(accounts, ".solverB");
        a.solverKeys[0] = _keyFor(mnemonic, a.solvers[0]);
        a.solverKeys[1] = _keyFor(mnemonic, a.solvers[1]);
    }

    /// @dev Transactions go through auto impersonation and need no key, but a
    /// Permit2 witness is signed rather than sent, so these do. The index is found
    /// rather than written down, because the order of the accounts in that file
    /// belongs to whoever maintains it.
    function _keyFor(string memory mnemonic, address who) internal pure returns (uint256) {
        for (uint32 index = 0; index < 20; ++index) {
            uint256 key = vm.deriveKey(mnemonic, index);
            if (vm.addr(key) == who) return key;
        }
        revert("no derivation index in infra/accounts.json produces this address");
    }

    function _hasher() internal view returns (IntentHasher) {
        return IntentHasher(vm.parseAddress(vm.readFile(HASHER_PATH)));
    }

    /// @dev USD with eighteen decimals per smallest unit, which is the convention
    /// the verifier works in. A price per whole token is off by twelve orders of
    /// magnitude the moment USDG is on one side of the pair.
    function _unitPrice(address oracle, address token, uint8 decimals) internal view returns (uint256) {
        (uint256 price,, bool healthy) = IPriceOracle(oracle).refPrice(token);
        require(healthy, "oracle is not healthy for this token");
        return (price * WAD) / (10 ** decimals);
    }

    /// @dev Permit2 binds a signature to whoever will call it, so the spender is the
    /// contract that will pull the funds and nothing else can spend it.
    function _signFor(uint256 key, address spender, bytes32 typeHash, Intent memory i)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = Permit2Witness.digest(
            ISignatureTransfer(Addresses.PERMIT2).DOMAIN_SEPARATOR(),
            typeHash,
            i.sellToken,
            i.sellAmount,
            spender,
            i.nonce,
            i.validUntil,
            _hasher().hashOf(i)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _settlementTypeHash(address settlement) internal view returns (bytes32) {
        return Permit2Witness.typeHash(Settlement(settlement).WITNESS_TYPE_STRING());
    }
}
