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

async function main() {

    const directory = "./storage";

    try {
        await fs.mkdir(directory)
    } catch (e) {}

    const nonce = new SwapNonce(directory);
    await nonce.init();

    const btcRelay = new SolanaBtcRelay(AnchorSigner);
    const swapContract = new SolanaSwapProgram(AnchorSigner, btcRelay);
    const chainEvents = new SolanaChainEvents(directory, AnchorSigner, swapContract);

    const toBtc = new ToBtcAbs<SolanaSwapData>(directory+"/tobtc", process.env.TO_BTC_PORT==null ? 4003 : parseInt(process.env.TO_BTC_PORT), swapContract, chainEvents, nonce, WBTC_ADDRESS);
    await toBtc.init();

    const fromBtc = new FromBtcAbs<SolanaSwapData>(directory+"/frombtc", process.env.FROM_BTC_PORT==null ? 4002 : parseInt(process.env.FROM_BTC_PORT), swapContract, chainEvents, nonce, WBTC_ADDRESS);
    await fromBtc.init();

    const toBtcLn = new ToBtcLnAbs<SolanaSwapData>(directory+"/tobtcln", process.env.TO_BTCLN_PORT==null ? 4001 : parseInt(process.env.TO_BTCLN_PORT), swapContract, chainEvents, nonce, WBTC_ADDRESS);
    await toBtcLn.init();

    const fromBtcLn = new FromBtcLnAbs<SolanaSwapData>(directory+"/frombtcln", process.env.FROM_BTCLN_PORT==null ? 4000 : parseInt(process.env.FROM_BTCLN_PORT), swapContract, chainEvents, nonce, WBTC_ADDRESS);
    await fromBtcLn.init();

    await chainEvents.init();

    await toBtc.startWatchdog();
    await fromBtc.startWatchdog();
    await toBtcLn.startWatchdog();
    await fromBtcLn.startWatchdog();

    await toBtc.startRestServer();
    await fromBtc.startRestServer();
    await toBtcLn.startRestServer();
    await fromBtcLn.startRestServer();

    // //Initialize nonce
    // await Nonce.init();
    //
    // //Initialize
    // const toBtc = new ToBtc("storage/tobtc", process.env.TO_BTC_PORT==null ? 4003 : parseInt(process.env.TO_BTC_PORT));
    // await toBtc.init();
    //
    // const fromBtc = new FromBtc("storage/frombtc", process.env.FROM_BTC_PORT==null ? 4002 : parseInt(process.env.FROM_BTC_PORT));
    // await fromBtc.init();
    //
    // const toBtcLn = new ToBtcLn("storage/tobtcln", process.env.TO_BTCLN_PORT==null ? 4001 : parseInt(process.env.TO_BTCLN_PORT));
    // await toBtcLn.init();
    //
    // const fromBtcLn = new FromBtcLn("storage/frombtcln", process.env.FROM_BTCLN_PORT==null ? 4000 : parseInt(process.env.FROM_BTCLN_PORT));
    // await fromBtcLn.init();
    //
    // //Sync to latest
    // await SolEvents.init();
    //
    // //Start watchdogs
    // await toBtc.startWatchdog();
    // await fromBtc.startWatchdog();
    // await toBtcLn.startWatchdog();
    // await fromBtcLn.startWatchdog();
    //
    // //Start listening
    // await toBtc.startRestServer();
    // await fromBtc.startRestServer();
    // await toBtcLn.startRestServer();
    // await fromBtcLn.startRestServer();
}

main();