import * as dotenv from "dotenv";
dotenv.config();

import * as fs from "fs/promises";
import AnchorSigner from "./chains/solana/signer/AnchorSigner";
import {testnet} from "bitcoinjs-lib/src/networks";

const bitcoin_chainparams = { ...testnet };
bitcoin_chainparams.bip32 = {
    public: 0x045f1cf6,
    private: 0x045f18bc,
};

import {SolanaBtcRelay, SolanaFeeEstimator, SolanaSwapData, SolanaSwapProgram, StoredDataAccount} from "crosslightning-solana";
import {BinanceSwapPrice, FromBtcAbs, FromBtcLnAbs,
    InfoHandler,
    SwapHandler, ToBtcAbs, ToBtcLnAbs, StorageManager, FromBtcSwapAbs, ToBtcSwapAbs, PluginManager,
    IntermediaryStorageManager,
    OneDollarFeeEstimator} from "crosslightning-intermediary";
import {BitcoindRpc} from "btcrelay-bitcoind";
import {SolanaChainEvents} from "crosslightning-solana/dist/solana/events/SolanaChainEvents";
import {IntermediaryConfig} from "./IntermediaryConfig";
import {SolanaIntermediaryRunnerWrapper} from "./runner/SolanaIntermediaryRunnerWrapper";
import {X509Certificate} from "node:crypto";
import {PublicKey} from "@solana/web3.js";

async function main() {
    const directory = process.env.STORAGE_DIR;

    try {
        await fs.mkdir(directory)
    } catch (e) {}

    const coinMap: {
        [address: string]: {
            pair: string,
            decimals: number,
            // invert: boolean
        }
    } = {};
    for(let asset in IntermediaryConfig.ASSETS) {
        const assetData: {
            address: PublicKey,
            decimals: number,
            pricing: string
        } = IntermediaryConfig.ASSETS[asset];
        coinMap[assetData.address.toString()] = {
            pair: assetData.pricing,
            decimals: assetData.decimals
        }
    }
    const prices = new BinanceSwapPrice(null, coinMap);

    console.log("[Main]: Running in bitcoin "+IntermediaryConfig.BITCOIN_NETWORK+" mode!");
    console.log("[Main]: Using RPC: "+IntermediaryConfig.SOLANA.RPC_URL+"!");

    const runner = new SolanaIntermediaryRunnerWrapper(directory, AnchorSigner, IntermediaryConfig.ASSETS, prices);
    await runner.init();
}

process.on('unhandledRejection', (reason: string, p: Promise<any>) => {
    console.error('Unhandled Rejection at:', p, 'reason:', reason);
});

main().catch(e => {
    console.error(e);
    process.exit(1);
});