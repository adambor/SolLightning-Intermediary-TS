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

async function main() {
    const directory = process.env.STORAGE_DIR;

    try {
        await fs.mkdir(directory)
    } catch (e) {}

    const prices = new BinanceSwapPrice(
        null,
        IntermediaryConfig.ASSETS.USDC.address.toString(),
        IntermediaryConfig.ASSETS.USDT.address.toString(),
        IntermediaryConfig.ASSETS.WSOL.address.toString(),
        IntermediaryConfig.ASSETS.WBTC.address.toString()
    );

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
        new SolanaFeeEstimator(AnchorSigner.connection, IntermediaryConfig.SOLANA.MAX_FEE_MICRO_LAMPORTS, 8, 100, "auto", IntermediaryConfig.JITO!=null ? {
            address: IntermediaryConfig.JITO.PUBKEY.toString(),
            endpoint: IntermediaryConfig.JITO.ENDPOINT,
            getStaticFee: IntermediaryConfig.JITO.STATIC_TIP!=null ? () => IntermediaryConfig.JITO.STATIC_TIP : null
        } : null)
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