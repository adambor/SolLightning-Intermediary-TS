import * as dotenv from "dotenv";
dotenv.config();

import AnchorSigner from "../chains/solana/signer/AnchorSigner";
import {USDC_ADDRESS, USDT_ADDRESS, WBTC_ADDRESS, WSOL_ADDRESS} from "../constants/Constants";
import {PublicKey} from "@solana/web3.js";
import {SolanaBtcRelay, SolanaSwapProgram, StoredDataAccount} from "crosslightning-solana";
import BtcRPC, {BtcRPCConfig} from "../btc/BtcRPC";
import {StorageManager} from "crosslightning-intermediary";
import {BitcoindRpc} from "btcrelay-bitcoind";

async function printBalance(swapContract: SolanaSwapProgram, token: PublicKey) {

    const data: any = await swapContract.program.account.userAccount.fetch(swapContract.SwapUserVault(AnchorSigner.publicKey, token));

    console.log(data.amount.toString(10));

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
    await printBalance(swapContract, WBTC_ADDRESS);

    console.log("USDC:");
    await printBalance(swapContract, USDC_ADDRESS);

    console.log("USDT:");
    await printBalance(swapContract, USDT_ADDRESS);

    console.log("WSOL:");
    await printBalance(swapContract, WSOL_ADDRESS);

}

main();