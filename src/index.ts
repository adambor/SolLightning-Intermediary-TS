import * as dotenv from "dotenv";
dotenv.config();

import * as fs from "fs/promises";
import SwapNonce from "./swaps/SwapNonce";
import SolanaBtcRelay from "./chains/solana/btcrelay/SolanaBtcRelay";
import AnchorSigner from "./chains/solana/signer/AnchorSigner";
import SolanaSwapProgram from "./chains/solana/swaps/SolanaSwapProgram";
import ToBtcAbs from "./tobtc_abstract/ToBtcAbs";
import SolanaChainEvents from "./chains/solana/events/SolanaChainEvents";
import {WBTC_ADDRESS} from "./Constants";
import ToBtcLnAbs from "./tobtcln_abstract/ToBtcLnAbs";
import SolanaSwapData from "./chains/solana/swaps/SolanaSwapData";
import FromBtcAbs from "./frombtc_abstract/FromBtcAbs";
import FromBtcLnAbs from "./frombtcln_abstract/FromBtcLnAbs";
import SwapHandler from "./swaps/SwapHandler";

async function main() {

    const directory = "./storage";

    try {
        await fs.mkdir(directory)
    } catch (e) {}

    const nonce = new SwapNonce(directory);
    await nonce.init();

    const btcRelay = new SolanaBtcRelay(AnchorSigner);
    const swapContract = new SolanaSwapProgram(AnchorSigner, btcRelay, directory+"/solaccounts");
    const chainEvents = new SolanaChainEvents(directory, AnchorSigner, swapContract);

    await swapContract.init();

    const swapHandlers: SwapHandler[] = [];

    swapHandlers.push(
        new ToBtcAbs<SolanaSwapData>(directory+"/tobtc", process.env.TO_BTC_PORT==null ? 4003 : parseInt(process.env.TO_BTC_PORT), swapContract, chainEvents, nonce, WBTC_ADDRESS)
    );
    swapHandlers.push(
        new FromBtcAbs<SolanaSwapData>(directory+"/frombtc", process.env.FROM_BTC_PORT==null ? 4002 : parseInt(process.env.FROM_BTC_PORT), swapContract, chainEvents, nonce, WBTC_ADDRESS)
    );

    swapHandlers.push(
        new ToBtcLnAbs<SolanaSwapData>(directory+"/tobtcln", process.env.TO_BTCLN_PORT==null ? 4001 : parseInt(process.env.TO_BTCLN_PORT), swapContract, chainEvents, nonce, WBTC_ADDRESS)
    );
    swapHandlers.push(
        new FromBtcLnAbs<SolanaSwapData>(directory+"/frombtcln", process.env.FROM_BTCLN_PORT==null ? 4000 : parseInt(process.env.FROM_BTCLN_PORT), swapContract, chainEvents, nonce, WBTC_ADDRESS)
    );

    for(let swapHandler of swapHandlers) {
        await swapHandler.init();
    }

    await chainEvents.init();

    for(let swapHandler of swapHandlers) {
        await swapHandler.startWatchdog();
    }

    for(let swapHandler of swapHandlers) {
        swapHandler.startRestServer();
    }

}

main();