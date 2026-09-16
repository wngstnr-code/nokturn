// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IAuctionHouse} from "./interfaces/IAuctionHouse.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";
import {ISessionManager} from "./interfaces/ISessionManager.sol";
import {ISignatureTransfer} from "./interfaces/IPermit2.sol";
import {ISolverRegistry} from "./interfaces/ISolverRegistry.sol";
import {IUiMultiplier} from "./interfaces/IUiMultiplier.sol";
import {CivilDate} from "./libraries/CivilDate.sol";
import {IntentLib} from "./libraries/IntentLib.sol";
import {Execution, Intent, IntentFlags, IntentKind, Session, SessionMask} from "./types/Types.sol";

/// @title Opening and closing crosses
/// @notice Prices here are quote token units per 1e18 units of the auction token.
/// Nothing in this contract carries a price in USD, which is what keeps the
/// decimal difference between USDG and the Stock Tokens out of the matching math.
///
/// The contract checks that a cross is feasible and that it clears exactly the
/// volume its own book says is matchable at that price. Whether a better price
/// exists is settled by challenge instead, because searching every candidate price
/// is quadratic in the length of the book and a solver can do that work offchain.
contract AuctionHouse is IAuctionHouse, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Phase {
        NONE,
        DISCLOSURE,
        FROZEN,
        CROSSED,
        EXECUTED,
        ABORTED
    }

    struct Auction {
        address token;
        uint8 kind;
        Phase phase;
        bool referenceFinal;
        bool rooExcluded;
        uint8 extensions;
        uint16 collarBps;
        uint32 day;
        uint64 freezeAt;
        uint64 crossAt;
        uint64 referenceAt;
        uint64 crossSubmittedAt;
        uint256 refPrice;
        uint256 clearingPrice;
        uint256 matchedVolume;
        uint256 escrowedValue;
        uint256 tokenDust;
        uint256 quoteDust;
        uint32 participants;
        address solver;
        bytes32 multiplierHash;
    }

    struct Commitment {
        address owner;
        address receiver;
        address sellToken;
        uint64 auctionId;
        uint8 kind;
        bool buy;
        bool escrowed;
        bool cancelled;
        bool refunded;
        uint16 maxDevFromRefBps;
        uint256 sellAmount;
        uint256 limitPrice;
        uint256 nonce;
        uint256 deadline;
        uint256 filledSell;
        uint256 filledBuy;
    }

    struct Round {
        int256 answer;
        uint64 startedAt;
        uint64 updatedAt;
        uint256 volume;
        uint32 participants;
    }

    uint256 internal constant WAD = 1e18;
    uint16 internal constant BPS = 10_000;

    uint8 public constant KIND_OPEN = 0;
    uint8 public constant KIND_CLOSE = 1;

    /// parameter.md section 3.
    uint64 public constant FREEZE_OFFSET = 300;
    uint64 public constant CROSS_DELAY_OPEN = 300;
    uint16 public constant COLLAR_INITIAL = 200;
    uint16 public constant COLLAR_STEP = 50;
    uint64 public constant EXTENSION_PERIOD = 300;
    uint8 public constant MAX_EXTENSIONS = 3;
    uint64 public constant CHALLENGE_WINDOW = 120;
    uint16 public constant CHALLENGE_REWARD_BPS = 5000;
    uint256 public constant BOND_USD = 500;
    uint256 public constant PRINT_MIN_VOLUME_USD = 1000;
    uint32 public constant PRINT_MIN_PARTICIPANTS = 5;
    uint8 public constant PRINT_DECIMALS = 8;
    uint256 public constant MAX_AUCTION_INTENTS = 256;
    uint256 public constant MAX_CROSS_EXECUTIONS = 128;

    /// Enough boundaries to reach the next cross across a long holiday weekend.
    uint256 internal constant MAX_LOOKAHEAD_STEPS = 48;

    string public constant WITNESS_TYPE_STRING = "Intent witness)Intent(address owner,address receiver,"
        "address sellToken,address buyToken,uint256 sellAmount,uint256 minBuyAmount,uint32 validAfter,"
        "uint32 validUntil,uint8 flags,uint8 kind,uint16 maxDevFromRefBps,uint8 allowedSessions,"
        "uint16 batchSpan,uint256 nonce)TokenPermissions(address token,uint256 amount)";

    ISessionManager public immutable sessions;
    IPriceOracle public immutable oracle;
    ISolverRegistry public immutable solvers;
    ISignatureTransfer public immutable permit2;
    IERC20 public immutable quote;
    address public immutable treasury;
    address public immutable governor;

    uint256 public immutable quoteUnit;
    uint256 public immutable bond;
    uint256 public immutable printMinVolume;

    uint64 public auctionCount;

    mapping(uint64 => Auction) internal auctions;
    mapping(bytes32 => uint64) internal auctionIds;
    mapping(uint64 => bytes32[]) internal books;
    mapping(bytes32 => Commitment) internal commitments;
    mapping(bytes32 => bytes) internal signatures;
    mapping(address => bool) public auctionTokenAllowed;
    mapping(address => mapping(uint32 => Round)) internal rounds;
    mapping(address => uint32) public latestPrintDay;

    error NotGovernor();
    error TokenNotAllowed(address token);
    error NotAnAuctionIntent(bytes32 intentHash);
    error PairMustQuoteAgainstQuoteToken(address sellToken, address buyToken);
    error AmbiguousAuctionSession(uint8 allowedSessions);
    error AlreadyCommitted(bytes32 intentHash);
    error CommitmentUnknown(bytes32 intentHash);
    error NotCommitmentOwner(bytes32 intentHash);
    error BookFull(uint64 auctionId);
    error IntentExpiresBeforeCross(uint32 validUntil, uint64 crossAt);
    error NotCoveredByPermit2(address owner, address token);
    error WrongPhase(uint64 auctionId, uint8 phase);
    error NoAuctionSessionAhead(uint8 kind);
    error NotInAuctionSession(uint8 kind, uint8 session);
    error TooEarly(uint64 notBefore);
    error TooLate(uint64 notAfter);
    error SolverNotActive(address solver);
    error PriceOutsideCollar(uint256 price, uint256 low, uint256 high);
    error ExecutionsNotAscending(uint256 index);
    error TooManyExecutions(uint256 count);
    error LimitNotRespected(uint256 index, uint256 limit, uint256 price);
    error FillExceedsEscrow(uint256 index, uint256 requested, uint256 remaining);
    error UniformPriceViolated(uint256 index, uint256 expected, uint256 actual);
    error ValueNotConserved(uint256 given, uint256 taken);
    error VolumeBelowMatchable(uint256 executed, uint256 matchable);
    error NothingMatched(uint64 auctionId);
    error ChallengeNotBetter(uint256 oldPrice, uint256 newPrice);
    error ExtensionsExhausted(uint64 auctionId);
    error AuctionStillLive(uint64 auctionId);
    error EscrowNotRefundable(bytes32 intentHash);
    error MultiplierChanged(address token);
    error CommitmentNotEscrowed(uint256 index);
    error OracleUnhealthy(address token);

    constructor(
        ISessionManager sessions_,
        IPriceOracle oracle_,
        ISolverRegistry solvers_,
        ISignatureTransfer permit2_,
        IERC20 quote_,
        address treasury_,
        address governor_
    ) {
        sessions = sessions_;
        oracle = oracle_;
        solvers = solvers_;
        permit2 = permit2_;
        quote = quote_;
        treasury = treasury_;
        governor = governor_;

        quoteUnit = 10 ** IERC20Metadata(address(quote_)).decimals();
        bond = BOND_USD * quoteUnit;
        printMinVolume = PRINT_MIN_VOLUME_USD * quoteUnit;
    }

    modifier onlyGovernor() {
        if (msg.sender != governor) revert NotGovernor();
        _;
    }

    function setAuctionTokenAllowed(address token, bool allowed) external onlyGovernor {
        auctionTokenAllowed[token] = allowed;
        emit AuctionTokenAllowlisted(token, allowed);
    }

    /// @inheritdoc IAuctionHouse
    function commitAuctionIntent(Intent calldata i, bytes calldata sig) external {
        bytes32 intentHash = IntentLib.hash(i);
        if (commitments[intentHash].owner != address(0)) revert AlreadyCommitted(intentHash);
        if (i.flags & IntentFlags.AUCTION == 0) revert NotAnAuctionIntent(intentHash);
        if (i.kind == uint8(IntentKind.SPOT)) revert NotAnAuctionIntent(intentHash);

        uint8 auctionKind = _auctionKindOf(i.allowedSessions);
        (uint32 day, uint64 crossAt) = _nextCross(auctionKind);

        bool buy = address(quote) == i.sellToken;
        address token = buy ? i.buyToken : i.sellToken;
        if (!buy && i.buyToken != address(quote)) {
            revert PairMustQuoteAgainstQuoteToken(i.sellToken, i.buyToken);
        }
        if (!auctionTokenAllowed[token]) revert TokenNotAllowed(token);
        if (i.validUntil < crossAt) revert IntentExpiresBeforeCross(i.validUntil, crossAt);

        (uint64 auctionId, Auction storage a) = _openOrCreate(token, day, auctionKind, crossAt);
        if (a.phase != Phase.NONE && a.phase != Phase.DISCLOSURE) {
            revert WrongPhase(auctionId, uint8(a.phase));
        }
        if (books[auctionId].length >= MAX_AUCTION_INTENTS) revert BookFull(auctionId);

        // The escrow is only pulled at the freeze, so the book would otherwise be
        // free to fill with intents nobody can pay for, and the indicative price
        // published before the freeze is exactly what that would corrupt. Holding
        // the funds and standing approved to Permit2 is the same economic barrier
        // as escrow without taking anyone into custody.
        if (
            IERC20(i.sellToken).balanceOf(i.owner) < i.sellAmount
                || IERC20(i.sellToken).allowance(i.owner, address(permit2)) < i.sellAmount
        ) {
            revert NotCoveredByPermit2(i.owner, i.sellToken);
        }

        commitments[intentHash] = Commitment({
            owner: i.owner,
            receiver: i.receiver,
            sellToken: i.sellToken,
            auctionId: auctionId,
            kind: i.kind,
            buy: buy,
            escrowed: false,
            cancelled: false,
            refunded: false,
            maxDevFromRefBps: i.maxDevFromRefBps,
            sellAmount: i.sellAmount,
            limitPrice: _limitOf(i, buy),
            nonce: i.nonce,
            deadline: i.validUntil,
            filledSell: 0,
            filledBuy: 0
        });
        books[auctionId].push(intentHash);
        signatures[intentHash] = sig;
    }

    /// @inheritdoc IAuctionHouse
    function openAuction(address token, uint8 kind) external returns (uint64 auctionId) {
        Session session = sessions.sessionAt(uint64(block.timestamp));
        if (session != _auctionSession(kind)) revert NotInAuctionSession(kind, uint8(session));

        (uint32 day, uint64 crossAt) = _nextCross(kind);
        Auction storage a;
        (auctionId, a) = _openOrCreate(token, day, kind, crossAt);
        if (a.phase != Phase.NONE) revert WrongPhase(auctionId, uint8(a.phase));

        a.phase = Phase.DISCLOSURE;
        emit AuctionOpened(auctionId, token, kind, crossAt);
    }

    /// @inheritdoc IAuctionHouse
    function cancelBeforeFreeze(bytes32 intentHash) external {
        Commitment storage c = commitments[intentHash];
        if (c.owner == address(0)) revert CommitmentUnknown(intentHash);
        if (c.owner != msg.sender) revert NotCommitmentOwner(intentHash);

        Auction storage a = auctions[c.auctionId];
        if (a.phase != Phase.NONE && a.phase != Phase.DISCLOSURE) {
            revert WrongPhase(c.auctionId, uint8(a.phase));
        }
        c.cancelled = true;
    }

    /// @inheritdoc IAuctionHouse
    /// @dev The invitation. This is the one call in the protocol whose whole point
    /// is to be read by someone who has not committed anything yet.
    function publishIndicative(uint64 auctionId) external {
        Auction storage a = auctions[auctionId];
        if (a.phase != Phase.DISCLOSURE && a.phase != Phase.FROZEN) {
            revert WrongPhase(auctionId, uint8(a.phase));
        }

        uint256 ref = a.referenceFinal ? a.refPrice : _refPrice(a.token);
        (uint256 price, uint256 matched, int256 imbalance) = _search(auctionId, ref, a.collarBps);
        emit IndicativePublished(auctionId, a.token, price, imbalance, matched);
    }

    /// @inheritdoc IAuctionHouse
    /// @dev Pulls every escrow it can and drops the rest. An intent whose funds
    /// have moved since the commit is not a participant, and saying so out loud is
    /// what makes the frozen imbalance a number a liquidity provider can act on.
    function freeze(uint64 auctionId) external nonReentrant {
        Auction storage a = auctions[auctionId];
        if (a.phase != Phase.DISCLOSURE) revert WrongPhase(auctionId, uint8(a.phase));
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < a.freezeAt) revert TooEarly(a.freezeAt);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= a.crossAt) revert TooLate(a.crossAt);

        bytes32[] storage book = books[auctionId];
        uint256 ref = _refPrice(a.token);
        uint256 escrowedValue;
        uint256 committed;

        for (uint256 k = 0; k < book.length; ++k) {
            Commitment storage c = commitments[book[k]];
            if (c.cancelled) continue;

            try permit2.permitWitnessTransferFrom(
                ISignatureTransfer.PermitTransferFrom({
                    permitted: ISignatureTransfer.TokenPermissions({
                        token: c.sellToken, amount: c.sellAmount
                    }),
                    nonce: c.nonce,
                    deadline: c.deadline
                }),
                ISignatureTransfer.SignatureTransferDetails({
                    to: address(this), requestedAmount: c.sellAmount
                }),
                c.owner,
                book[k],
                WITNESS_TYPE_STRING,
                signatures[book[k]]
            ) {
                c.escrowed = true;
                committed += 1;
                escrowedValue += c.buy ? c.sellAmount : _quoteOf(c.sellAmount, ref);
            } catch {
                c.cancelled = true;
                emit CommitmentDropped(auctionId, book[k], "escrow pull failed");
            }
        }

        a.phase = Phase.FROZEN;
        a.refPrice = ref;
        a.escrowedValue = escrowedValue;
        a.multiplierHash = _multiplierHash(a.token);
        emit AuctionFrozen(auctionId, committed, escrowedValue);
    }

    /// @inheritdoc IAuctionHouse
    /// @dev Widening the collar is the onchain equivalent of a delayed opening.
    /// The indicative price keeps being published while it widens, so the incentive
    /// to step in grows with the delay rather than shrinking.
    function extend(uint64 auctionId) external {
        Auction storage a = auctions[auctionId];
        if (a.phase != Phase.FROZEN) revert WrongPhase(auctionId, uint8(a.phase));
        if (a.extensions >= MAX_EXTENSIONS) revert ExtensionsExhausted(auctionId);

        uint64 due = _reference(a) + EXTENSION_PERIOD * (uint64(a.extensions) + 1);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < due) revert TooEarly(due);

        a.extensions += 1;
        a.collarBps += COLLAR_STEP;
        emit AuctionExtended(auctionId, a.extensions, a.collarBps);
    }

    /// @inheritdoc IAuctionHouse
    function submitCross(uint64 auctionId, uint256 price, Execution[] calldata e) external {
        Auction storage a = auctions[auctionId];
        if (a.phase != Phase.FROZEN) revert WrongPhase(auctionId, uint8(a.phase));
        if (!solvers.isActive(msg.sender)) revert SolverNotActive(msg.sender);

        uint64 referenceAt = _reference(a);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < referenceAt) revert TooEarly(referenceAt);
        _requireInCollar(a, price);

        (uint256 volume, uint256 quoteVolume, uint32 participants) = _applyCross(auctionId, a, price, e);

        a.phase = Phase.CROSSED;
        a.solver = msg.sender;
        a.clearingPrice = price;
        a.matchedVolume = volume;
        a.participants = participants;
        a.crossSubmittedAt = uint64(block.timestamp);

        quote.safeTransferFrom(msg.sender, address(this), bond);
        emit CrossSubmitted(auctionId, msg.sender, price, quoteVolume);
    }

    /// @inheritdoc IAuctionHouse
    /// @dev A challenge is never free on one side only. The solver posted the same
    /// bond when it submitted, so naming a better price costs what defending a bad
    /// one costs.
    function challenge(uint64 auctionId, uint256 betterPrice) external nonReentrant {
        Auction storage a = auctions[auctionId];
        if (a.phase != Phase.CROSSED) revert WrongPhase(auctionId, uint8(a.phase));
        uint64 closesAt = a.crossSubmittedAt + CHALLENGE_WINDOW;
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > closesAt) revert TooLate(closesAt);

        quote.safeTransferFrom(msg.sender, address(this), bond);
        _requireInCollar(a, betterPrice);

        uint256 oldPrice = a.clearingPrice;
        bool better = _isBetter(auctionId, betterPrice, oldPrice, a.refPrice);
        emit CrossChallenged(auctionId, msg.sender, oldPrice, betterPrice, better);

        if (!better) {
            // The bond has to stay seized, so this path returns rather than
            // reverting. A challenge that costs nothing when it is wrong is a
            // challenge that gets sent at every cross.
            _payBond(a.solver);
            return;
        }

        _rollbackCross(auctionId, a);
        _payBond(msg.sender);
        a.phase = Phase.FROZEN;
        a.solver = address(0);
    }

    /// @inheritdoc IAuctionHouse
    function executeCross(uint64 auctionId) external nonReentrant {
        Auction storage a = auctions[auctionId];
        if (a.phase != Phase.CROSSED) revert WrongPhase(auctionId, uint8(a.phase));
        uint64 opensAt = a.crossSubmittedAt + CHALLENGE_WINDOW;
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp <= opensAt) revert TooEarly(opensAt + 1);
        if (_multiplierHash(a.token) != a.multiplierHash) revert MultiplierChanged(a.token);

        a.phase = Phase.EXECUTED;

        bytes32[] storage book = books[auctionId];
        for (uint256 k = 0; k < book.length; ++k) {
            Commitment storage c = commitments[book[k]];
            if (c.filledBuy == 0) continue;
            IERC20 out = c.buy ? IERC20(a.token) : quote;
            out.safeTransfer(c.receiver, c.filledBuy);
        }

        if (a.tokenDust > 0) IERC20(a.token).safeTransfer(treasury, a.tokenDust);
        if (a.quoteDust > 0) quote.safeTransfer(treasury, a.quoteDust);
        quote.safeTransfer(a.solver, bond);

        uint256 quoteVolume = _quoteOf(a.matchedVolume, a.clearingPrice);
        emit CrossExecuted(auctionId, a.token, a.clearingPrice, quoteVolume, a.participants);
        solvers.recordWin(a.solver, quoteVolume);

        if (a.kind == KIND_CLOSE) _publishPrint(a, quoteVolume);
    }

    /// @inheritdoc IAuctionHouse
    /// @dev Anyone, because an auction that cannot cross must not be able to keep
    /// the escrow either. The corporate action path is here too, since a multiplier
    /// that moves between the freeze and the cross changes what every intent meant.
    function abortAuction(uint64 auctionId) external {
        Auction storage a = auctions[auctionId];
        if (a.phase == Phase.EXECUTED || a.phase == Phase.ABORTED || a.phase == Phase.NONE) {
            revert WrongPhase(auctionId, uint8(a.phase));
        }

        bytes32 reason;
        if (a.phase == Phase.FROZEN && _multiplierHash(a.token) != a.multiplierHash) {
            reason = "multiplier moved";
        } else if (sessions.sessionAt(a.crossAt) != _crossSession(a.kind)) {
            reason = "market did not open";
        } else {
            uint64 deadline = a.referenceAt + EXTENSION_PERIOD * (uint64(MAX_EXTENSIONS) + 1);
            // forge-lint: disable-next-line(block-timestamp)
            if (block.timestamp <= deadline) revert AuctionStillLive(auctionId);
            reason = "no cross in time";
        }

        if (a.phase == Phase.CROSSED) {
            _rollbackCross(auctionId, a);
            quote.safeTransfer(a.solver, bond);
        }

        a.phase = Phase.ABORTED;
        emit AuctionAborted(auctionId, reason);
    }

    /// @inheritdoc IAuctionHouse
    function refundEscrow(bytes32 intentHash) external nonReentrant {
        Commitment storage c = commitments[intentHash];
        if (c.owner == address(0)) revert CommitmentUnknown(intentHash);

        Phase phase = auctions[c.auctionId].phase;
        bool settled = phase == Phase.EXECUTED || phase == Phase.ABORTED;
        if (!settled || !c.escrowed || c.refunded) revert EscrowNotRefundable(intentHash);

        uint256 amount = c.sellAmount - c.filledSell;
        c.refunded = true;
        if (amount > 0) IERC20(c.sellToken).safeTransfer(c.owner, amount);
        emit EscrowRefunded(intentHash, c.owner, amount);
    }

    /// @inheritdoc IAuctionHouse
    function closingPrice(address token, uint32 day)
        external
        view
        returns (uint256 price, uint256 volume, uint32 participants, bool sufficient)
    {
        Round memory r = rounds[token][day];
        return (_toWad(r.answer), r.volume, r.participants, r.updatedAt != 0);
    }

    /// @inheritdoc IAuctionHouse
    function lastClose(address token) external view returns (uint256 price, uint64 ts, bool sufficient) {
        Round memory r = rounds[token][latestPrintDay[token]];
        return (_toWad(r.answer), r.updatedAt, r.updatedAt != 0);
    }

    /// @inheritdoc IAuctionHouse
    function printRound(address token, uint32 day)
        external
        view
        returns (int256 answer, uint64 startedAt, uint64 updatedAt)
    {
        Round memory r = rounds[token][day];
        return (r.answer, r.startedAt, r.updatedAt);
    }

    /// @dev Split into three reads on purpose. One getter over the whole struct
    /// returns twenty one values and cannot be compiled through the IR pipeline,
    /// which the coverage run needs.
    function auctionState(uint64 auctionId)
        external
        view
        returns (address token, uint8 kind, uint8 phase, uint32 day, uint16 collarBps, uint8 extensions)
    {
        Auction storage a = auctions[auctionId];
        return (a.token, a.kind, uint8(a.phase), a.day, a.collarBps, a.extensions);
    }

    function auctionResult(uint64 auctionId)
        external
        view
        returns (
            uint256 refPrice,
            uint256 clearingPrice,
            uint256 matchedVolume,
            uint256 escrowedValue,
            uint32 participants,
            address solver
        )
    {
        Auction storage a = auctions[auctionId];
        return (a.refPrice, a.clearingPrice, a.matchedVolume, a.escrowedValue, a.participants, a.solver);
    }

    function auctionTiming(uint64 auctionId)
        external
        view
        returns (uint64 freezeAt, uint64 crossAt, uint64 referenceAt)
    {
        Auction storage a = auctions[auctionId];
        return (a.freezeAt, a.crossAt, a.referenceAt);
    }

    function bookLength(uint64 auctionId) external view returns (uint256) {
        return books[auctionId].length;
    }

    function bookAt(uint64 auctionId, uint256 index) external view returns (bytes32) {
        return books[auctionId][index];
    }

    function commitment(bytes32 intentHash) external view returns (Commitment memory) {
        return commitments[intentHash];
    }

    /// @notice Clearing price the contract would pick from its own book right now.
    /// Quadratic in the length of the book, which is why it is a view and why
    /// MAX_AUCTION_INTENTS exists.
    function indicative(uint64 auctionId)
        external
        view
        returns (uint256 price, uint256 matched, int256 imbalance)
    {
        Auction storage a = auctions[auctionId];
        uint256 ref = a.referenceFinal ? a.refPrice : _refPrice(a.token);
        return _search(auctionId, ref, a.collarBps);
    }

    function _applyCross(uint64 auctionId, Auction storage a, uint256 price, Execution[] calldata e)
        internal
        returns (uint256 tokenOut, uint256 quoteVolume, uint32 participants)
    {
        if (e.length > MAX_CROSS_EXECUTIONS) revert TooManyExecutions(e.length);

        bytes32[] storage book = books[auctionId];
        uint256 tokenIn;
        uint256 quoteIn;
        uint256 quoteOut;
        uint256 last = type(uint256).max;

        for (uint256 k = 0; k < e.length; ++k) {
            if (last != type(uint256).max && e[k].intentIndex <= last) revert ExecutionsNotAscending(k);
            last = e[k].intentIndex;

            Commitment storage c = commitments[book[e[k].intentIndex]];
            if (!c.escrowed || c.cancelled) revert CommitmentNotEscrowed(k);

            (uint256 limit, bool participating) = _effectiveLimit(c, a.refPrice, a.rooExcluded);
            if (!participating) revert LimitNotRespected(k, 0, price);
            if (c.buy && limit != 0 && price > limit) revert LimitNotRespected(k, limit, price);
            if (!c.buy && limit != 0 && price < limit) revert LimitNotRespected(k, limit, price);

            uint256 remaining = c.sellAmount - c.filledSell;
            if (e[k].executedSell > remaining) {
                revert FillExceedsEscrow(k, e[k].executedSell, remaining);
            }

            uint256 expected = c.buy ? _tokenOf(e[k].executedSell, price) : _quoteOf(e[k].executedSell, price);
            if (e[k].executedBuy != expected) {
                revert UniformPriceViolated(k, expected, e[k].executedBuy);
            }

            c.filledSell += e[k].executedSell;
            c.filledBuy += e[k].executedBuy;

            if (c.buy) {
                quoteIn += e[k].executedSell;
                tokenOut += e[k].executedBuy;
            } else {
                tokenIn += e[k].executedSell;
                quoteOut += e[k].executedBuy;
            }
        }

        if (tokenIn < tokenOut) revert ValueNotConserved(tokenIn, tokenOut);
        if (quoteIn < quoteOut) revert ValueNotConserved(quoteIn, quoteOut);

        (,, uint256 matchable) = _match(auctionId, price, a.refPrice, a.rooExcluded);
        if (matchable == 0) revert NothingMatched(auctionId);
        // Rounding is floored per fill and always in favour of the contract, so the
        // executed volume can sit one unit per fill below the matchable number.
        if (tokenOut + e.length < matchable) revert VolumeBelowMatchable(tokenOut, matchable);

        a.tokenDust = tokenIn - tokenOut;
        a.quoteDust = quoteIn - quoteOut;
        quoteVolume = quoteOut;
        participants = _countParticipants(book, e);
    }

    function _rollbackCross(uint64 auctionId, Auction storage a) internal {
        bytes32[] storage book = books[auctionId];
        for (uint256 k = 0; k < book.length; ++k) {
            Commitment storage c = commitments[book[k]];
            if (c.filledSell == 0 && c.filledBuy == 0) continue;
            c.filledSell = 0;
            c.filledBuy = 0;
        }
        a.tokenDust = 0;
        a.quoteDust = 0;
        a.clearingPrice = 0;
        a.matchedVolume = 0;
        a.participants = 0;
    }

    function _countParticipants(bytes32[] storage book, Execution[] calldata e)
        internal
        view
        returns (uint32 count)
    {
        for (uint256 k = 0; k < e.length; ++k) {
            address owner = commitments[book[e[k].intentIndex]].owner;
            bool seen = false;
            for (uint256 j = 0; j < k; ++j) {
                if (commitments[book[e[j].intentIndex]].owner == owner) {
                    seen = true;
                    break;
                }
            }
            if (!seen) count += 1;
        }
    }

    /// @dev The exchange hierarchy from desain-auction.md section 2.3, in order.
    /// Maximum volume first, then the smallest residual imbalance, then the price
    /// closest to the reference.
    function _isBetter(uint64 auctionId, uint256 candidate, uint256 incumbent, uint256 ref)
        internal
        view
        returns (bool)
    {
        bool rooExcluded = auctions[auctionId].rooExcluded;
        (uint256 demandA, uint256 supplyA, uint256 matchedA) = _match(auctionId, candidate, ref, rooExcluded);
        (uint256 demandB, uint256 supplyB, uint256 matchedB) = _match(auctionId, incumbent, ref, rooExcluded);

        if (matchedA != matchedB) return matchedA > matchedB;

        uint256 gapA = demandA > supplyA ? demandA - supplyA : supplyA - demandA;
        uint256 gapB = demandB > supplyB ? demandB - supplyB : supplyB - demandB;
        if (gapA != gapB) return gapA < gapB;

        uint256 distA = candidate > ref ? candidate - ref : ref - candidate;
        uint256 distB = incumbent > ref ? incumbent - ref : ref - incumbent;
        return distA < distB;
    }

    function _search(uint64 auctionId, uint256 ref, uint16 collarBps)
        internal
        view
        returns (uint256 price, uint256 matched, int256 imbalance)
    {
        (uint256 low, uint256 high) = _collar(ref, collarBps);
        bool rooExcluded = auctions[auctionId].rooExcluded;

        price = ref;
        (uint256 demand, uint256 supply, uint256 best) = _match(auctionId, ref, ref, rooExcluded);
        matched = best;
        imbalance = _imbalance(demand, supply);

        bytes32[] storage book = books[auctionId];
        for (uint256 k = 0; k < book.length; ++k) {
            (uint256 candidate,) = _effectiveLimit(commitments[book[k]], ref, rooExcluded);
            if (candidate == 0 || candidate < low || candidate > high) continue;
            if (!_isBetter(auctionId, candidate, price, ref)) continue;

            (demand, supply, matched) = _match(auctionId, candidate, ref, rooExcluded);
            price = candidate;
            imbalance = _imbalance(demand, supply);
        }
    }

    /// @dev Demand and supply are both in token units, so the imbalance is the
    /// number the liquidity provider actually needs, not a value in quote terms.
    function _match(uint64 auctionId, uint256 price, uint256 ref, bool rooExcluded)
        internal
        view
        returns (uint256 demand, uint256 supply, uint256 matched)
    {
        if (price == 0) return (0, 0, 0);

        bytes32[] storage book = books[auctionId];
        bool frozen = auctions[auctionId].phase >= Phase.FROZEN;

        for (uint256 k = 0; k < book.length; ++k) {
            Commitment storage c = commitments[book[k]];
            if (c.cancelled) continue;
            if (frozen && !c.escrowed) continue;

            (uint256 limit, bool participating) = _effectiveLimit(c, ref, rooExcluded);
            if (!participating) continue;

            if (c.buy) {
                if (limit == 0 || price <= limit) demand += _tokenOf(c.sellAmount, price);
            } else {
                if (limit == 0 || price >= limit) supply += c.sellAmount;
            }
        }
        matched = demand < supply ? demand : supply;
    }

    function _effectiveLimit(Commitment storage c, uint256 ref, bool rooExcluded)
        internal
        view
        returns (uint256 limit, bool participating)
    {
        if (c.kind == uint8(IntentKind.MOO)) return (0, true);
        if (c.kind == uint8(IntentKind.LOO)) return (c.limitPrice, true);
        // ROO without an opening reference has no meaning, and guessing one is the
        // one thing desain-auction.md section 2.5 says never to do.
        if (rooExcluded || ref == 0) return (0, false);
        uint256 dev = uint256(c.maxDevFromRefBps);
        return (c.buy ? (ref * (BPS + dev)) / BPS : (ref * (BPS - dev)) / BPS, true);
    }

    /// @dev Resolves the reference once, at the first call after referenceAt. For an
    /// opening cross that is 300 seconds past the bell, because the opening
    /// reference is a TWAP over exactly that window and does not exist before it.
    function _reference(Auction storage a) internal returns (uint64) {
        // forge-lint: disable-next-line(block-timestamp)
        if (a.referenceFinal || block.timestamp < a.referenceAt) return a.referenceAt;

        if (a.kind == KIND_OPEN) {
            // forge-lint: disable-next-line(unsafe-typecast)
            (uint256 openRef, bool available) = oracle.openReference(a.token, uint32(a.crossAt / 1 days));
            if (available) {
                a.refPrice = (openRef * quoteUnit) / WAD;
            } else {
                a.refPrice = _refPrice(a.token);
                a.rooExcluded = true;
            }
        } else {
            a.refPrice = _refPrice(a.token);
        }

        a.referenceFinal = true;
        return a.referenceAt;
    }

    function _publishPrint(Auction storage a, uint256 quoteVolume) internal {
        uint32 day = a.day;
        if (quoteVolume < printMinVolume) {
            emit ClosingPrintWithheld(a.token, day, "volume below minimum", quoteVolume, a.participants);
            return;
        }
        if (a.participants < PRINT_MIN_PARTICIPANTS) {
            emit ClosingPrintWithheld(a.token, day, "too few participants", quoteVolume, a.participants);
            return;
        }

        // updatedAt is the moment the cross ran, never block.timestamp. The print is
        // stale by design for most of the day, and faking freshness would break a
        // consumer staleness check silently. parameter.md section 3.1.
        rounds[a.token][day] = Round({
            // forge-lint: disable-next-line(unsafe-typecast)
            answer: int256((a.clearingPrice * (10 ** PRINT_DECIMALS)) / quoteUnit),
            startedAt: a.freezeAt,
            updatedAt: a.crossAt,
            volume: quoteVolume,
            participants: a.participants
        });
        if (day > latestPrintDay[a.token]) latestPrintDay[a.token] = day;

        emit ClosingPrintPublished(
            a.token, day, (a.clearingPrice * WAD) / quoteUnit, quoteVolume, a.participants, true
        );
    }

    function _openOrCreate(address token, uint32 day, uint8 kind, uint64 crossAt)
        internal
        returns (uint64 auctionId, Auction storage a)
    {
        bytes32 key = keccak256(abi.encode(token, day, kind));
        auctionId = auctionIds[key];
        if (auctionId == 0) {
            auctionId = ++auctionCount;
            auctionIds[key] = auctionId;
            a = auctions[auctionId];
            a.token = token;
            a.kind = kind;
            a.day = day;
            a.collarBps = COLLAR_INITIAL;
            a.crossAt = crossAt;
            a.freezeAt = crossAt - FREEZE_OFFSET;
            a.referenceAt = kind == KIND_OPEN ? crossAt + CROSS_DELAY_OPEN : crossAt;
        } else {
            a = auctions[auctionId];
        }
    }

    /// @notice Zero when no intent has ever named that cross.
    function auctionIdOf(address token, uint32 day, uint8 kind) external view returns (uint64) {
        return auctionIds[keccak256(abi.encode(token, day, kind))];
    }

    /// @dev One auction per token, kind and calendar day. An intent can name a cross
    /// that nobody has opened yet, which is what the accumulation phase needs, so
    /// the first commit is what creates the auction.
    function _nextCross(uint8 kind) internal view returns (uint32 day, uint64 crossAt) {
        Session wanted = _auctionSession(kind);
        uint64 cursor = uint64(block.timestamp);

        for (uint256 step = 0; step < MAX_LOOKAHEAD_STEPS; ++step) {
            if (sessions.sessionAt(cursor) == wanted) {
                crossAt = sessions.nextTransition(cursor);
                if (crossAt == 0) revert NoAuctionSessionAhead(kind);
                // A cross happens at 09:30 or at 16:00 New York time, and both fall
                // inside the same UTC date, so the UTC day index is the session day.
                // forge-lint: disable-next-line(unsafe-typecast)
                return (CivilDate.toYmd(uint32(crossAt / 1 days)), crossAt);
            }
            uint64 next = sessions.nextTransition(cursor);
            if (next == 0 || next <= cursor) break;
            cursor = next;
        }
        revert NoAuctionSessionAhead(kind);
    }

    function _auctionKindOf(uint8 allowedSessions) internal pure returns (uint8) {
        bool open = allowedSessions & SessionMask.AUCTION_OPEN != 0;
        bool close = allowedSessions & SessionMask.AUCTION_CLOSE != 0;
        if (open == close) revert AmbiguousAuctionSession(allowedSessions);
        return open ? KIND_OPEN : KIND_CLOSE;
    }

    function _auctionSession(uint8 kind) internal pure returns (Session) {
        return kind == KIND_OPEN ? Session.AUCTION_OPEN : Session.AUCTION_CLOSE;
    }

    function _crossSession(uint8 kind) internal pure returns (Session) {
        return kind == KIND_OPEN ? Session.OPEN : Session.POST_MARKET;
    }

    function _limitOf(Intent calldata i, bool buy) internal pure returns (uint256) {
        if (i.kind != uint8(IntentKind.LOO)) return 0;
        return buy ? (i.sellAmount * WAD) / i.minBuyAmount : (i.minBuyAmount * WAD) / i.sellAmount;
    }

    function _requireInCollar(Auction storage a, uint256 price) internal view {
        (uint256 low, uint256 high) = _collar(a.refPrice, a.collarBps);
        if (price < low || price > high) revert PriceOutsideCollar(price, low, high);
    }

    function _collar(uint256 ref, uint16 collarBps) internal pure returns (uint256 low, uint256 high) {
        low = (ref * (BPS - collarBps)) / BPS;
        high = (ref * (BPS + collarBps)) / BPS;
    }

    function _imbalance(uint256 demand, uint256 supply) internal pure returns (int256) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return int256(demand) - int256(supply);
    }

    function _refPrice(address token) internal view returns (uint256) {
        (uint256 price,, bool healthy) = oracle.refPrice(token);
        if (!healthy) revert OracleUnhealthy(token);
        return (price * quoteUnit) / WAD;
    }

    /// @dev The print is stored with eight decimals for the Chainlink surface, so
    /// the native surface converts it back to the scale the rest of the protocol
    /// speaks, which is USD in wad per 1e18 token units.
    function _toWad(int256 answer) internal pure returns (uint256) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return answer <= 0 ? 0 : (uint256(answer) * WAD) / (10 ** PRINT_DECIMALS);
    }

    function _quoteOf(uint256 tokenAmount, uint256 price) internal pure returns (uint256) {
        return (tokenAmount * price) / WAD;
    }

    function _tokenOf(uint256 quoteAmount, uint256 price) internal pure returns (uint256) {
        return (quoteAmount * WAD) / price;
    }

    /// @dev Both bonds are already held here. The winner takes its own back plus
    /// half of what the loser posted, and the other half goes to the protocol.
    function _payBond(address winner) internal {
        uint256 reward = (bond * CHALLENGE_REWARD_BPS) / BPS;
        quote.safeTransfer(winner, bond + reward);
        quote.safeTransfer(treasury, bond - reward);
    }

    function _multiplierHash(address token) internal view returns (bytes32) {
        try IUiMultiplier(token).uiMultiplier() returns (uint256 m) {
            return keccak256(abi.encode(m));
        } catch {
            return bytes32(0);
        }
    }
}
