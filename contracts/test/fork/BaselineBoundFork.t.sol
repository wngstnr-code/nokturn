// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {UniswapV3Adapter} from "../../src/adapters/UniswapV3Adapter.sol";
import {Addresses} from "../../script/Addresses.sol";
import {ForkFixture} from "../fixtures/ForkFixture.sol";

/// @notice What an aggregate lower bound on the baseline would cost, and what it
/// would still let through. P7-1 in pertanyaan-terbuka.md.
///
/// The contract does not compute a baseline today, it believes the one the solver
/// hands it. The cheapest bound that closes the dangerous direction is to quote the
/// pair once on the batch's own gross volume and refuse a total below it. That bound
/// is looser than the truth by exactly the pool's price impact between one combined
/// trade and the same volume split into intents, so the gap is a number rather than
/// a worry. This measures it, and measures the gas the extra call would add.
contract BaselineBoundForkTest is Test {
    UniswapV3Adapter adapter;
    address governor = address(0x60174E);

    /// parameter.md section 6 and section 1B. The launch cap, and the median ticket
    /// measured over August, which is what a real batch is actually made of.
    uint256 constant CAP_PER_BATCH_USD = 5000e6;
    uint256 constant MEDIAN_TICKET_USD = 57.44e6;

    function setUp() public {
        ForkFixture.selectMainnet();
        adapter = new UniswapV3Adapter(governor);
        address[] memory pools = Addresses.pools();
        vm.startPrank(governor);
        for (uint256 k = 0; k < pools.length; ++k) {
            adapter.setPool(pools[k]);
        }
        vm.stopPrank();
    }

    /// The residual gap, in bps of the honest baseline. A solver could still shade
    /// the total down by this much and pass the bound.
    function test_printResidualGap() public {
        address[] memory tokens = Addresses.allowlist();
        uint256[4] memory totals =
            [MEDIAN_TICKET_USD * 3, uint256(1000e6), CAP_PER_BATCH_USD, CAP_PER_BATCH_USD * 10];
        uint256[4] memory splits = [uint256(2), 3, 5, 10];

        for (uint256 k = 0; k < tokens.length; ++k) {
            console_token(tokens[k]);
            for (uint256 t = 0; t < totals.length; ++t) {
                for (uint256 sp = 0; sp < splits.length; ++sp) {
                    _report(tokens[k], totals[t], splits[sp]);
                }
            }
        }
    }

    /// What the extra call costs. One quote per pair direction per batch, which is
    /// the budget desain-ekonomi.md section 2.3 already assumes, not one per intent.
    function test_printGasPerQuote() public {
        address[] memory tokens = Addresses.allowlist();
        uint256[3] memory sizes = [MEDIAN_TICKET_USD * 3, CAP_PER_BATCH_USD, CAP_PER_BATCH_USD * 10];

        for (uint256 k = 0; k < tokens.length; ++k) {
            console_token(tokens[k]);
            for (uint256 n = 0; n < sizes.length; ++n) {
                uint256 before = gasleft();
                adapter.quoteFromState(Addresses.quote(), tokens[k], sizes[n]);
                uint256 used = before - gasleft();
                emit log_named_uint("  usd in", sizes[n] / 1e6);
                emit log_named_uint("    gas", used);
            }
        }
    }

    function _report(address token, uint256 total, uint256 parts) internal {
        uint256 combined = adapter.quoteFromState(Addresses.quote(), token, total);

        uint256 each = total / parts;
        uint256 split;
        for (uint256 p = 0; p < parts; ++p) {
            uint256 size = p == parts - 1 ? total - each * (parts - 1) : each;
            split += adapter.quoteFromState(Addresses.quote(), token, size);
        }

        emit log_named_uint("  total usd", total / 1e6);
        emit log_named_uint("    split into", parts);
        // Split always receives at least as much as one combined trade, so this is
        // how far below the honest sum the bound would still accept.
        emit log_named_uint(
            "    residual gap bps", split > combined ? ((split - combined) * 10_000) / split : 0
        );
    }

    function console_token(address token) internal {
        emit log_string("");
        emit log_named_address("token", token);
    }
}
