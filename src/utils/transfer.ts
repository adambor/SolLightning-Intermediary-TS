import * as dotenv from "dotenv";
dotenv.config();

import {USDC_ADDRESS, USDT_ADDRESS, WBTC_ADDRESS, WSOL_ADDRESS} from "../constants/Constants";
import AnchorSigner from "../chains/solana/signer/AnchorSigner";
import {getAssociatedTokenAddress, TOKEN_PROGRAM_ID} from "@solana/spl-token";
import {BN} from "@coral-xyz/anchor";
import {PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY} from "@solana/web3.js";
import {SolanaBtcRelay, SolanaSwapProgram, StoredDataAccount} from "crosslightning-solana";
import BtcRPC, {BtcRPCConfig} from "../btc/BtcRPC";
import {StorageManager} from "crosslightning-intermediary";
import {BitcoindRpc} from "btcrelay-bitcoind";

async function withdraw(dstAddress: string, amount: number, token: string) {

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
        case "WSOL":
            useToken = WSOL_ADDRESS;
            break;
        default:
            return false;
    }

    const bitcoinRpc = new BitcoindRpc(
        BtcRPCConfig.protocol,
        BtcRPCConfig.user,
        BtcRPCConfig.pass,
        BtcRPCConfig.host,
        BtcRPCConfig.port
    );
    const btcRelay = new SolanaBtcRelay(AnchorSigner, bitcoinRpc);
    const swapContract = new SolanaSwapProgram(AnchorSigner, btcRelay, new StorageManager<StoredDataAccount>(""));

    const result = await swapContract.transfer(useToken, new BN(amount), dstAddress, true);

    console.log("Transfer sent: ", result);

    return true;

}

async function main() {
    if(process.argv.length<5) {
        console.error("Needs at least 3 arguments");
        console.error("Usage: node withdraw.js <token:WBTC,USDC,USDT> <amount> <dstAddress>");
        return;
    }

    const token = process.argv[2];
    const amount = parseInt(process.argv[3]);
    const dstAddress = process.argv[4];

    if(isNaN(amount)) {
        console.error("Invalid amount argument (not a number)");
        return;
    }

    if(!(await withdraw(dstAddress, amount, token))) {
        console.error("Invalid dstAddress or token argument (must be one of WBTC, USDC, USDT)");
    }
}

main();