// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
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
import {DemoBase} from "./DemoBase.sol";
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
contract ForkDemo is DemoBase {
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

    /// Alice's share of the routed batch. Uneven on purpose, so the screen shows two
    /// different fills at one price rather than two numbers that look copied.
    uint256 internal constant ALICE_SHARE_OF_ROUTED_BPS = 6000;

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

        require(a.users[0].code.length == 0, "alice carries code, so permit2 will take the eip-1271 path");
        require(a.users[1].code.length == 0, "bob carries code, so permit2 will take the eip-1271 path");
        require(a.solvers[0].code.length == 0, "solver carries code");

        require(IERC20(usdg).balanceOf(a.users[0]) >= MIN_ALICE_USDG, "alice is short of usdg. run make fund");
        require(IERC20(nvda).balanceOf(a.users[1]) > 0, "bob holds no nvda. run make fund");
        require(IERC20(usdg).balanceOf(a.users[1]) >= MIN_ALICE_USDG, "bob is short of usdg. run make fund");
        require(
            IERC20(usdg).allowance(a.users[0], Addresses.PERMIT2) >= MIN_ALICE_USDG,
            "alice has not approved permit2"
        );
        require(IERC20(nvda).allowance(a.users[1], Addresses.PERMIT2) > 0, "bob has not approved permit2");
        require(SolverRegistry(d.solvers).isActive(a.solvers[0]), "the solver is not bonded. run make fund");

        vm.startBroadcast(a.solvers[0]);
        IntentHasher hasher = new IntentHasher();
        vm.stopBroadcast();
        vm.writeFile(HASHER_PATH, vm.toString(address(hasher)));

        console2.log("alice usdg", IERC20(usdg).balanceOf(a.users[0]));
        console2.log("bob nvda", IERC20(nvda).balanceOf(a.users[1]));
        console2.log("hasher", address(hasher));
    }

    /// @notice Builds the solution, signs both intents, and submits it.
    /// @param batchId The batch boundary, which has to be a multiple of the weekend
    /// batch duration and outside the guard band.
    /// @param routed When true both intents sit on the same side and the whole
    /// volume goes to the venue, so the batch saves nothing and finalizes as a pass
    /// through. That is the second demo screen, and it has to be built rather than
    /// waited for.
    function submit(uint64 batchId, bool routed) external {
        Deployed memory d = _deployed();
        Actors memory a = _actors();
        Solution memory s = _build(d, a, batchId, routed);

        vm.startBroadcast(a.solverKeys[0]);
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
    function finalize(uint64 batchId, bool routed) external {
        Deployed memory d = _deployed();
        Actors memory a = _actors();
        Solution memory s = _build(d, a, batchId, routed);

        (bytes32 stored,,) = Settlement(d.settlement).bestSolution(batchId);
        require(stored == keccak256(abi.encode(s)), "pool moved between submit and finalize");

        vm.startBroadcast(a.solverKeys[0]);
        Settlement(d.settlement).finalize(batchId, s);
        vm.stopBroadcast();

        console2.log("finalized", batchId);
        console2.log("alice nvda", IERC20(Addresses.NVDA).balanceOf(a.users[0]));
        console2.log("bob usdg", IERC20(Addresses.quote()).balanceOf(a.users[1]));
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
        vm.serializeAddress(out, "alice", a.users[0]);
        vm.serializeAddress(out, "bob", a.users[1]);
        string memory json = vm.serializeAddress(out, "solver", a.solvers[0]);

        vm.writeJson(json, "deployments/demo.json");
        console2.log("wrote deployments/demo.json at fork block", forkBlock);
    }

    /// @dev The whole solution, derived from live state rather than written down.
    /// Every number here comes from the oracle or the pool at the current block, so
    /// the same function called twice in the same state produces the same bytes,
    /// which is what lets finalize rebuild what submit stored.
    function _build(Deployed memory d, Actors memory a, uint64 batchId, bool routed)
        internal
        view
        returns (Solution memory s)
    {
        Session session = _session(d, batchId);
        return routed ? _buildRouted(d, a, batchId, session) : _buildNetted(d, a, batchId, session);
    }

    function _session(Deployed memory d, uint64 batchId) internal view returns (Session session) {
        session = ISessionManager(d.sessions).sessionAt(batchId);
        require(
            session == Session.CLOSED_WEEKEND || session == Session.CLOSED_OVERNIGHT,
            "batch is not in a closed session"
        );
    }

    function _buildNetted(Deployed memory d, Actors memory a, uint64 batchId, Session session)
        internal
        view
        returns (Solution memory s)
    {
        address usdg = Addresses.quote();
        address nvda = Addresses.NVDA;

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

        // Half the round trip to each side. Alice pays less than the ask and Bob
        // receives more than the bid, which is the whole of what netting is.
        uint256 buyNvda = (askOut * (2 * sellUsdg)) / (sellUsdg + bidOut);
        require(buyNvda > askOut, "netting did not beat the pool");

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

        uint256 surplusUsd =
            ((buyNvda - venueOutNvda) * s.prices[1]) / WAD + ((sellUsdg - venueOutUsdg) * s.prices[0]) / WAD;
        uint256 feeUsdg = (surplusUsd * WAD) / (s.prices[0] * WITHHOLD_SHARE_OF_SURPLUS);
        require(sellUsdg > feeUsdg, "the fee is larger than the leg it came from");
        uint256 buyUsdg = sellUsdg - feeUsdg;
        require(buyUsdg > venueOutUsdg, "the sell side did not beat the pool");
        require(buyUsdg <= sellUsdg, "usdg is not conserved");

        s.intents = new Intent[](2);
        s.intents[0] = _intent(a.users[0], usdg, nvda, sellUsdg, buyNvda, batchId, _nonce(batchId, 0));
        s.intents[1] = _intent(a.users[1], nvda, usdg, buyNvda, buyUsdg, batchId, _nonce(batchId, 1));

        s.signatures = new bytes[](2);
        s.signatures[0] = _sign(a.userKeys[0], d.settlement, s.intents[0]);
        s.signatures[1] = _sign(a.userKeys[1], d.settlement, s.intents[1]);

        s.executions = new Execution[](2);
        s.executions[0] = Execution({intentIndex: 0, executedSell: sellUsdg, executedBuy: buyNvda});
        s.executions[1] = Execution({intentIndex: 1, executedSell: buyNvda, executedBuy: buyUsdg});

        s.venueCalls = new VenueCall[](0);

        s.baselineQuotes = new uint256[](2);
        s.baselineQuotes[0] = venueOutNvda;
        s.baselineQuotes[1] = venueOutUsdg;

        s.solver = a.solvers[0];
        s.batchId = batchId;
        s.claimedSavings =
            ((buyNvda - venueOutNvda) * s.prices[1]) / WAD + ((buyUsdg - venueOutUsdg) * s.prices[0]) / WAD;
    }

    /// @dev The batch that saves nothing, and the only honest way to build one.
    ///
    /// A netted batch cannot be made to lose. Both counterparties skip the round
    /// trip the pool would have charged twice, so whatever price they clear at, the
    /// pair is better off than trading separately. Pricing it badly does not produce
    /// a pass through, it produces a batch that fails a check.
    ///
    /// What does produce one is two intents on the same side. There is nothing to
    /// net, the whole volume goes to the venue in one call, and each intent receives
    /// its share of what the venue returned. Savings are not small here. They are
    /// zero, by construction, and the contract says so itself rather than being told.
    ///
    /// The floor Settlement holds a solver to is one quote per pair direction on the
    /// gross volume, so the single combined call is also exactly the number that
    /// floor is computed from. Settlement 340.
    function _buildRouted(Deployed memory d, Actors memory a, uint64 batchId, Session session)
        internal
        view
        returns (Solution memory s)
    {
        address usdg = Addresses.quote();
        address nvda = Addresses.NVDA;

        s.tokens = new address[](2);
        s.tokens[0] = usdg;
        s.tokens[1] = nvda;

        s.prices = new uint256[](2);
        s.prices[0] = _unitPrice(d.oracle, usdg, 6);

        uint256 total = _sellSize(d, session, s.prices[0]);
        uint256 sellAlice = ((total * ALICE_SHARE_OF_ROUTED_BPS) / BPS / 1e6) * 1e6;
        uint256 sellBob = total - sellAlice;
        require(sellBob > 0, "the routed batch left bob with nothing to sell");

        uint256 out = IVenueAdapter(d.adapter).quoteFromState(usdg, nvda, total);
        require(out > 0, "the venue will not quote the routed volume");

        // Alice is floored and Bob takes the remainder, so the two deliveries add up
        // to exactly what the venue returned. That matters more than it looks. A
        // batch that saves nothing may not withhold anything either, because the fee
        // cap is a share of the surplus and a share of zero is zero, so a single wei
        // left behind reverts the whole thing with FeeExceedsCap.
        uint256 buyAlice = (out * sellAlice) / total;
        uint256 buyBob = out - buyAlice;

        // The uniform price is the worse of the two prices the split implies, not
        // the average of them. Bob holds the remainder, so at the average his side
        // is worth a shade more than he sold and the verifier rejects it as non
        // uniform before it ever looks at the size of the difference. The gap
        // between the two is one wei of NVDA across the whole batch.
        uint256 impliedAlice = (sellAlice * s.prices[0]) / buyAlice;
        uint256 impliedBob = (sellBob * s.prices[0]) / buyBob;
        s.prices[1] = impliedAlice < impliedBob ? impliedAlice : impliedBob;
        _requireWithinBand(d, session, nvda, s.prices[1]);

        s.intents = new Intent[](2);
        s.intents[0] = _intent(a.users[0], usdg, nvda, sellAlice, buyAlice, batchId, _nonce(batchId, 0));
        s.intents[1] = _intent(a.users[1], usdg, nvda, sellBob, buyBob, batchId, _nonce(batchId, 1));

        s.signatures = new bytes[](2);
        s.signatures[0] = _sign(a.userKeys[0], d.settlement, s.intents[0]);
        s.signatures[1] = _sign(a.userKeys[1], d.settlement, s.intents[1]);

        s.executions = new Execution[](2);
        s.executions[0] = Execution({intentIndex: 0, executedSell: sellAlice, executedBuy: buyAlice});
        s.executions[1] = Execution({intentIndex: 1, executedSell: sellBob, executedBuy: buyBob});

        // minOut is what Settlement credits the batch with, not what the swap
        // happens to return, so it is the quote itself. The adapter is exact
        // against the real swap, which test/fork/UniswapV3AdapterFork proves.
        s.venueCalls = new VenueCall[](1);
        s.venueCalls[0] =
            VenueCall({adapter: d.adapter, tokenIn: usdg, tokenOut: nvda, amountIn: total, minOut: out});

        // Each intent received exactly what the venue gave it, so each baseline is
        // its own execution and the two add up to the floor for the pair.
        s.baselineQuotes = new uint256[](2);
        s.baselineQuotes[0] = buyAlice;
        s.baselineQuotes[1] = buyBob;

        s.solver = a.solvers[0];
        s.batchId = batchId;
        s.claimedSavings = 0;
    }

    function _requireWithinBand(Deployed memory d, Session session, address token, uint256 price)
        internal
        view
    {
        uint256 ref = _unitPrice(d.oracle, token, 18);
        uint256 gap = price > ref ? price - ref : ref - price;
        require(
            gap * BPS <= ref * ISessionManager(d.sessions).maxDeviationBps(session),
            "the pool and the oracle are too far apart to clear"
        );
    }

    /// @dev Permit2 nonces are a bitmap per owner, so a rerun against the same fork
    /// would replay the numbers a previous batch already burned. Keying them to the
    /// batch means the same run can be repeated at a later boundary without anyone
    /// having to remember which numbers are gone.
    function _nonce(uint64 batchId, uint256 slot) internal pure returns (uint256) {
        return uint256(batchId) * 4 + slot;
    }

    /// @dev How much USDG Alice sells, read from the cap rather than written down.
    ///
    /// Both legs of a netted batch count towards the same per batch cap, and the cap
    /// is halved again in a weekend, holiday or protective session. A size that fits
    /// on a weekday overnight is therefore refused on a Saturday with
    /// ExposureCapExceeded, which is a fine thing for the protocol to do and a poor
    /// thing for a demo to discover on stage. Settlement 538.
    function _sellSize(Deployed memory d, Session session, uint256 quotePrice)
        internal
        view
        returns (uint256)
    {
        uint256 scale = session == Session.CLOSED_WEEKEND || session == Session.HOLIDAY
            || session == Session.PROTECTIVE
            ? 1
            : 2;
        uint256 capUsd = (Settlement(d.settlement).capPerBatchUsd() * scale) / 2;
        uint256 legUsd = (capUsd * SELL_SHARE_OF_CAP_NUM) / SELL_SHARE_OF_CAP_DEN;

        // Down to a whole USDG so the number on screen is one somebody can repeat.
        uint256 sell = ((legUsd * WAD) / quotePrice / 1e6) * 1e6;
        require(sell >= MIN_ALICE_USDG, "the session cap leaves nothing to trade");
        return sell;
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

    function _sign(uint256 key, address settlement, Intent memory i) internal view returns (bytes memory) {
        return _signFor(key, settlement, _settlementTypeHash(settlement), i);
    }
}
