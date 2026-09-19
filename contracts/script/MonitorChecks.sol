// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {AuctionHouse} from "../src/AuctionHouse.sol";
import {IPriceOracle} from "../src/interfaces/IPriceOracle.sol";

/// @title The signals of threat-model.md section 6.1 that are pure functions of state
/// @notice parameter.md section 8.3. The two signals that call pause are exactly the
/// two that need nothing but the chain as it stands right now, so the pause path
/// carries no archive node, no indexer and no local database that could drift away
/// from what the chain says. The remaining two signals need event history and never
/// call pause, so they live in tools/monitor.py instead.
library MonitorChecks {
    struct Targets {
        address settlement;
        address auctionHouse;
        address timelock;
        address oracle;
        address quote;
        address[] tokens;
    }

    struct Finding {
        string code;
        string reason;
        address subject;
        address token;
        uint256 observed;
        uint256 expected;
        bool pause;
    }

    /// Auctions run at most once per token per kind per day, so five tokens fill
    /// twenty slots in two days. Sixty four clears three days and still bounds how
    /// many state reads one pass costs. parameter.md section 8.3.
    uint64 internal constant AUCTION_LOOKBACK = 64;

    string internal constant M1 = "M1";
    string internal constant M2 = "M2";
    string internal constant M3 = "M3";
    string internal constant M4 = "M4";
    string internal constant M5 = "M5";

    uint8 internal constant PHASE_EXECUTED = 4;

    function evaluate(Targets memory t) internal view returns (Finding[] memory out) {
        address[] memory watched = _watched(t);

        Finding[] memory buffer = new Finding[](watched.length * 5);
        uint256 n;

        n = _holdsNothing(buffer, n, M1, t.settlement, watched);
        n = _holdsNothing(buffer, n, M2, t.timelock, watched);

        uint256[] memory owed;
        (n, owed) = _walkAuctions(buffer, n, t, watched);
        n = _escrowIsAllHere(buffer, n, t, owed, watched);
        n = _oracleAgrees(buffer, n, t);

        assembly ("memory-safe") {
            mstore(buffer, n)
        }
        out = buffer;
    }

    function pausesNeeded(Finding[] memory findings) internal pure returns (bool) {
        for (uint256 k = 0; k < findings.length; ++k) {
            if (findings[k].pause) return true;
        }
        return false;
    }

    /// The settlement core hands out the whole fee wedge inside the call that
    /// withheld it, and the timelock has no path that would ever give it a token.
    /// Either one holding anything is a leak, a rounding remainder or a stuck
    /// balance, and all three read the same way here.
    function _holdsNothing(
        Finding[] memory buffer,
        uint256 n,
        string memory code,
        address subject,
        address[] memory watched
    ) private view returns (uint256) {
        for (uint256 k = 0; k < watched.length; ++k) {
            uint256 held = IERC20(watched[k]).balanceOf(subject);
            if (held == 0) continue;
            buffer[n++] = Finding({
                code: code,
                reason: "holds a token it should never hold",
                subject: subject,
                token: watched[k],
                observed: held,
                expected: 0,
                pause: true
            });
        }
        return n;
    }

    /// Escrow is pulled at the freeze and released at the cross or the refund, so
    /// the book is walkable from state alone. The refund is open to anyone, which
    /// means the balance has to carry the claim rather than anyone's good faith.
    function _escrowIsAllHere(
        Finding[] memory buffer,
        uint256 n,
        Targets memory t,
        uint256[] memory owed,
        address[] memory watched
    ) private view returns (uint256) {
        for (uint256 k = 0; k < watched.length; ++k) {
            if (owed[k] == 0) continue;
            uint256 held = IERC20(watched[k]).balanceOf(t.auctionHouse);
            if (held >= owed[k]) continue;
            buffer[n++] = Finding({
                code: M3,
                reason: "escrow it took is not all here",
                subject: t.auctionHouse,
                token: watched[k],
                observed: held,
                expected: owed[k],
                pause: true
            });
        }
        return n;
    }

    /// One pass over the recent auctions answers two of the signals. Escrow that is
    /// still owed comes from the book, and a print that was withheld comes from the
    /// round the cross did or did not write.
    ///
    /// A withheld print leaves no round behind, so it cannot be read off lastClose.
    /// An executed closing auction whose day has no round is the only shape it has.
    function _walkAuctions(Finding[] memory buffer, uint256 n, Targets memory t, address[] memory watched)
        private
        view
        returns (uint256, uint256[] memory owed)
    {
        owed = new uint256[](watched.length);
        AuctionHouse house = AuctionHouse(t.auctionHouse);

        // Ids run from one, not from zero, because the house uses a pre increment
        // and reads a zero id as an auction that does not exist yet. Walking to
        // count exclusive left the newest auction unwatched.
        uint64 count = house.auctionCount();
        uint64 first = count > AUCTION_LOOKBACK ? count - AUCTION_LOOKBACK + 1 : 1;

        for (uint64 id = first; id <= count; ++id) {
            (address token, uint8 kind, uint8 phase, uint32 day,,) = house.auctionState(id);

            if (phase == PHASE_EXECUTED && kind == house.KIND_CLOSE()) {
                (,,, bool sufficient) = house.closingPrice(token, day);
                if (!sufficient) {
                    // The withheld round is all zeros, so what the auction itself
                    // matched is the only number here that says anything.
                    (,, uint256 matched,, uint32 participants,) = house.auctionResult(id);
                    buffer[n++] = Finding({
                        code: M5,
                        reason: "closing print withheld, participants against volume",
                        subject: t.auctionHouse,
                        token: token,
                        observed: participants,
                        expected: matched,
                        pause: false
                    });
                }
            }

            uint256 entries = house.bookLength(id);
            for (uint256 k = 0; k < entries; ++k) {
                AuctionHouse.Commitment memory c = house.commitment(house.bookAt(id, k));
                if (!c.escrowed || c.refunded) continue;
                uint256 index = _indexOf(watched, c.sellToken);
                if (index == type(uint256).max) continue;
                owed[index] += c.sellAmount - c.filledSell;
            }
        }
        return (n, owed);
    }

    /// Reported, never paused. A disagreement already drives the token to
    /// PROTECTIVE inside the contracts, and halting the protocol would get in the
    /// way of the response rather than help it. threat-model.md section 6.3.
    function _oracleAgrees(Finding[] memory buffer, uint256 n, Targets memory t)
        private
        view
        returns (uint256)
    {
        for (uint256 k = 0; k < t.tokens.length; ++k) {
            try IPriceOracle(t.oracle).dualCheck(t.tokens[k]) returns (
                uint256 primary, uint256 secondary, bool agree
            ) {
                if (agree) continue;
                buffer[n++] = Finding({
                    code: M4,
                    reason: "the two sources disagree, twap against feed",
                    subject: t.oracle,
                    token: t.tokens[k],
                    observed: secondary,
                    expected: primary,
                    pause: false
                });
            } catch {
                buffer[n++] = Finding({
                    code: M4,
                    reason: "the oracle cannot price this token at all",
                    subject: t.oracle,
                    token: t.tokens[k],
                    observed: 0,
                    expected: 0,
                    pause: false
                });
            }
        }
        return n;
    }

    function _watched(Targets memory t) private pure returns (address[] memory out) {
        out = new address[](t.tokens.length + 1);
        out[0] = t.quote;
        for (uint256 k = 0; k < t.tokens.length; ++k) {
            out[k + 1] = t.tokens[k];
        }
    }

    function _indexOf(address[] memory set, address needle) private pure returns (uint256) {
        for (uint256 k = 0; k < set.length; ++k) {
            if (set[k] == needle) return k;
        }
        return type(uint256).max;
    }
}
