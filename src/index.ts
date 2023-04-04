import * as dotenv from "dotenv";
dotenv.config();

import * as fs from "fs/promises";
import SwapNonce from "./swaps/SwapNonce";
import SolanaBtcRelay from "./chains/solana/btcrelay/SolanaBtcRelay";
import AnchorSigner from "./chains/solana/signer/AnchorSigner";
import SolanaSwapProgram from "./chains/solana/swaps/SolanaSwapProgram";
import ToBtcAbs from "./swaps/tobtc_abstract/ToBtcAbs";
import SolanaChainEvents from "./chains/solana/events/SolanaChainEvents";
import {WBTC_ADDRESS} from "./constants/Constants";
import ToBtcLnAbs from "./swaps/tobtcln_abstract/ToBtcLnAbs";
import SolanaSwapData from "./chains/solana/swaps/SolanaSwapData";
import FromBtcAbs from "./swaps/frombtc_abstract/FromBtcAbs";
import FromBtcLnAbs from "./swaps/frombtcln_abstract/FromBtcLnAbs";
import SwapHandler from "./swaps/SwapHandler";
import * as express from "express";
import * as cors from "cors";
import InfoHandler from "./info/InfoHandler";

async function main() {

    const directory = "./storage";

    try {
        await fs.mkdir(directory)
    } catch (e) {}

    const nonce = new SwapNonce(directory);
    await nonce.init();

    console.log("[Main]: Nonce initialized!");

    const btcRelay = new SolanaBtcRelay(AnchorSigner);
    const swapContract = new SolanaSwapProgram(AnchorSigner, btcRelay, directory+"/solaccounts");
    const chainEvents = new SolanaChainEvents(directory, AnchorSigner, swapContract);

    await swapContract.init();
    console.log("[Main]: Swap contract initialized!");

    const swapHandlers: SwapHandler[] = [];

    swapHandlers.push(
        new ToBtcAbs<SolanaSwapData>(directory+"/tobtc", "/tobtc", swapContract, chainEvents, nonce, WBTC_ADDRESS)
    );
    swapHandlers.push(
        new FromBtcAbs<SolanaSwapData>(directory+"/frombtc", "/frombtc", swapContract, chainEvents, nonce, WBTC_ADDRESS)
    );

    swapHandlers.push(
        new ToBtcLnAbs<SolanaSwapData>(directory+"/tobtcln", "/tobtcln", swapContract, chainEvents, nonce, WBTC_ADDRESS)
    );
    swapHandlers.push(
        new FromBtcLnAbs<SolanaSwapData>(directory+"/frombtcln", "/frombtcln", swapContract, chainEvents, nonce, WBTC_ADDRESS)
    );

    for(let swapHandler of swapHandlers) {
        await swapHandler.init();
    }

    console.log("[Main]: Swap handlers initialized!");

    await chainEvents.init();

    console.log("[Main]: Chain events synchronized!");

    for(let swapHandler of swapHandlers) {
        await swapHandler.startWatchdog();
    }

    console.log("[Main]: Watchdogs started!");

    const restServer = express();
    restServer.use(cors());
    restServer.use(express.json());

    const infoHandler = new InfoHandler(swapContract, "", swapHandlers);

    for(let swapHandler of swapHandlers) {
        swapHandler.startRestServer(restServer);
    }

    infoHandler.startRestServer(restServer);

    const listenPort = process.env.REST_PORT==null ? 4000 : parseInt(process.env.REST_PORT);

    restServer.listen(listenPort);

    console.log("[Main]: Rest server listening on port: ", listenPort)

}

main();