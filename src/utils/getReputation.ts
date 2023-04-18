import * as dotenv from "dotenv";
dotenv.config();

import AnchorSigner from "../chains/solana/signer/AnchorSigner";
import {USDC_ADDRESS, USDT_ADDRESS, WBTC_ADDRESS} from "../constants/Constants";
import {PublicKey} from "@solana/web3.js";
import {SolanaBtcRelay, SolanaSwapProgram, StoredDataAccount} from "crosslightning-solana";
import BtcRPC, {BtcRPCConfig} from "../btc/BtcRPC";
import {StorageManager} from "crosslightning-intermediary";
import {BitcoindRpc} from "btcrelay-bitcoind";

async function printReputation(swapContract: SolanaSwapProgram, token: PublicKey) {

    const data: any = await swapContract.program.account.userAccount.fetch(swapContract.SwapUserVault(AnchorSigner.publicKey, token));

    console.log("   LN:");
    console.log("       successes: "+data.successVolume[0].toString(10)+" ("+data.successCount[0].toString(10)+")");
    console.log("       fails: "+data.failVolume[0].toString(10)+" ("+data.failCount[0].toString(10)+")");
    console.log("       coop closes: "+data.coopCloseVolume[0].toString(10)+" ("+data.coopCloseCount[0].toString(10)+")");

    console.log("   On-chain:");
    console.log("       successes: "+data.successVolume[2].toString(10)+" ("+data.successCount[2].toString(10)+")");
    console.log("       fails: "+data.failVolume[2].toString(10)+" ("+data.failCount[2].toString(10)+")");
    console.log("       coop closes: "+data.coopCloseVolume[2].toString(10)+" ("+data.coopCloseCount[2].toString(10)+")");

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
    await printReputation(swapContract, WBTC_ADDRESS);

    console.log("USDC:");
    await printReputation(swapContract, USDC_ADDRESS);

    console.log("USDT:");
    await printReputation(swapContract, USDT_ADDRESS);

}

main();