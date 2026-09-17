// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import {IAgentMandate} from "./interfaces/IAgentMandate.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";
import {ISessionManager} from "./interfaces/ISessionManager.sol";
import {ISignatureTransfer} from "./interfaces/IPermit2.sol";
import {IntentLib} from "./libraries/IntentLib.sol";
import {Permit2Witness} from "./libraries/Permit2Witness.sol";
import {MandateAccount} from "./MandateAccount.sol";
import {Intent, IntentFlags, Mandate} from "./types/Types.sol";

/// @title Bounded authority for agents
/// @notice An owner says what an agent may do in the language of money rather than
/// the language of calldata, and this contract is what refuses everything else. A
/// fully compromised agent still cannot leave the box.
/// @dev parameter.md section 5B
contract AgentMandate is IAgentMandate {
    struct Record {
        address owner;
        address agent;
        address account;
        uint64 expiry;
        uint16 maxDeviationFromRefBps;
        uint8 allowedSessions;
        bool auctionAllowed;
        bool revoked;
        uint256 maxNotionalPerBatch;
        uint256 maxNotionalPerDay;
        address[] allowedTokens;
    }

    struct Booking {
        bytes32 id;
        uint256 notionalUsd;
        uint32 day;
        bool released;
    }

    uint8 public constant MANDATE_MAX_TOKENS = 8;
    uint64 public constant MANDATE_MAX_DURATION = 90 days;

    string public constant WITNESS_TYPE_STRING = "Intent witness)Intent(address owner,address receiver,"
        "address sellToken,address buyToken,uint256 sellAmount,uint256 minBuyAmount,uint32 validAfter,"
        "uint32 validUntil,uint8 flags,uint8 kind,uint16 maxDevFromRefBps,uint8 allowedSessions,"
        "uint16 batchSpan,uint256 nonce)TokenPermissions(address token,uint256 amount)";

    ISessionManager public immutable sessions;
    IPriceOracle public immutable oracle;
    ISignatureTransfer public immutable permit2;
    address public immutable settlement;
    address public immutable auctionHouse;
    address public immutable accountImplementation;
    bytes32 public immutable permitTypeHash;

    mapping(address => uint256) public mandateCount;
    mapping(bytes32 => Record) internal records;
    mapping(address => bytes32) public mandateOf;
    mapping(bytes32 => bool) internal authorizedDigest;
    mapping(bytes32 => Booking) internal bookings;
    mapping(bytes32 => uint32) internal budgetDay;
    mapping(bytes32 => uint256) internal budgetSpent;

    error NotMandateOwner(bytes32 id);
    error UnknownMandate(bytes32 id);
    error MandateExists(bytes32 id);
    error MandateRuleBroken(bytes32 id, bytes32 rule);
    error BadAgentSignature(bytes32 id, bytes32 digest);
    error AlreadyAuthorized(bytes32 digest);
    error NothingToRelease(bytes32 digest);
    error TooManyTokens(uint256 given);
    error ExpiryOutOfRange(uint64 expiry);
    error ZeroAgent();

    constructor(
        ISessionManager sessions_,
        IPriceOracle oracle_,
        ISignatureTransfer permit2_,
        address settlement_,
        address auctionHouse_
    ) {
        sessions = sessions_;
        oracle = oracle_;
        permit2 = permit2_;
        settlement = settlement_;
        auctionHouse = auctionHouse_;
        permitTypeHash = Permit2Witness.typeHash(WITNESS_TYPE_STRING);
        accountImplementation = address(new MandateAccount(this, address(permit2_)));
    }

    /// @inheritdoc IAgentMandate
    function createMandate(Mandate calldata m) external returns (bytes32 id) {
        if (m.agent == address(0)) revert ZeroAgent();
        if (m.allowedTokens.length == 0 || m.allowedTokens.length > MANDATE_MAX_TOKENS) {
            revert TooManyTokens(m.allowedTokens.length);
        }
        // forge-lint: disable-next-line(block-timestamp)
        if (m.expiry <= block.timestamp || m.expiry > block.timestamp + MANDATE_MAX_DURATION) {
            revert ExpiryOutOfRange(m.expiry);
        }

        // A counter rather than the mandate contents, so that an owner can hold
        // two mandates for the same agent and can recreate one after revoking it.
        id = keccak256(abi.encode(msg.sender, m.agent, mandateCount[msg.sender]++));
        Record storage r = records[id];
        if (r.account != address(0)) revert MandateExists(id);

        r.owner = msg.sender;
        r.agent = m.agent;
        r.expiry = m.expiry;
        r.maxDeviationFromRefBps = m.maxDeviationFromRefBps;
        r.allowedSessions = m.allowedSessions;
        r.auctionAllowed = m.auctionAllowed;
        r.maxNotionalPerBatch = m.maxNotionalPerBatch;
        r.maxNotionalPerDay = m.maxNotionalPerDay;
        r.allowedTokens = m.allowedTokens;

        address account = Clones.cloneDeterministic(accountImplementation, id);
        r.account = account;
        mandateOf[account] = id;

        emit MandateCreated(id, msg.sender, m.agent, m.expiry);
        emit MandateAccountDeployed(id, account);
    }

    /// @inheritdoc IAgentMandate
    function revokeMandate(bytes32 id) external {
        Record storage r = records[id];
        if (r.account == address(0)) revert UnknownMandate(id);
        if (msg.sender != r.owner) revert NotMandateOwner(id);
        r.revoked = true;
        emit MandateRevoked(id);
    }

    /// @inheritdoc IAgentMandate
    function authorize(bytes32 id, Intent calldata i, bytes calldata agentSig)
        external
        returns (bytes32 digest)
    {
        Record storage r = records[id];
        if (r.account == address(0)) revert UnknownMandate(id);

        bytes32 rule = _checkRules(r, i);
        if (rule != bytes32(0)) {
            emit MandateRejected(id, rule);
            revert MandateRuleBroken(id, rule);
        }

        digest = _permitDigest(i);
        if (authorizedDigest[digest]) revert AlreadyAuthorized(digest);
        if (!SignatureChecker.isValidSignatureNow(r.agent, digest, agentSig)) {
            revert BadAgentSignature(id, digest);
        }

        (uint256 notional, bool healthy) = _notional(i.sellToken, i.sellAmount);
        if (!healthy) {
            emit MandateRejected(id, "oracle unhealthy");
            revert MandateRuleBroken(id, "oracle unhealthy");
        }
        if (notional > r.maxNotionalPerBatch) {
            emit MandateRejected(id, "per batch cap");
            revert MandateRuleBroken(id, "per batch cap");
        }

        // SessionManager is immutable and this reads it.
        // forge-lint: disable-next-line(block-timestamp)
        uint32 day = sessions.easternDay(uint64(block.timestamp)); // aderyn-fp(reentrancy-state-change)
        uint256 spent = budgetDay[id] == day ? budgetSpent[id] : 0;
        if (spent + notional > r.maxNotionalPerDay) {
            emit MandateRejected(id, "per day cap");
            revert MandateRuleBroken(id, "per day cap");
        }
        budgetDay[id] = day;
        budgetSpent[id] = spent + notional;

        authorizedDigest[digest] = true;
        bookings[digest] = Booking({id: id, notionalUsd: notional, day: day, released: false});

        emit MandateUsed(id, IntentLib.hash(i), notional);
    }

    /// @inheritdoc IAgentMandate
    function releaseUnspent(bytes32 id, Intent calldata i) external {
        bytes32 digest = _permitDigest(i);
        Booking storage b = bookings[digest];
        if (b.id != id || b.released) revert NothingToRelease(digest);

        Record storage r = records[id];
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp <= i.validUntil) revert NothingToRelease(digest);
        if (_nonceSpent(r.account, i.nonce)) revert NothingToRelease(digest);

        b.released = true;
        authorizedDigest[digest] = false;
        if (budgetDay[id] == b.day) {
            budgetSpent[id] -= b.notionalUsd;
        }
        emit MandateBudgetReleased(id, IntentLib.hash(i), b.notionalUsd);
    }

    /// @inheritdoc IAgentMandate
    function validate(bytes32 id, Intent calldata i) external view returns (bool ok, bytes32 reason) {
        Record storage r = records[id];
        if (r.account == address(0)) return (false, "unknown mandate");
        reason = _checkRules(r, i);
        if (reason != bytes32(0)) return (false, reason);
        (uint256 notional, bool healthy) = _notional(i.sellToken, i.sellAmount);
        if (!healthy) return (false, "oracle unhealthy");
        if (notional > r.maxNotionalPerBatch) return (false, "per batch cap");
        return (true, bytes32(0));
    }

    /// @inheritdoc IAgentMandate
    function spentToday(bytes32 id) external view returns (uint256) {
        // forge-lint: disable-next-line(block-timestamp)
        return budgetDay[id] == sessions.easternDay(uint64(block.timestamp)) ? budgetSpent[id] : 0;
    }

    /// @inheritdoc IAgentMandate
    function accountOf(bytes32 id) external view returns (address) {
        return records[id].account;
    }

    /// @inheritdoc IAgentMandate
    function accountOwner(address account) external view returns (address) {
        return records[mandateOf[account]].owner;
    }

    /// @inheritdoc IAgentMandate
    function accountAuthorized(address account, bytes32 digest) external view returns (bool) {
        bytes32 id = mandateOf[account];
        if (id == bytes32(0) || bookings[digest].id != id) return false;
        Record storage r = records[id];
        // Revocation and expiry are read here rather than only at authorize, so
        // that pulling the mandate stops intents that were already booked.
        // forge-lint: disable-next-line(block-timestamp)
        if (r.revoked || block.timestamp >= r.expiry) return false;
        return authorizedDigest[digest];
    }

    function mandate(bytes32 id)
        external
        view
        returns (
            address owner,
            address agent,
            address account,
            uint64 expiry,
            uint16 maxDeviationFromRefBps,
            uint8 allowedSessions,
            bool auctionAllowed,
            bool revoked
        )
    {
        Record storage r = records[id];
        return (
            r.owner,
            r.agent,
            r.account,
            r.expiry,
            r.maxDeviationFromRefBps,
            r.allowedSessions,
            r.auctionAllowed,
            r.revoked
        );
    }

    function mandateLimits(bytes32 id)
        external
        view
        returns (uint256 maxNotionalPerBatch, uint256 maxNotionalPerDay, address[] memory allowedTokens)
    {
        Record storage r = records[id];
        return (r.maxNotionalPerBatch, r.maxNotionalPerDay, r.allowedTokens);
    }

    /// @notice USD with 18 decimals, normalised by the token decimals so that a
    /// cap on a six decimal stablecoin means the same thing as a cap on an
    /// eighteen decimal stock token.
    function notionalUsd(address token, uint256 amount) public view returns (uint256 value) {
        (value,) = _notional(token, amount);
    }

    /// @dev A cap priced off a stale feed is not a cap, so the health flag travels
    /// with the number rather than being dropped at the call site.
    function _notional(address token, uint256 amount) internal view returns (uint256, bool) {
        (uint256 price,, bool healthy) = oracle.refPrice(token);
        uint256 unit = 10 ** IERC20Metadata(token).decimals();
        return ((amount * price) / unit, healthy);
    }

    function _checkRules(Record storage r, Intent calldata i) internal view returns (bytes32) {
        if (r.revoked) return "revoked";
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= r.expiry) return "mandate expired";
        if (i.owner != r.account) return "wrong owner";
        if (i.flags & IntentFlags.AGENT_SIGNED == 0) return "not agent signed";
        if (i.validUntil > r.expiry) return "outlives mandate";
        if (i.allowedSessions & ~r.allowedSessions != 0) return "session not allowed";
        if (i.maxDevFromRefBps > r.maxDeviationFromRefBps) return "deviation too wide";
        if (i.flags & IntentFlags.AUCTION != 0 && !r.auctionAllowed) return "auction not allowed";
        if (!_tokenAllowed(r, i.sellToken) || !_tokenAllowed(r, i.buyToken)) return "token not allowed";
        return bytes32(0);
    }

    function _tokenAllowed(Record storage r, address token) internal view returns (bool) {
        uint256 n = r.allowedTokens.length;
        for (uint256 k = 0; k < n; ++k) {
            if (r.allowedTokens[k] == token) return true;
        }
        return false;
    }

    /// @dev The spender is the contract that will call Permit2, and it is part of
    /// the digest, so a signature meant for a batch cannot be replayed into a
    /// cross and the other way round.
    function _permitDigest(Intent calldata i) internal view returns (bytes32) {
        address spender = i.flags & IntentFlags.AUCTION != 0 ? auctionHouse : settlement;
        return Permit2Witness.digest(
            permit2.DOMAIN_SEPARATOR(),
            permitTypeHash,
            i.sellToken,
            i.sellAmount,
            spender,
            i.nonce,
            i.validUntil,
            IntentLib.hash(i)
        );
    }

    function _nonceSpent(address account, uint256 nonce) internal view returns (bool) {
        uint256 word = permit2.nonceBitmap(account, nonce >> 8);
        return ((word >> (nonce & 0xff)) & 1) != 0;
    }
}
