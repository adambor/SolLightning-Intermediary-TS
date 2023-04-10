import * as dotenv from "dotenv";
dotenv.config();

import {USDC_ADDRESS, USDT_ADDRESS, WBTC_ADDRESS} from "../constants/Constants";
import {getOrCreateAssociatedTokenAccount, mintTo} from "@solana/spl-token";
import AnchorSigner from "../chains/solana/signer/AnchorSigner";
import {PublicKey} from "@solana/web3.js";

async function mint(amount: number, acc: PublicKey, token: string): Promise<boolean> {
    let useToken;
    switch (token) {
        case "WBTC":
            useToken = WBTC_ADDRESS;
            break;
        case "USDC":
            useToken = USDC_ADDRESS;
            break;
        case "USDT":
            useToken = USDT_ADDRESS;
            break;
        default:
            return false;
    }
    const ata = await getOrCreateAssociatedTokenAccount(AnchorSigner.connection, AnchorSigner.signer, useToken, acc);

    const signature = await mintTo(AnchorSigner.connection, AnchorSigner.signer, useToken, ata.address, AnchorSigner.signer, amount);

    console.log("Mint signature: ", signature);

    return true;
}

async function main() {
    if(process.argv.length<4) {
        console.error("Needs at least 2 arguments");
        console.error("Usage: node mint.js <token:WBTC,USDC,USDT> <amount> [address (optional)]");
        return;
    }

    const token = process.argv[2];
    const amount = parseInt(process.argv[3]);

    if(isNaN(amount)) {
        console.error("Invalid amount argument (not a number)");
        return;
    }

    let pubKey = AnchorSigner.publicKey;
    if(process.argv.length>4) {
        pubKey = new PublicKey(process.argv[4]);
        if(pubKey==null) {
            console.error("Invalid address argument (not a valid solana address)");
            return;
        }
    }

    if(!(await mint(amount, pubKey, token))) {
        console.error("Invalid token argument (must be one of WBTC, USDC, USDT)");
        return;
    }
}

main();
