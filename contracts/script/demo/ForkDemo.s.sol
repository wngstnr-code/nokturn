// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {Settlement} from "../../src/Settlement.sol";
import {SolverRegistry} from "../../src/SolverRegistry.sol";
import {IPriceOracle} from "../../src/interfaces/IPriceOracle.sol";
import {ISessionManager} from "../../src/interfaces/ISessionManager.sol";
import {ISignatureTransfer} from "../../src/interfaces/IPermit2.sol";
import {IVenueAdapter} from "../../src/interfaces/IVenueAdapter.sol";
import {IntentLib} from "../../src/libraries/IntentLib.sol";
import {Permit2Witness} from "../../src/libraries/Permit2Witness.sol";
import {Execution, Intent, Session, SessionMask, Solution, VenueCall} from "../../src/types/Types.sol";

import {Addresses} from "../Addresses.sol";
import {IntentHasher} from "./IntentHasher.sol";

/// @notice Drives a whole batch, end to end, on an anvil fork of mainnet 4663.
///
/// The demo runs in the weekend session, which is not a presentation choice. It is
/// the session where the Chainlink feeds are frozen for two days and the protocol
/// has to price from the pool instead, and it is the session that carries 33.2
/// percent of this chain's trades. Showing the easy session would be showing the
/// session nobody needs this for.
///
/// Nothing here is staged except the two wallets. The pool, the tokens, the tick
/// data the baseline is computed from and the price band are all mainnet state at
/// the block the fork was taken from, and that block number is written into
/// deployments/demo.json so the number on screen can be checked against the chain.
///
/// The stages are separate entry points rather than one run(), because two of the
/// gaps between them are clock movements the node has to make. A batch cannot be
/// solved before its collection window closes, and it cannot be finalized before
/// the solution window closes. See tools/fork-demo.sh.
contract ForkDemo is Script {
    /// The actors are derived from labels rather than taken from anvil's default
    /// accounts, and that is not a style choice. Anvil's accounts are famous
    /// addresses, and on mainnet 4663 the second one already holds a contract. Permit2
    /// then routes the owner check through EIP-1271 instead of ecrecover, the call
    /// lands on somebody else's code, and the batch reverts with no reason string.
    /// A label keyed address collides with nothing and is checked for code below.
    /// Written during funding and read by every later stage, because a script
    /// contract is ephemeral and cannot hash its own memory.
    string internal constant HASHER_PATH = "deployments/demo-hasher.txt";

    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;

    /// The fee is taken as a share of the surplus rather than as a fixed number of
    /// basis points, because Settlement caps it at twenty percent of the surplus
    /// and a fixed withholding reverts the whole batch the moment the pool happens
    /// to be tight. An eighth leaves room under both ceilings. parameter.md 4C.
    uint256 internal constant WITHHOLD_SHARE_OF_SURPLUS = 8;

    /// Alice sells this much USDG and Bob sells the NVDA that matches it. Sized so
    /// the round trip stays well under CAP_PER_BATCH_USD, which is 5,000.
    uint256 internal constant SELL_USDG = 1500e6;

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
        uint256 aliceKey;
        uint256 bobKey;
        uint256 solverKey;
        address alice;
        address bob;
        address solver;
    }

    function _deployed() internal view returns (Deployed memory d) {
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        string memory record = vm.readFile(path);
        d.timelock = vm.parseJsonAddress(record, ".timelock");
        d.sessions = vm.parseJsonAddress(record, ".sessions");
        d.oracle = vm.parseJsonAddress(record, ".oracle");
        d.settlement = vm.parseJsonAddress(record, ".settlement");
        d.auctionHouse = vm.parseJsonAddress(record, ".auctionHouse");
        d.solvers = vm.parseJsonAddress(record, ".solvers");
        d.adapter = vm.parseJsonAddress(record, ".adapter");
    }

    function _actors() internal pure returns (Actors memory a) {
        a.aliceKey = uint256(keccak256("nokturn fork demo alice"));
        a.bobKey = uint256(keccak256("nokturn fork demo bob"));
        a.solverKey = uint256(keccak256("nokturn fork demo solver"));
        a.alice = vm.addr(a.aliceKey);
        a.bob = vm.addr(a.bobKey);
        a.solver = vm.addr(a.solverKey);
    }

    /// @notice Stakes the two wallets and the solver, then lets Bob buy his NVDA
    /// on the real pool rather than being handed it.
    ///
    /// One impersonation, and it is a USDG source only. Bob's inventory comes from
    /// an actual swap against the actual pool at the actual price, which means the
    /// only thing this demo fabricates is who happens to be holding USDG. Every
    /// price on screen afterwards was formed by the chain.
    ///
    /// The default source is the AAPL pool, which holds USDG and is not the pool
    /// the baseline is read from, so nothing this function does touches the number
    /// the demo is about. Pass another address if that pool has been drained.
    function fund(address usdgSource) external {
        Deployed memory d = _deployed();
        Actors memory a = _actors();

        address usdg = Addresses.quote();
        address nvda = Addresses.NVDA;

        require(a.alice.code.length == 0, "alice collides with a contract on this chain");
        require(a.bob.code.length == 0, "bob collides with a contract on this chain");
        require(a.solver.code.length == 0, "solver collides with a contract on this chain");

        // Gas for the three of them, from the account that paid for the deploy.
        vm.startBroadcast();
        payable(a.alice).transfer(1 ether);
        payable(a.bob).transfer(1 ether);
        payable(a.solver).transfer(1 ether);
        vm.stopBroadcast();

        uint256 bond = SolverRegistry(d.solvers).minBond();
        // Bob buys with a fifth more than Alice sells, so a move in the pool
        // between funding and the batch cannot leave him short of his own leg.
        uint256 bobBudget = (SELL_USDG * 6) / 5;
        uint256 needed = SELL_USDG + bond + bobBudget;
        require(IERC20(usdg).balanceOf(usdgSource) >= needed, "usdg source is short");

        vm.startBroadcast(usdgSource);
        IERC20(usdg).transfer(a.alice, SELL_USDG);
        IERC20(usdg).transfer(a.bob, bobBudget);
        IERC20(usdg).transfer(a.solver, bond);
        vm.stopBroadcast();

        vm.startBroadcast(a.bobKey);
        IERC20(usdg).approve(d.adapter, bobBudget);
        uint256 bought = IVenueAdapter(d.adapter).swap(usdg, nvda, bobBudget, 0);
        IERC20(nvda).approve(Addresses.PERMIT2, type(uint256).max);
        vm.stopBroadcast();

        vm.startBroadcast(a.aliceKey);
        IERC20(usdg).approve(Addresses.PERMIT2, type(uint256).max);
        vm.stopBroadcast();

        vm.startBroadcast(a.solverKey);
        IERC20(usdg).approve(d.solvers, bond);
        SolverRegistry(d.solvers).bond(bond);
        vm.stopBroadcast();

        vm.startBroadcast(a.solverKey);
        IntentHasher hasher = new IntentHasher();
        vm.stopBroadcast();
        vm.writeFile(HASHER_PATH, vm.toString(address(hasher)));

        require(SolverRegistry(d.solvers).isActive(a.solver), "solver did not come up active");

        console2.log("alice usdg", IERC20(usdg).balanceOf(a.alice));
        console2.log("bob nvda bought on the pool", bought);
        console2.log("solver bonded", bond);
    }

    /// @notice Builds the solution, signs both intents, and submits it.
    /// @param batchId The batch boundary, which has to be a multiple of the weekend
    /// batch duration and outside the guard band.
    /// @param starve When true the clearing price is set to the venue quote itself,
    /// so the batch produces no surplus and finalizes as a pass through. That is the
    /// second demo screen, and it has to be deterministic rather than waited for.
    function submit(uint64 batchId, bool starve) external {
        Deployed memory d = _deployed();
        Actors memory a = _actors();
        Solution memory s = _build(d, a, batchId, starve);

        vm.startBroadcast(a.solverKey);
        Settlement(d.settlement).submitSolution(s);
        vm.stopBroadcast();

        (bytes32 hash, uint256 savings,) = Settlement(d.settlement).bestSolution(batchId);
        require(hash == keccak256(abi.encode(s)), "the submitted solution is not the best one");
        console2.log("batch", batchId);
        console2.log("savings in usd, 18 decimals", savings);
    }

    /// @notice Executes the winning solution. The solution is rebuilt rather than
    /// carried over, and the hash is checked against the one the contract stored,
    /// which is also what proves the pool has not moved underneath the demo.
    function finalize(uint64 batchId, bool starve) external {
        Deployed memory d = _deployed();
        Actors memory a = _actors();
        Solution memory s = _build(d, a, batchId, starve);

        (bytes32 stored,,) = Settlement(d.settlement).bestSolution(batchId);
        require(stored == keccak256(abi.encode(s)), "pool moved between submit and finalize");

        vm.startBroadcast(a.solverKey);
        Settlement(d.settlement).finalize(batchId, s);
        vm.stopBroadcast();

        console2.log("finalized", batchId);
        console2.log("alice nvda", IERC20(Addresses.NVDA).balanceOf(a.alice));
        console2.log("bob usdg", IERC20(Addresses.quote()).balanceOf(a.bob));
    }

    /// @notice Writes what the screens need to read, including the fork block. The
    /// block number is not decoration. demo.md section 1 stakes the whole demo on a
    /// judge recomputing the baseline, and without the block there is nothing to
    /// recompute it against.
    function report(uint64 settled, uint64 passthrough, uint256 forkBlock) external {
        Deployed memory d = _deployed();
        Actors memory a = _actors();

        string memory out = "demo";
        vm.serializeUint(out, "forkBlock", forkBlock);
        vm.serializeUint(out, "chainId", block.chainid);
        vm.serializeUint(out, "settledBatch", settled);
        vm.serializeUint(out, "passthroughBatch", passthrough);
        vm.serializeAddress(out, "settlement", d.settlement);
        vm.serializeAddress(out, "auctionHouse", d.auctionHouse);
        vm.serializeAddress(out, "adapter", d.adapter);
        vm.serializeAddress(out, "oracle", d.oracle);
        vm.serializeAddress(out, "pool", Addresses.POOL_NVDA);
        vm.serializeAddress(out, "usdg", Addresses.quote());
        vm.serializeAddress(out, "nvda", Addresses.NVDA);
        vm.serializeAddress(out, "alice", a.alice);
        vm.serializeAddress(out, "bob", a.bob);
        string memory json = vm.serializeAddress(out, "solver", a.solver);

        vm.writeJson(json, "deployments/demo.json");
        console2.log("wrote deployments/demo.json at fork block", forkBlock);
    }

    /// @dev The whole solution, derived from live state rather than written down.
    /// Every number here comes from the oracle or the pool at the current block, so
    /// the same function called twice in the same state produces the same bytes,
    /// which is what lets finalize rebuild what submit stored.
    function _build(Deployed memory d, Actors memory a, uint64 batchId, bool starve)
        internal
        view
        returns (Solution memory s)
    {
        address usdg = Addresses.quote();
        address nvda = Addresses.NVDA;

        Session session = ISessionManager(d.sessions).sessionAt(batchId);
        require(
            session == Session.CLOSED_WEEKEND || session == Session.CLOSED_OVERNIGHT,
            "batch is not in a closed session"
        );

        // USDG sits at index zero because the verifier prices every pair against
        // the numeraire at that index. desain-kliring.md section 8.
        s.tokens = new address[](2);
        s.tokens[0] = usdg;
        s.tokens[1] = nvda;

        // The clearing price comes from the pool, not from the oracle. A pair of
        // netted intents only beats the venue when the price they clear at sits
        // inside the venue's own spread, and the oracle mid can sit outside it. The
        // oracle's job here is the band check, which Settlement applies on its own.
        uint256 askOut = IVenueAdapter(d.adapter).quoteFromState(usdg, nvda, SELL_USDG);
        uint256 bidOut = IVenueAdapter(d.adapter).quoteFromState(nvda, usdg, askOut);

        s.prices = new uint256[](2);
        s.prices[0] = _unitPrice(d.oracle, usdg, 6);

        uint256 buyNvda;
        if (starve) {
            buyNvda = askOut;
        } else {
            // Half the round trip to each side. Alice pays less than the ask and Bob
            // receives more than the bid, which is the whole of what netting is.
            buyNvda = (askOut * (2 * SELL_USDG)) / (SELL_USDG + bidOut);
            require(buyNvda > askOut, "netting did not beat the pool");
        }

        // Derived from the clearing rather than read, so the uniform price check
        // holds exactly. Settlement still rejects it if it falls outside the band
        // the session allows around the oracle.
        s.prices[1] = (SELL_USDG * s.prices[0]) / buyNvda;
        uint256 oracleNvda = _unitPrice(d.oracle, nvda, 18);
        uint256 gap = s.prices[1] > oracleNvda ? s.prices[1] - oracleNvda : oracleNvda - s.prices[1];
        require(
            gap * BPS <= oracleNvda * ISessionManager(d.sessions).maxDeviationBps(session),
            "the pool and the oracle are too far apart to clear"
        );

        uint256 venueOutNvda = askOut;
        uint256 venueOutUsdg = IVenueAdapter(d.adapter).quoteFromState(nvda, usdg, buyNvda);

        uint256 buyUsdg;
        if (starve) {
            buyUsdg = SELL_USDG;
        } else {
            uint256 surplusUsd = ((buyNvda - venueOutNvda) * s.prices[1]) / WAD
                + ((SELL_USDG - venueOutUsdg) * s.prices[0]) / WAD;
            uint256 feeUsdg = (surplusUsd * WAD) / (s.prices[0] * WITHHOLD_SHARE_OF_SURPLUS);
            require(SELL_USDG > feeUsdg, "the fee is larger than the leg it came from");
            buyUsdg = SELL_USDG - feeUsdg;
        }
        require(buyUsdg > venueOutUsdg, "the sell side did not beat the pool");
        require(buyUsdg <= SELL_USDG, "usdg is not conserved");

        s.intents = new Intent[](2);
        s.intents[0] = _intent(a.alice, usdg, nvda, SELL_USDG, buyNvda, batchId, 1);
        s.intents[1] = _intent(a.bob, nvda, usdg, buyNvda, buyUsdg, batchId, 2);

        s.signatures = new bytes[](2);
        s.signatures[0] = _sign(a.aliceKey, d.settlement, s.intents[0]);
        s.signatures[1] = _sign(a.bobKey, d.settlement, s.intents[1]);

        s.executions = new Execution[](2);
        s.executions[0] = Execution({intentIndex: 0, executedSell: SELL_USDG, executedBuy: buyNvda});
        s.executions[1] = Execution({intentIndex: 1, executedSell: buyNvda, executedBuy: buyUsdg});

        s.venueCalls = new VenueCall[](0);

        s.baselineQuotes = new uint256[](2);
        s.baselineQuotes[0] = venueOutNvda;
        s.baselineQuotes[1] = venueOutUsdg;

        s.solver = a.solver;
        s.batchId = batchId;
        s.claimedSavings =
            ((buyNvda - venueOutNvda) * s.prices[1]) / WAD + ((buyUsdg - venueOutUsdg) * s.prices[0]) / WAD;
    }

    /// @dev USD with eighteen decimals per smallest unit, which is the convention
    /// the verifier works in. A price per whole token is off by twelve orders of
    /// magnitude the moment USDG is on one side of the pair.
    function _unitPrice(address oracle, address token, uint8 decimals) internal view returns (uint256) {
        (uint256 price,, bool healthy) = IPriceOracle(oracle).refPrice(token);
        require(healthy, "oracle is not healthy for this token");
        return (price * WAD) / (10 ** decimals);
    }

    function _intent(
        address owner,
        address sellToken,
        address buyToken,
        uint256 sellAmount,
        uint256 minBuy,
        uint64 batchId,
        uint256 nonce
    ) internal pure returns (Intent memory i) {
        i = Intent({
            owner: owner,
            receiver: owner,
            sellToken: sellToken,
            buyToken: buyToken,
            sellAmount: sellAmount,
            minBuyAmount: minBuy,
            validAfter: 0,
            // forge-lint: disable-next-line(unsafe-typecast)
            validUntil: uint32(batchId + 1 hours),
            flags: 0,
            kind: 0,
            maxDevFromRefBps: 0,
            allowedSessions: SessionMask.CLOSED_WEEKEND | SessionMask.CLOSED_OVERNIGHT,
            batchSpan: 1,
            nonce: nonce
        });
    }

    /// @dev Permit2 binds the signature to whoever will call it, so the spender is
    /// Settlement and nothing else can spend this.
    function _sign(uint256 key, address settlement, Intent memory i) internal view returns (bytes memory) {
        bytes32 digest = Permit2Witness.digest(
            ISignatureTransfer(Addresses.PERMIT2).DOMAIN_SEPARATOR(),
            Permit2Witness.typeHash(Settlement(settlement).WITNESS_TYPE_STRING()),
            i.sellToken,
            i.sellAmount,
            settlement,
            i.nonce,
            i.validUntil,
            IntentHasher(vm.parseAddress(vm.readFile(HASHER_PATH))).hashOf(i)
        );
        (uint8 v, bytes32 r, bytes32 sig) = vm.sign(key, digest);
        return abi.encodePacked(r, sig, v);
    }
}
