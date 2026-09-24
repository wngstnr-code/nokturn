import type {Abi} from "viem";
import sessionManager from "@shared/abi/SessionManager.json";
import settlement from "@shared/abi/Settlement.json";
import auctionHouse from "@shared/abi/AuctionHouse.json";
import priceOracle from "@shared/abi/PriceOracle.json";

// The full contract ABIs rather than the interface ones. Interfaces carry no
// custom errors, so a revert would reach the screen as a raw selector instead of
// as the name the contract actually chose.
export const sessionManagerAbi = sessionManager as Abi;
export const settlementAbi = settlement as Abi;
export const auctionHouseAbi = auctionHouse as Abi;
export const priceOracleAbi = priceOracle as Abi;
