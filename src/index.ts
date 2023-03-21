import * as dotenv from "dotenv";
dotenv.config();

import ToBtcLn from "./tobtcln/ToBtcLn";
import SolEvents from "./sol/SolEvents";
import Nonce from "./sol/Nonce";
import FromBtcLn from "./frombtcln/FromBtcLn";
import * as fs from "fs/promises";

async function main() {

    try {
        await fs.mkdir("storage")
    } catch (e) {}

    await Nonce.init();

    const toBtcLn = new ToBtcLn("storage/tobtcln", 4001);
    await toBtcLn.init();

    const fromBtcLn = new FromBtcLn("storage/frombtcln", 4000);
    await fromBtcLn.init();

    await SolEvents.init();

}

main();