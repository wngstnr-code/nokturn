// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Settlement} from "../../src/Settlement.sol";
import {SessionManager} from "../../src/SessionManager.sol";
import {SolverRegistry} from "../../src/SolverRegistry.sol";
import {IPriceOracle} from "../../src/interfaces/IPriceOracle.sol";
import {ISignatureTransfer} from "../../src/interfaces/IPermit2.sol";
import {IVenueAdapter} from "../../src/interfaces/IVenueAdapter.sol";
import {Permit2Witness} from "../../src/libraries/Permit2Witness.sol";
import {Execution, Intent, Solution, VenueCall} from "../../src/types/Types.sol";
import {Addresses} from "../Addresses.sol";
import {IntentHasher} from "../demo/IntentHasher.sol";
import {TestQuoteToken} from "./TestQuoteToken.sol";
import {TestStockToken} from "./TestStockToken.sol";

/// @title One real batch on chain 46630, without the app or the solver service
/// @notice A batch that settles here proves the contracts and the fixtures work on
/// a live chain before the backend and the app are pointed at them. If a batch
/// later fails from the app, this narrows the fault to the layers above.
///
/// The three actors are throwaway keys derived from NOKTURN_SMOKE_MNEMONIC, which is
/// given at run time and never written to the repo or to .env. They hold test
/// tokens and testnet dust and nothing else. tools/smoke-testnet.sh drives it.
///
/// Settlement accepts a solution only in the ten seconds after a batch closes, so
/// build signs a solution for a batch in the future and prints the two calldatas.
/// The driver sends them with cast at the right second, because a forge run takes
/// longer than the window.
contract TestnetSmoke is Script {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;

    /// Same rule as ForkDemo. Withhold an eighth of the surplus as the fee.
    uint256 internal constant WITHHOLD_SHARE_OF_SURPLUS = 8;

    uint256 internal constant SIZE_QUOTE = 100e6;
    uint256 internal constant ACTOR_GAS = 0.0002 ether;
    uint256 internal constant ACTOR_QUOTE = 10_000e6;
    uint256 internal constant ACTOR_STOCK = 10e18;

    struct Deployed {
        Settlement settlement;
        SessionManager sessions;
        SolverRegistry registry;
        IPriceOracle oracle;
        IVenueAdapter adapter;
    }

    struct Keys {
        uint256 solver;
        uint256 alice;
        uint256 bob;
    }

    function addresses() external view {
        Keys memory k = _keys();
        console2.log("solver", vm.addr(k.solver));
        console2.log("alice ", vm.addr(k.alice));
        console2.log("bob   ", vm.addr(k.bob));
    }

    /// @notice Bonds the solver and readies both users. Safe to rerun, it only does
    /// what is still missing.
    function prepare() external {
        require(block.chainid == Addresses.TESTNET, "the smoke run is for 46630 only");
        Deployed memory d = _deployed();
        Keys memory k = _keys();
        TestQuoteToken quote = TestQuoteToken(Addresses.TESTNET_QUOTE);
        TestStockToken nvda = TestStockToken(Addresses.TESTNET_NVDA);
        address solver = vm.addr(k.solver);

        vm.startBroadcast(k.solver);
        uint256 minBond = d.registry.minBond();
        (uint256 bonded,) = d.registry.bondOf(solver);
        if (bonded < minBond) {
            quote.mint(solver, minBond - bonded);
            quote.approve(address(d.registry), minBond - bonded);
            d.registry.bond(minBond - bonded);
        }
        address[2] memory users = [vm.addr(k.alice), vm.addr(k.bob)];
        for (uint256 u = 0; u < 2; ++u) {
            if (users[u].balance < ACTOR_GAS / 2) payable(users[u]).transfer(ACTOR_GAS);
            if (quote.balanceOf(users[u]) < ACTOR_QUOTE / 2) quote.mint(users[u], ACTOR_QUOTE);
            if (nvda.balanceOf(users[u]) < ACTOR_STOCK / 2) nvda.mint(users[u], ACTOR_STOCK);
        }
        vm.stopBroadcast();

        uint256[2] memory userKeys = [k.alice, k.bob];
        for (uint256 u = 0; u < 2; ++u) {
            vm.startBroadcast(userKeys[u]);
            if (quote.allowance(users[u], Addresses.PERMIT2) == 0) {
                quote.approve(Addresses.PERMIT2, type(uint256).max);
            }
            if (nvda.allowance(users[u], Addresses.PERMIT2) == 0) {
                nvda.approve(Addresses.PERMIT2, type(uint256).max);
            }
            vm.stopBroadcast();
        }

        console2.log("solver active", d.registry.isActive(solver));
    }

    /// @notice Prints the submitSolution and finalize calldata for a batch that has
    /// not closed yet. Nothing is broadcast.
    function build(uint64 batchId, bool routed) external {
        require(block.chainid == Addresses.TESTNET, "the smoke run is for 46630 only");
        Deployed memory d = _deployed();
        Keys memory k = _keys();
        IntentHasher hasher = new IntentHasher();

        Solution memory s = routed ? _routed(d, batchId) : _netted(d, batchId);
        s.solver = vm.addr(k.solver);
        s.batchId = batchId;
        s.signatures = new bytes[](2);
        s.signatures[0] = _sign(d, hasher, k.alice, s.intents[0]);
        s.signatures[1] = _sign(d, hasher, k.bob, s.intents[1]);

        console2.log("batch", batchId);
        console2.log("claimedSavings", s.claimedSavings);
        console2.log("submit");
        console2.logBytes(abi.encodeCall(Settlement.submitSolution, (s)));
        console2.log("finalize");
        console2.logBytes(abi.encodeCall(Settlement.finalize, (batchId, s)));
    }

    /// @dev ForkDemo._buildRouted. Two buyers and no seller, so the whole volume
    /// goes through the testnet pool in one swap.
    function _routed(Deployed memory d, uint64 batchId) internal view returns (Solution memory s) {
        address quote = Addresses.TESTNET_QUOTE;
        address nvda = Addresses.TESTNET_NVDA;
        s.tokens = _pair(quote, nvda);
        s.prices = new uint256[](2);
        s.prices[0] = _unitPrice(d, quote, 6);

        uint256 sellAlice = (SIZE_QUOTE * 6000) / BPS;
        uint256 sellBob = SIZE_QUOTE - sellAlice;
        uint256 out = d.adapter.quoteFromState(quote, nvda, SIZE_QUOTE);
        uint256 buyAlice = (out * sellAlice) / SIZE_QUOTE;
        uint256 buyBob = out - buyAlice;

        uint256 impliedAlice = (sellAlice * s.prices[0]) / buyAlice;
        uint256 impliedBob = (sellBob * s.prices[0]) / buyBob;
        s.prices[1] = impliedAlice < impliedBob ? impliedAlice : impliedBob;
        _requireWithinBand(d, batchId, s.prices[1]);

        _legs(s, batchId, [sellAlice, sellBob], [buyAlice, buyBob], [nvda, nvda]);
        s.venueCalls = new VenueCall[](1);
        s.venueCalls[0] = VenueCall({
            adapter: address(d.adapter), tokenIn: quote, tokenOut: nvda, amountIn: SIZE_QUOTE, minOut: out
        });
        s.baselineQuotes = new uint256[](2);
        s.baselineQuotes[0] = buyAlice;
        s.baselineQuotes[1] = buyBob;
        s.claimedSavings = 0;
    }

    /// @dev ForkDemo._buildNetted. Alice buys what Bob sells, inside the pool's
    /// spread, and the pool is never called.
    function _netted(Deployed memory d, uint64 batchId) internal view returns (Solution memory s) {
        address quote = Addresses.TESTNET_QUOTE;
        address nvda = Addresses.TESTNET_NVDA;
        s.tokens = _pair(quote, nvda);
        s.prices = new uint256[](2);
        s.prices[0] = _unitPrice(d, quote, 6);

        uint256 askOut = d.adapter.quoteFromState(quote, nvda, SIZE_QUOTE);
        uint256 bidOut = d.adapter.quoteFromState(nvda, quote, askOut);
        uint256 buyNvda = (askOut * (2 * SIZE_QUOTE)) / (SIZE_QUOTE + bidOut);
        require(buyNvda > askOut, "netting did not beat the pool");

        s.prices[1] = (SIZE_QUOTE * s.prices[0]) / buyNvda;
        _requireWithinBand(d, batchId, s.prices[1]);

        uint256 venueOutQuote = d.adapter.quoteFromState(nvda, quote, buyNvda);
        uint256 surplusUsd =
            ((buyNvda - askOut) * s.prices[1]) / WAD + ((SIZE_QUOTE - venueOutQuote) * s.prices[0]) / WAD;
        uint256 buyQuote = SIZE_QUOTE - (surplusUsd * WAD) / (s.prices[0] * WITHHOLD_SHARE_OF_SURPLUS);
        require(buyQuote > venueOutQuote, "the sell side did not beat the pool");

        _legs(s, batchId, [SIZE_QUOTE, buyNvda], [buyNvda, buyQuote], [nvda, quote]);
        s.venueCalls = new VenueCall[](0);
        s.baselineQuotes = new uint256[](2);
        s.baselineQuotes[0] = askOut;
        s.baselineQuotes[1] = venueOutQuote;
        s.claimedSavings =
            ((buyNvda - askOut) * s.prices[1]) / WAD + ((buyQuote - venueOutQuote) * s.prices[0]) / WAD;
    }

    /// @dev Alice always sells the quote token. Bob sells whichever token he is not
    /// buying.
    function _legs(
        Solution memory s,
        uint64 batchId,
        uint256[2] memory sells,
        uint256[2] memory buys,
        address[2] memory buyTokens
    ) internal view {
        Keys memory k = _keys();
        address quote = Addresses.TESTNET_QUOTE;
        address bobSells = buyTokens[1] == quote ? Addresses.TESTNET_NVDA : quote;
        s.intents = new Intent[](2);
        s.intents[0] = _intent(vm.addr(k.alice), quote, buyTokens[0], sells[0], buys[0], batchId, 0);
        s.intents[1] = _intent(vm.addr(k.bob), bobSells, buyTokens[1], sells[1], buys[1], batchId, 1);
        s.executions = new Execution[](2);
        s.executions[0] = Execution({intentIndex: 0, executedSell: sells[0], executedBuy: buys[0]});
        s.executions[1] = Execution({intentIndex: 1, executedSell: sells[1], executedBuy: buys[1]});
    }

    function _intent(
        address owner,
        address sellToken,
        address buyToken,
        uint256 sellAmount,
        uint256 minBuy,
        uint64 batchId,
        uint256 slot
    ) internal pure returns (Intent memory) {
        return Intent({
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
            allowedSessions: type(uint8).max,
            batchSpan: 1,
            // Permit2 nonces are spent for good, so they are keyed to the batch and a
            // rerun at a later boundary never collides with an earlier one.
            nonce: (uint256(batchId) << 8) | slot
        });
    }

    function _sign(Deployed memory d, IntentHasher hasher, uint256 key, Intent memory i)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = Permit2Witness.digest(
            ISignatureTransfer(Addresses.PERMIT2).DOMAIN_SEPARATOR(),
            Permit2Witness.typeHash(d.settlement.WITNESS_TYPE_STRING()),
            i.sellToken,
            i.sellAmount,
            address(d.settlement),
            i.nonce,
            i.validUntil,
            hasher.hashOf(i)
        );
        (uint8 v, bytes32 r, bytes32 sig) = vm.sign(key, digest);
        return abi.encodePacked(r, sig, v);
    }

    function _requireWithinBand(Deployed memory d, uint64 batchId, uint256 price) internal view {
        uint256 ref = _unitPrice(d, Addresses.TESTNET_NVDA, 18);
        uint256 gap = price > ref ? price - ref : ref - price;
        require(
            gap * BPS <= ref * d.sessions.maxDeviationBps(d.sessions.sessionAt(batchId)),
            "the pool and the oracle are too far apart to clear"
        );
    }

    function _unitPrice(Deployed memory d, address token, uint8 decimals) internal view returns (uint256) {
        (uint256 price,, bool healthy) = d.oracle.refPrice(token);
        require(healthy, "oracle is not healthy for this token");
        return (price * WAD) / (10 ** decimals);
    }

    /// @dev The quote token sits at index zero because the verifier prices every
    /// pair against the numeraire there. desain-kliring.md section 8.
    function _pair(address quote, address stock) internal pure returns (address[] memory tokens) {
        tokens = new address[](2);
        tokens[0] = quote;
        tokens[1] = stock;
    }

    function _keys() internal view returns (Keys memory k) {
        string memory mnemonic = vm.envString("NOKTURN_SMOKE_MNEMONIC");
        k.solver = vm.deriveKey(mnemonic, 0);
        k.alice = vm.deriveKey(mnemonic, 1);
        k.bob = vm.deriveKey(mnemonic, 2);
    }

    function _deployed() internal view returns (Deployed memory d) {
        string memory record = vm.readFile(string.concat("deployments/", vm.toString(block.chainid), ".json"));
        d.settlement = Settlement(vm.parseJsonAddress(record, ".settlement"));
        d.sessions = SessionManager(vm.parseJsonAddress(record, ".sessions"));
        d.registry = SolverRegistry(vm.parseJsonAddress(record, ".solvers"));
        d.oracle = IPriceOracle(vm.parseJsonAddress(record, ".oracle"));
        d.adapter = IVenueAdapter(vm.parseJsonAddress(record, ".adapter"));
    }
}
