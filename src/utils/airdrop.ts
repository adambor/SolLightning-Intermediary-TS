import * as dotenv from "dotenv";
dotenv.config();

import AnchorSigner from "../sol/AnchorSigner";

async function main() {

    let signature = await AnchorSigner.connection.requestAirdrop(AnchorSigner.publicKey, 1500000000);
    const latestBlockhash = await AnchorSigner.connection.getLatestBlockhash();
    await AnchorSigner.connection.confirmTransaction(
        {
            signature,
            ...latestBlockhash,
        },
        "confirmed"
    );

    console.log("Airdrop successful, signature: ", signature);

}

main();