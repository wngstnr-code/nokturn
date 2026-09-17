// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AgentMandate} from "../../src/AgentMandate.sol";
import {MandateAccount} from "../../src/MandateAccount.sol";
import {PriceOracle} from "../../src/PriceOracle.sol";
import {SessionManager} from "../../src/SessionManager.sol";
import {ISignatureTransfer} from "../../src/interfaces/IPermit2.sol";
import {IntentLib} from "../../src/libraries/IntentLib.sol";
import {Permit2Witness} from "../../src/libraries/Permit2Witness.sol";
import {Intent, IntentFlags, Mandate} from "../../src/types/Types.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockPermit2} from "../mocks/MockPermit2.sol";

/// @notice Drives the agent mandate registry. Nine of the ten shapes it builds
/// break exactly one rule, because a handler that only ever signs conforming
/// intents would prove that conforming intents conform.
contract MandateHandler is Test {
    struct Attempt {
        bytes32 id;
        address account;
        bytes32 digest;
        bytes32 brokenRule;
        uint256 notionalUsd;
        uint256 nonce;
        bool accepted;
    }

    uint16 internal constant MANDATE_DEV_BPS = 50;
    uint8 internal constant MANDATE_SESSIONS = 0x3E; // everything but overnight and holiday

    AgentMandate public immutable mandates;
    SessionManager public immutable sessions;
    PriceOracle public immutable oracle;
    MockPermit2 public immutable permit2;
    MockERC20 public immutable quote;
    MockERC20 public immutable base;
    MockERC20 public immutable stranger;
    MockAggregator public immutable quoteFeed;
    MockAggregator public immutable baseFeed;
    address public immutable settlement;

    uint256 public immutable agentKey;
    uint256 public immutable impostorKey;
    address public immutable agent;

    address[3] public owners;

    bytes32[] internal ids;
    Attempt[] internal attempts;

    mapping(bytes32 => uint256) public maxPerBatch;
    mapping(bytes32 => uint256) public maxPerDay;
    mapping(bytes32 => address) public creator;
    mapping(bytes32 => bool) public auctionAllowed;

    uint256 public nextNonce;
    uint256 public acceptedCount;

    constructor(
        AgentMandate mandates_,
        SessionManager sessions_,
        PriceOracle oracle_,
        MockPermit2 permit2_,
        MockERC20 quote_,
        MockERC20 base_,
        MockERC20 stranger_,
        MockAggregator quoteFeed_,
        MockAggregator baseFeed_,
        address settlement_,
        uint256 agentKey_,
        uint256 impostorKey_
    ) {
        mandates = mandates_;
        sessions = sessions_;
        oracle = oracle_;
        permit2 = permit2_;
        quote = quote_;
        base = base_;
        stranger = stranger_;
        quoteFeed = quoteFeed_;
        baseFeed = baseFeed_;
        settlement = settlement_;
        agentKey = agentKey_;
        impostorKey = impostorKey_;
        agent = vm.addr(agentKey_);

        owners[0] = address(0x0E4E4);
        owners[1] = address(0x0E4E5);
        owners[2] = address(0x0E4E6);
    }

    function idCount() external view returns (uint256) {
        return ids.length;
    }

    function idAt(uint256 index) external view returns (bytes32) {
        return ids[index];
    }

    function attemptCount() external view returns (uint256) {
        return attempts.length;
    }

    function attemptAt(uint256 index) external view returns (Attempt memory) {
        return attempts[index];
    }

    function actCreateMandate(uint256 seed) external {
        if (ids.length >= 8) return;
        address owner = owners[bound(seed, 0, 2)];

        address[] memory tokens = new address[](2);
        tokens[0] = address(quote);
        tokens[1] = address(base);

        Mandate memory m = Mandate({
            owner: owner,
            agent: agent,
            allowedTokens: tokens,
            maxNotionalPerBatch: bound(seed >> 8, 100e18, 5000e18),
            maxNotionalPerDay: bound(seed >> 16, 5000e18, 50_000e18),
            maxDeviationFromRefBps: MANDATE_DEV_BPS,
            allowedSessions: MANDATE_SESSIONS,
            expiry: uint64(block.timestamp) + uint64(bound(seed >> 24, 1 days, 60 days)),
            auctionAllowed: seed & 1 == 0
        });

        vm.prank(owner);
        try mandates.createMandate(m) returns (bytes32 id) {
            ids.push(id);
            creator[id] = owner;
            maxPerBatch[id] = m.maxNotionalPerBatch;
            maxPerDay[id] = m.maxNotionalPerDay;
            auctionAllowed[id] = m.auctionAllowed;
        } catch {}
    }

    /// @notice Builds an intent that either conforms or breaks exactly one rule,
    /// signs it as the agent, and asks the registry to authorize it.
    function actAuthorize(uint256 seed) external {
        if (ids.length == 0) return;
        bytes32 id = ids[bound(seed, 0, ids.length - 1)];
        address account = mandates.accountOf(id);
        if (account == address(0)) return;

        uint8 shape = uint8(bound(seed >> 8, 0, 9));
        (Intent memory i, bytes32 rule) = _shape(id, account, shape, seed);

        bytes32 digest = _digest(i);
        uint256 key = shape == 9 ? impostorKey : agentKey;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);

        uint256 notional = mandates.notionalUsd(i.sellToken, i.sellAmount);

        try mandates.authorize(id, i, abi.encodePacked(r, s, v)) {
            acceptedCount += 1;
            attempts.push(
                Attempt({
                    id: id,
                    account: account,
                    digest: digest,
                    brokenRule: rule,
                    notionalUsd: notional,
                    nonce: i.nonce,
                    accepted: true
                })
            );
        } catch {
            attempts.push(
                Attempt({
                    id: id,
                    account: account,
                    digest: digest,
                    brokenRule: rule,
                    notionalUsd: notional,
                    nonce: i.nonce,
                    accepted: false
                })
            );
        }
    }

    function actRevoke(uint256 seed) external {
        if (ids.length == 0) return;
        bytes32 id = ids[bound(seed, 0, ids.length - 1)];
        vm.prank(creator[id]);
        try mandates.revokeMandate(id) {} catch {}
    }

    /// @notice Spends the Permit2 nonce the way the settlement path would, so that
    /// a later release has to find the nonce already gone.
    function actSpendNonce(uint256 seed) external {
        if (attempts.length == 0) return;
        Attempt memory a = attempts[bound(seed, 0, attempts.length - 1)];
        if (!a.accepted) return;

        quote.mint(a.account, 1e6);
        MandateAccount(a.account).approvePermit2(quote);

        vm.prank(settlement);
        try permit2.permitWitnessTransferFrom(
            ISignatureTransfer.PermitTransferFrom({
                permitted: ISignatureTransfer.TokenPermissions({token: address(quote), amount: 1e6}),
                nonce: a.nonce,
                deadline: type(uint256).max
            }),
            ISignatureTransfer.SignatureTransferDetails({to: settlement, requestedAmount: 1e6}),
            a.account,
            a.digest,
            "",
            ""
        ) {}
            catch {}
    }

    function actRelease(uint256 seed) external {
        if (attempts.length == 0) return;
        Attempt memory a = attempts[bound(seed, 0, attempts.length - 1)];
        Intent memory i = _rebuild(a);
        try mandates.releaseUnspent(a.id, i) {} catch {}
    }

    function actWarpTime(uint256 seed) external {
        vm.warp(vm.getBlockTimestamp() + bound(seed, 1, 3 days));
        quoteFeed.push(1e8, block.timestamp);
        baseFeed.push(200e8, block.timestamp);
    }

    function actOracleUpdate(uint256 seed) external {
        int256 drift = int256(bound(seed, 0, 400));
        int256 answer = int256(200e8);
        baseFeed.push(answer + (answer * drift) / 10_000, block.timestamp);
        quoteFeed.push(1e8, block.timestamp);
    }

    /// @dev Shape zero conforms. Every other shape breaks one named rule and
    /// nothing else, so a refusal points at the rule it was built to break.
    function _shape(bytes32 id, address account, uint8 shape, uint256 seed)
        internal
        returns (Intent memory i, bytes32 rule)
    {
        i = Intent({
            owner: account,
            receiver: account,
            sellToken: address(quote),
            buyToken: address(base),
            sellAmount: bound(seed >> 32, 1e6, 100e6),
            minBuyAmount: 1,
            validAfter: 0,
            validUntil: uint32(block.timestamp + 600),
            flags: IntentFlags.AGENT_SIGNED,
            kind: 0,
            maxDevFromRefBps: MANDATE_DEV_BPS,
            allowedSessions: MANDATE_SESSIONS,
            batchSpan: 1,
            nonce: nextNonce++
        });

        if (shape == 1) {
            i.owner = owners[bound(seed >> 40, 0, 2)];
            rule = "wrong owner";
        } else if (shape == 2) {
            i.flags = 0;
            rule = "not agent signed";
        } else if (shape == 3) {
            (,,, uint64 expiry,,,,) = mandates.mandate(id);
            i.validUntil = uint32(expiry) + 1;
            rule = "outlives mandate";
        } else if (shape == 4) {
            i.allowedSessions = 0xFF;
            rule = "session not allowed";
        } else if (shape == 5) {
            i.maxDevFromRefBps = MANDATE_DEV_BPS + 1;
            rule = "deviation too wide";
        } else if (shape == 6 && !auctionAllowed[id]) {
            i.flags = IntentFlags.AGENT_SIGNED | IntentFlags.AUCTION;
            rule = "auction not allowed";
        } else if (shape == 7) {
            i.sellToken = address(stranger);
            rule = "token not allowed";
        } else if (shape == 8) {
            i.sellAmount = maxPerBatch[id] * 1e6 + 1e12;
            rule = "per batch cap";
        } else if (shape == 9) {
            rule = "not agent signed";
        }
    }

    function _rebuild(Attempt memory a) internal view returns (Intent memory i) {
        i = Intent({
            owner: a.account,
            receiver: a.account,
            sellToken: address(quote),
            buyToken: address(base),
            sellAmount: 0,
            minBuyAmount: 1,
            validAfter: 0,
            validUntil: 0,
            flags: IntentFlags.AGENT_SIGNED,
            kind: 0,
            maxDevFromRefBps: MANDATE_DEV_BPS,
            allowedSessions: MANDATE_SESSIONS,
            batchSpan: 1,
            nonce: a.nonce
        });
    }

    function _digest(Intent memory i) internal view returns (bytes32) {
        return this.digestExternal(i);
    }

    /// @dev Calldata, because IntentLib hashes an Intent from calldata and the
    /// registry builds its digest from the same library over the same shape.
    function digestExternal(Intent calldata i) external view returns (bytes32) {
        address spender = i.flags & IntentFlags.AUCTION != 0 ? mandates.auctionHouse() : settlement;
        return Permit2Witness.digest(
            permit2.DOMAIN_SEPARATOR(),
            mandates.permitTypeHash(),
            i.sellToken,
            i.sellAmount,
            spender,
            i.nonce,
            i.validUntil,
            IntentLib.hash(i)
        );
    }
}
