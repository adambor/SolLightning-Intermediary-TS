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
    const toBtc = new ToBtc("storage/tobtc", 4003);
    await toBtc.init();

    const fromBtc = new FromBtc("storage/frombtc", 4002);
    await fromBtc.init();

    const toBtcLn = new ToBtcLn("storage/tobtcln", 4001);
    await toBtcLn.init();

    const fromBtcLn = new FromBtcLn("storage/frombtcln", 4000);
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