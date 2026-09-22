// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {Bootstrap} from "../../script/Bootstrap.s.sol";
import {Deploy} from "../../script/Deploy.s.sol";
import {Lock} from "../../script/Lock.s.sol";
import {VerifyDeployment} from "../../script/VerifyDeployment.s.sol";
import {ForkFixture} from "../fixtures/ForkFixture.sol";

/// @notice The post deploy verifier, run against a deployment that is correct by
/// construction.
///
/// It reads every address back through a raw staticcall so that it can be pointed
/// at a deployment older than itself and report on it rather than die on it. The
/// price of that is losing the compiler as the thing that keeps its function
/// signatures honest, and this file is what pays that price back. A getter renamed
/// in src and not renamed in the script shows up here as a failed check rather
/// than as a passing verifier that checked nothing.
///
/// It is on a fork because Bootstrap is. The allowlist gate reads the beacon slot
/// of each Stock Token, and there are no Stock Tokens in an empty EVM.
contract VerifyDeploymentForkTest is Test {
    address internal treasury = address(0x7EA);
    address internal guardian = address(0x6A4D1A4);

    Deploy.Deployment internal d;
    VerifyDeployment internal verifier;

    function setUp() public {
        ForkFixture.selectMainnet();

        vm.setEnv("NOKTURN_TREASURY", vm.toString(treasury));
        vm.setEnv("NOKTURN_GUARDIAN", vm.toString(guardian));
        vm.setEnv("NOKTURN_TIMELOCK_PROPOSERS", vm.toString(DEFAULT_SENDER));
        vm.setEnv("NOKTURN_TIMELOCK_EXECUTORS", vm.toString(DEFAULT_SENDER));

        d = new Deploy().run();
        new Bootstrap().runWith(d.timelock, d.sessions, d.settlement, d.auctionHouse, d.solvers, d.adapter);
        new Lock().runWith(d.timelock);

        verifier = new VerifyDeployment();
    }

    function test_everyCheckAnswersAndAgrees() public {
        assertEq(verifier.runWith(_deployed()), 0);
    }

    /// The other half. A verifier that never reports anything is not a verifier,
    /// so one address is pointed somewhere with no code at all and the run has to
    /// end in the refusal rather than in a pass.
    function test_anAddressPointedSomewhereElseIsReported() public {
        VerifyDeployment.Deployed memory wrong = _deployed();
        wrong.solvers = address(0xBEEF);

        vm.expectRevert("the deployment does not match what the scripts meant to put there");
        verifier.runWith(wrong);
    }

    function _deployed() internal view returns (VerifyDeployment.Deployed memory) {
        return VerifyDeployment.Deployed({
            timelock: d.timelock,
            sessions: d.sessions,
            verifier: d.verifier,
            oracle: d.oracle,
            solvers: d.solvers,
            settlement: d.settlement,
            auctionHouse: d.auctionHouse,
            mandates: d.mandates,
            adapter: d.adapter
        });
    }
}
