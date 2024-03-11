import * as dotenv from "dotenv";
dotenv.config();

import AnchorSigner from "../chains/solana/signer/AnchorSigner";
import {USDC_ADDRESS, USDT_ADDRESS, WBTC_ADDRESS, WSOL_ADDRESS} from "../constants/Constants";
import {PublicKey} from "@solana/web3.js";
import {SolanaBtcRelay, SolanaSwapProgram, StoredDataAccount} from "crosslightning-solana";
import BtcRPC, {BtcRPCConfig} from "../btc/BtcRPC";
import {StorageManager} from "crosslightning-intermediary";
import {BitcoindRpc} from "btcrelay-bitcoind";
import * as BN from "bn.js";

async function printBalance(swapContract: SolanaSwapProgram, token: PublicKey, decimals: number) {

    const data: BN = await swapContract.getBalance(token, true);

    console.log(data==null ? "0" : (data.toNumber()/Math.pow(10, decimals)).toFixed(decimals));

}

async function main() {

    const bitcoinRpc = new BitcoindRpc(
        BtcRPCConfig.protocol,
        BtcRPCConfig.user,
        BtcRPCConfig.pass,
        BtcRPCConfig.host,
        BtcRPCConfig.port
    );
    const btcRelay = new SolanaBtcRelay(AnchorSigner, bitcoinRpc);
    const swapContract = new SolanaSwapProgram(AnchorSigner, btcRelay, new StorageManager<StoredDataAccount>(""));

    console.log("WBTC:");
    await printBalance(swapContract, WBTC_ADDRESS, 8);

    console.log("USDC:");
    await printBalance(swapContract, USDC_ADDRESS, 6);

    console.log("USDT:");
    await printBalance(swapContract, USDT_ADDRESS, 6);

    console.log("SOL/WSOL:");
    await printBalance(swapContract, WSOL_ADDRESS, 9);

}

main();