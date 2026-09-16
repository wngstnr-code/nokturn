// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Execution, Intent} from "../types/Types.sol";

interface IAuctionHouse {
    event AuctionOpened(uint64 indexed auctionId, address indexed token, uint8 kind, uint64 crossAt);

    /// @notice The liquidity invitation. Cheap to read and easy to subscribe to on purpose.
    event IndicativePublished(
        uint64 indexed auctionId,
        address indexed token,
        uint256 indicativePrice,
        int256 imbalance,
        uint256 matchedVolume
    );

    event AuctionFrozen(uint64 indexed auctionId, uint256 committedIntents, uint256 escrowedValue);
    event CrossSubmitted(uint64 indexed auctionId, address indexed solver, uint256 price, uint256 volume);
    event CrossChallenged(
        uint64 indexed auctionId,
        address indexed challenger,
        uint256 oldPrice,
        uint256 newPrice,
        bool successful
    );
    event AuctionExtended(uint64 indexed auctionId, uint8 extensionCount, uint16 newCollarBps);
    event CrossExecuted(
        uint64 indexed auctionId, address indexed token, uint256 price, uint256 volume, uint32 participants
    );
    event ClosingPrintPublished(
        address indexed token,
        uint32 indexed day,
        uint256 price,
        uint256 volume,
        uint32 participants,
        bool sufficient
    );

    /// @notice Emitted when PRINT_MIN_VOLUME or PRINT_MIN_PARTICIPANTS is not met.
    /// No new round is created, so latestRoundData keeps returning the last valid
    /// print with its own older updatedAt.
    event ClosingPrintWithheld(
        address indexed token, uint32 indexed day, bytes32 reason, uint256 volume, uint32 participants
    );

    event AuctionAborted(uint64 indexed auctionId, bytes32 reason);
    event EscrowRefunded(bytes32 indexed intentHash, address indexed owner, uint256 amount);

    function commitAuctionIntent(Intent calldata i, bytes calldata sig) external;
    function cancelBeforeFreeze(bytes32 intentHash) external;
    function publishIndicative(uint64 auctionId) external;
    function submitCross(uint64 auctionId, uint256 price, Execution[] calldata e) external;
    function challenge(uint64 auctionId, uint256 betterPrice) external payable;
    function executeCross(uint64 auctionId) external;

    /// @notice Callable by anyone, always. Escrow is never trapped by an aborted auction.
    function refundEscrow(bytes32 intentHash) external;

    function closingPrice(address token, uint32 day)
        external
        view
        returns (uint256 price, uint256 volume, uint32 participants, bool sufficient);

    function lastClose(address token) external view returns (uint256 price, uint64 ts, bool sufficient);
}
