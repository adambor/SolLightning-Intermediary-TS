import * as dotenv from "dotenv";
dotenv.config();

import * as fs from "fs/promises";
import AnchorSigner from "./chains/solana/signer/AnchorSigner";
import {testnet} from "bitcoinjs-lib/src/networks";
import {SolanaBtcRelay, SolanaFees, SolanaSwapProgram, StoredDataAccount} from "crosslightning-solana";
import {BinanceSwapPrice, StorageManager} from "crosslightning-intermediary";
import {BitcoindRpc} from "btcrelay-bitcoind";
import {SolanaChainEvents} from "crosslightning-solana/dist/solana/events/SolanaChainEvents";
import {IntermediaryConfig} from "./IntermediaryConfig";
import {SolanaIntermediaryRunnerWrapper} from "./runner/SolanaIntermediaryRunnerWrapper";
import {PublicKey} from "@solana/web3.js";

const bitcoin_chainparams = { ...testnet };
bitcoin_chainparams.bip32 = {
    public: 0x045f1cf6,
    private: 0x045f18bc,
};

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

    const bitcoinRpc = new BitcoindRpc(
        IntermediaryConfig.BITCOIND.PROTOCOL,
        IntermediaryConfig.BITCOIND.RPC_USERNAME,
        IntermediaryConfig.BITCOIND.RPC_PASSWORD,
        IntermediaryConfig.BITCOIND.HOST,
        IntermediaryConfig.BITCOIND.PORT
    );

    console.log("[Main]: Running in bitcoin "+IntermediaryConfig.BITCOIND.NETWORK+" mode!");
    console.log("[Main]: Using RPC: "+IntermediaryConfig.SOLANA.RPC_URL+"!");

    const btcRelay = new SolanaBtcRelay(AnchorSigner, bitcoinRpc, process.env.BTC_RELAY_CONTRACT_ADDRESS);
    const swapContract = new SolanaSwapProgram(
        AnchorSigner,
        btcRelay,
        new StorageManager<StoredDataAccount>(directory+"/solaccounts"),
        process.env.SWAP_CONTRACT_ADDRESS,
        null,
        new SolanaFees(
            AnchorSigner.connection,
            IntermediaryConfig.SOLANA.MAX_FEE_MICRO_LAMPORTS,
            8,
            100,
            "auto",
            IntermediaryConfig.STATIC_TIP!=null ? () => IntermediaryConfig.STATIC_TIP : null,
            IntermediaryConfig.JITO!=null ? {
                address: IntermediaryConfig.JITO.PUBKEY.toString(),
                endpoint: IntermediaryConfig.JITO.ENDPOINT
            } : null
        )
    );
    const chainEvents = new SolanaChainEvents(directory, AnchorSigner, swapContract);

    const runner = new SolanaIntermediaryRunnerWrapper(directory, AnchorSigner, IntermediaryConfig.ASSETS, prices, bitcoinRpc, btcRelay, swapContract, chainEvents);
    await runner.init();
}

process.on('unhandledRejection', (reason: string, p: Promise<any>) => {
    console.error('Unhandled Rejection at:', p, 'reason:', reason);
});

main().catch(e => {
    console.error(e);
    process.exit(1);
});