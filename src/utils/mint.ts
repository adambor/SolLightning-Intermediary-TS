import * as dotenv from "dotenv";
dotenv.config();

import {WBTC_ADDRESS} from "../Constants";
import {getOrCreateAssociatedTokenAccount, mintTo} from "@solana/spl-token";
import AnchorSigner from "../sol/AnchorSigner";
import {PublicKey} from "@solana/web3.js";

async function mint(amount: number, acc: PublicKey) {
    const ata = await getOrCreateAssociatedTokenAccount(AnchorSigner.connection, AnchorSigner.signer, WBTC_ADDRESS, acc);

    const signature = await mintTo(AnchorSigner.connection, AnchorSigner.signer, WBTC_ADDRESS, ata.address, AnchorSigner.signer, amount);

    console.log("Mint signature: ", signature);
}

async function main() {
    if(process.argv.length<3) {
        console.error("Needs at least 1 argument");
        console.error("Usage: node mint.js <amount> [address (optional)]");
        return;
    }

    const amount = parseInt(process.argv[2]);

    if(isNaN(amount)) {
        console.error("Invalid amount argument (not a number)");
        return;
    }

    let pubKey = AnchorSigner.publicKey;
    if(process.argv.length>3) {
        pubKey = new PublicKey(process.argv[3]);
        if(pubKey==null) {
            console.error("Invalid address argument (not a valid solana address)");
            return;
        }
    }

    mint(amount, pubKey);
}

main();
