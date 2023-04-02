import * as fs from "fs";
import * as dotenv from "dotenv";
dotenv.config();

import {createMint} from "@solana/spl-token";
import AnchorSigner from "../chains/solana/signer/AnchorSigner";

async function main() {
    const mint = await createMint(AnchorSigner.connection, AnchorSigner.signer, AnchorSigner.publicKey, null, 0);

    fs.appendFileSync(".env",
        "WBTC_ADDRESS=\""+mint.toBase58()+"\"\n");

    console.log("Token ID: ", mint);
}

main();