import * as dotenv from "dotenv";
dotenv.config();

import ToBtcLn from "./tobtcln/ToBtcLn";
import SolEvents from "./sol/SolEvents";
import Nonce from "./sol/Nonce";
import FromBtcLn from "./frombtcln/FromBtcLn";
import * as fs from "fs/promises";
import ToBtc from "./tobtc/ToBtc";
import FromBtc from "./frombtc/FromBtc";

async function main() {

    try {
        await fs.mkdir("storage")
    } catch (e) {}

    //Initialize nonce
    await Nonce.init();

    //Initialize
    const toBtc = new ToBtc("storage/tobtc", process.env.TO_BTC_PORT==null ? 4003 : parseInt(process.env.TO_BTC_PORT));
    await toBtc.init();

    const fromBtc = new FromBtc("storage/frombtc", process.env.FROM_BTC_PORT==null ? 4002 : parseInt(process.env.FROM_BTC_PORT));
    await fromBtc.init();

    const toBtcLn = new ToBtcLn("storage/tobtcln", process.env.TO_BTCLN_PORT==null ? 4001 : parseInt(process.env.TO_BTCLN_PORT));
    await toBtcLn.init();

    const fromBtcLn = new FromBtcLn("storage/frombtcln", process.env.FROM_BTCLN_PORT==null ? 4000 : parseInt(process.env.FROM_BTCLN_PORT));
    await fromBtcLn.init();

    //Sync to latest
    await SolEvents.init();

    //Start watchdogs
    await toBtc.startWatchdog();
    await fromBtc.startWatchdog();
    await toBtcLn.startWatchdog();
    await fromBtcLn.startWatchdog();

    //Start listening
    await toBtc.startRestServer();
    await fromBtc.startRestServer();
    await toBtcLn.startRestServer();
    await fromBtcLn.startRestServer();
}

main();