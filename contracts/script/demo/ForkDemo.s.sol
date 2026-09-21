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
///
/// The fork itself is not made here. It is the one infra/Makefile starts and deploys
/// to, and the accounts are the ones make fund hands tokens to. Two harnesses on two
/// forks would each be right about a different chain state, and the receipt the demo
/// shows would not be the receipt the coordinator produced.
contract ForkDemo is Script {
    string internal constant PIN_FILE = "../infra/pinned-block.json";
    string internal constant ACCOUNTS_FILE = "../infra/accounts.json";
    string internal constant DEPLOYMENT_FILE = "../infra/fork-deployment.json";

    /// Written by prepare and read by every later stage, because a script contract is
    /// ephemeral and cannot hash a solution it is holding in memory.
    string internal constant HASHER_PATH = "deployments/demo-hasher.txt";

    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;

    /// The fee is taken as a share of the surplus rather than as a fixed number of
    /// basis points, because Settlement caps it at twenty percent of the surplus
    /// and a fixed withholding reverts the whole batch the moment the pool happens
    /// to be tight. An eighth leaves room under both ceilings. parameter.md 4C.
    uint256 internal constant WITHHOLD_SHARE_OF_SURPLUS = 8;

    /// Alice's leg is sized from the cap the session actually allows rather than
    /// written down, and this fraction is what is left for it. Both legs count
    /// towards the same cap, so two fifths of it on the sell side puts the batch at
    /// about eighty percent of the ceiling with room for the pool to move.
    uint256 internal constant SELL_SHARE_OF_CAP_NUM = 2;
    uint256 internal constant SELL_SHARE_OF_CAP_DEN = 5;

    /// Enough for Alice to have a leg at all. The real size is computed per session.
    uint256 internal constant MIN_ALICE_USDG = 100e6;

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
        string memory record = vm.readFile(DEPLOYMENT_FILE);
        d.timelock = vm.parseJsonAddress(record, ".timelock");
        d.sessions = vm.parseJsonAddress(record, ".sessions");
        d.oracle = vm.parseJsonAddress(record, ".oracle");
        d.settlement = vm.parseJsonAddress(record, ".settlement");
        d.auctionHouse = vm.parseJsonAddress(record, ".auctionHouse");
        d.solvers = vm.parseJsonAddress(record, ".solvers");
        d.adapter = vm.parseJsonAddress(record, ".adapter");
    }

    /// @dev The two traders and the solver are the accounts the backend already
    /// funds, read from the file that names them rather than derived from labels
    /// here. Anvil's own defaults cannot be used on this chain at all, because their
    /// keys are public and somebody has left an EIP-7702 delegation on every one of
    /// them on mainnet 4663. Permit2 sees the code, takes the EIP-1271 path instead
    /// of ecrecover, and rejects a perfectly good signature with an empty revert.
    function _actors() internal view returns (Actors memory a) {
        string memory accounts = vm.readFile(ACCOUNTS_FILE);
        string memory mnemonic = vm.parseJsonString(accounts, "._mnemonic");

        a.alice = vm.parseJsonAddress(accounts, ".users[0]");
        a.bob = vm.parseJsonAddress(accounts, ".users[1]");
        a.solver = vm.parseJsonAddress(accounts, ".solverA");

        // Transactions go through auto impersonation and need no key, but a Permit2
        // witness is signed rather than sent, so these three do. The index is found
        // rather than written down, because the order of the accounts in that file
        // belongs to whoever maintains it.
        a.aliceKey = _keyFor(mnemonic, a.alice);
        a.bobKey = _keyFor(mnemonic, a.bob);
        a.solverKey = _keyFor(mnemonic, a.solver);
    }

    function _keyFor(string memory mnemonic, address who) internal pure returns (uint256) {
        for (uint32 index = 0; index < 20; ++index) {
            uint256 key = vm.deriveKey(mnemonic, index);
            if (vm.addr(key) == who) return key;
        }
        revert("no derivation index in infra/accounts.json produces this address");
    }

    /// @notice Checks the fork is actually ready for a batch, then deploys the one
    /// helper the signing needs.
    ///
    /// Nothing here hands anybody anything. Tokens, gas, the Permit2 approvals and
    /// the solver bond all arrive through make fund, which pulls them out of the real
    /// pools and then proves the baseline quote did not move. This stage only refuses
    /// to continue when one of those is missing, because every symptom of a half
    /// funded fork shows up much later as a revert with no reason string.
    function prepare() external {
        Deployed memory d = _deployed();
        Actors memory a = _actors();

        address usdg = Addresses.quote();
        address nvda = Addresses.NVDA;

        require(a.alice.code.length == 0, "alice carries code, so permit2 will take the eip-1271 path");
        require(a.bob.code.length == 0, "bob carries code, so permit2 will take the eip-1271 path");
        require(a.solver.code.length == 0, "solver carries code");

        require(IERC20(usdg).balanceOf(a.alice) >= MIN_ALICE_USDG, "alice is short of usdg. run make fund");
        require(IERC20(nvda).balanceOf(a.bob) > 0, "bob holds no nvda. run make fund");
        require(IERC20(usdg).allowance(a.alice, Addresses.PERMIT2) >= MIN_ALICE_USDG, "alice has not approved permit2");
        require(IERC20(nvda).allowance(a.bob, Addresses.PERMIT2) > 0, "bob has not approved permit2");
        require(SolverRegistry(d.solvers).isActive(a.solver), "the solver is not bonded. run make fund");

        vm.startBroadcast(a.solver);
        IntentHasher hasher = new IntentHasher();
        vm.stopBroadcast();
        vm.writeFile(HASHER_PATH, vm.toString(address(hasher)));

        console2.log("alice usdg", IERC20(usdg).balanceOf(a.alice));
        console2.log("bob nvda", IERC20(nvda).balanceOf(a.bob));
        console2.log("hasher", address(hasher));
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
    function report(uint64 settled, uint64 passthrough) external {
        Deployed memory d = _deployed();
        Actors memory a = _actors();
        uint256 forkBlock = vm.parseJsonUint(vm.readFile(PIN_FILE), ".block");

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
        s.prices = new uint256[](2);
        s.prices[0] = _unitPrice(d.oracle, usdg, 6);

        uint256 sellUsdg = _sellSize(d, session, s.prices[0]);
        uint256 askOut = IVenueAdapter(d.adapter).quoteFromState(usdg, nvda, sellUsdg);
        uint256 bidOut = IVenueAdapter(d.adapter).quoteFromState(nvda, usdg, askOut);

        uint256 buyNvda;
        if (starve) {
            buyNvda = askOut;
        } else {
            // Half the round trip to each side. Alice pays less than the ask and Bob
            // receives more than the bid, which is the whole of what netting is.
            buyNvda = (askOut * (2 * sellUsdg)) / (sellUsdg + bidOut);
            require(buyNvda > askOut, "netting did not beat the pool");
        }

        // Derived from the clearing rather than read, so the uniform price check
        // holds exactly. Settlement still rejects it if it falls outside the band
        // the session allows around the oracle.
        s.prices[1] = (sellUsdg * s.prices[0]) / buyNvda;
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
            buyUsdg = sellUsdg;
        } else {
            uint256 surplusUsd = ((buyNvda - venueOutNvda) * s.prices[1]) / WAD
                + ((sellUsdg - venueOutUsdg) * s.prices[0]) / WAD;
            uint256 feeUsdg = (surplusUsd * WAD) / (s.prices[0] * WITHHOLD_SHARE_OF_SURPLUS);
            require(sellUsdg > feeUsdg, "the fee is larger than the leg it came from");
            buyUsdg = sellUsdg - feeUsdg;
        }
        require(buyUsdg > venueOutUsdg, "the sell side did not beat the pool");
        require(buyUsdg <= sellUsdg, "usdg is not conserved");

        s.intents = new Intent[](2);
        s.intents[0] = _intent(a.alice, usdg, nvda, sellUsdg, buyNvda, batchId, 1);
        s.intents[1] = _intent(a.bob, nvda, usdg, buyNvda, buyUsdg, batchId, 2);

        s.signatures = new bytes[](2);
        s.signatures[0] = _sign(a.aliceKey, d.settlement, s.intents[0]);
        s.signatures[1] = _sign(a.bobKey, d.settlement, s.intents[1]);

        s.executions = new Execution[](2);
        s.executions[0] = Execution({intentIndex: 0, executedSell: sellUsdg, executedBuy: buyNvda});
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

    /// @dev How much USDG Alice sells, read from the cap rather than written down.
    ///
    /// Both legs of a netted batch count towards the same per batch cap, and the cap
    /// is halved again in a weekend, holiday or protective session. A size that fits
    /// on a weekday overnight is therefore refused on a Saturday with
    /// ExposureCapExceeded, which is a fine thing for the protocol to do and a poor
    /// thing for a demo to discover on stage. Settlement 538.
    function _sellSize(Deployed memory d, Session session, uint256 quotePrice) internal view returns (uint256) {
        uint256 scale =
            session == Session.CLOSED_WEEKEND || session == Session.HOLIDAY || session == Session.PROTECTIVE ? 1 : 2;
        uint256 capUsd = (Settlement(d.settlement).capPerBatchUsd() * scale) / 2;
        uint256 legUsd = (capUsd * SELL_SHARE_OF_CAP_NUM) / SELL_SHARE_OF_CAP_DEN;

        // Down to a whole USDG so the number on screen is one somebody can repeat.
        uint256 sell = ((legUsd * WAD) / quotePrice / 1e6) * 1e6;
        require(sell >= MIN_ALICE_USDG, "the session cap leaves nothing to trade");
        return sell;
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
