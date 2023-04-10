import * as fs from "fs";
import * as dotenv from "dotenv";
dotenv.config();

import {createMint} from "@solana/spl-token";
import AnchorSigner from "../chains/solana/signer/AnchorSigner";

async function main() {
    const mintWBTC = await createMint(AnchorSigner.connection, AnchorSigner.signer, AnchorSigner.publicKey, null, 8);
    const mintUSDC = await createMint(AnchorSigner.connection, AnchorSigner.signer, AnchorSigner.publicKey, null, 6);
    const mintUSDT = await createMint(AnchorSigner.connection, AnchorSigner.signer, AnchorSigner.publicKey, null, 6);

    fs.appendFileSync(".env",
        "WBTC_ADDRESS=\""+mintWBTC.toBase58()+"\"\n"+
        "USDC_ADDRESS=\""+mintUSDC.toBase58()+"\"\n"+
        "USDT_ADDRESS=\""+mintUSDT.toBase58()+"\"\n");

    console.log("Token ID WBTC: ", mintWBTC.toBase58());
    console.log("Token ID USDC: ", mintUSDC.toBase58());
    console.log("Token ID USDT: ", mintUSDT.toBase58());
}

main();