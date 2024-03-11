import * as dotenv from "dotenv";
dotenv.config();

import AnchorSigner from "../chains/solana/signer/AnchorSigner";

async function main() {
    console.log("Solana address: "+AnchorSigner.publicKey.toString());
}

main();