import * as dotenv from "dotenv";
dotenv.config();

import {USDC_ADDRESS, USDT_ADDRESS, WBTC_ADDRESS, WSOL_ADDRESS} from "../constants/Constants";
import AnchorSigner from "../chains/solana/signer/AnchorSigner";
import {createAssociatedTokenAccountInstruction,
    createSyncNativeInstruction, getAccount, getAssociatedTokenAddress, TOKEN_PROGRAM_ID} from "@solana/spl-token";
import {BN} from "@coral-xyz/anchor";
import {SystemProgram, SYSVAR_RENT_PUBKEY, Transaction} from "@solana/web3.js";
import {SolanaBtcRelay, SolanaSwapProgram, StoredDataAccount} from "crosslightning-solana";
import BtcRPC, {BtcRPCConfig} from "../btc/BtcRPC";
import {StorageManager} from "crosslightning-intermediary";
import {BitcoindRpc} from "btcrelay-bitcoind";

async function deposit(amount: number, token: string) {

    let decimals: number;

    let useToken;
    switch (token) {
        case "WBTC":
            useToken = WBTC_ADDRESS;
            decimals = 8;
            break;
        case "USDC":
            useToken = USDC_ADDRESS;
            decimals = 6;
            break;
        case "USDT":
            useToken = USDT_ADDRESS;
            decimals = 6;
            break;
        case "WSOL":
            useToken = WSOL_ADDRESS;
            decimals = 9;
            break;
        case "SOL":
            useToken = WSOL_ADDRESS;
            decimals = 9;
            break;
        default:
            return false;
    }

    const amountBN = new BN((amount*Math.pow(10, decimals)).toFixed(0));

    const bitcoinRpc = new BitcoindRpc(
        BtcRPCConfig.protocol,
        BtcRPCConfig.user,
        BtcRPCConfig.pass,
        BtcRPCConfig.host,
        BtcRPCConfig.port
    );
    const btcRelay = new SolanaBtcRelay(AnchorSigner, bitcoinRpc);
    const swapContract = new SolanaSwapProgram(AnchorSigner, btcRelay, new StorageManager<StoredDataAccount>(""));

    console.log("Deposit sent: ", await swapContract.deposit(useToken, amountBN, true));

    return true;

}

async function main() {
    if(process.argv.length<4) {
        console.error("Needs at least 2 arguments");
        console.error("Usage: node deposit.js <token:WBTC,USDC,USDT,WSOL,SOL> <amount>");
        return;
    }

    const token = process.argv[2];
    const amount = parseInt(process.argv[3]);

    if(isNaN(amount)) {
        console.error("Invalid amount argument (not a number)");
        return;
    }

    if(!(await deposit(amount, token))) {
        console.error("Invalid token argument (must be one of WBTC, USDC, USDT, WSOL, SOL)");
    }
}

main();