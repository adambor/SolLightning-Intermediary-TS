import * as dotenv from "dotenv";
dotenv.config();

import * as fs from "fs/promises";
import AnchorSigner from "./chains/solana/signer/AnchorSigner";
import {
    BITCOIN_BLOCKTIME, BITCOIN_NETWORK,
    CHAIN_BASE_FEE,
    CHAIN_FEE_PPM,
    CHAIN_MAX,
    CHAIN_MIN, CHAIN_SEND_SAFETY_FACTOR,
    GRACE_PERIOD,
    LN_BASE_FEE,
    LN_FEE_PPM,
    LN_MAX,
    LN_MIN,
    MAX_SOL_SKEW, NETWORK_FEE_MULTIPLIER_PPM,
    SAFETY_FACTOR,
    USDC_ADDRESS,
    USDT_ADDRESS,
    WBTC_ADDRESS
} from "./constants/Constants";
import * as express from "express";
import * as cors from "cors";
import {testnet} from "bitcoinjs-lib/src/networks";
import * as http2 from "http2";

const http2Express = require('http2-express-bridge')

const bitcoin_chainparams = { ...testnet };
bitcoin_chainparams.bip32 = {
    public: 0x045f1cf6,
    private: 0x045f18bc,
};

import {SolanaBtcRelay, SolanaFeeEstimator, SolanaSwapData, SolanaSwapProgram, StoredDataAccount} from "crosslightning-solana";
import BtcRPC, {BtcRPCConfig} from "./btc/BtcRPC";
import * as BN from "bn.js";
import {AUTHORIZATION_TIMEOUT} from "./constants/Constants";
import LND from "./btc/LND";
import {BinanceSwapPrice, FromBtcAbs, FromBtcLnAbs,
    InfoHandler,
    SwapHandler, ToBtcAbs, ToBtcLnAbs, StorageManager, FromBtcSwapAbs, ToBtcSwapAbs, PluginManager,
    IntermediaryStorageManager,
    OneDollarFeeEstimator} from "crosslightning-intermediary";
import {BitcoindRpc} from "btcrelay-bitcoind";
import {SolanaChainEvents} from "crosslightning-solana/dist/solana/events/SolanaChainEvents";
import {getEnabledPlugins} from "./plugins";

const jitoPubkey = "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL";
const jitoEndpoint = "https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/transactions";

const SECURITY_DEPOSIT_APY = 0.2; //20% p.a.

async function main() {

    const directory = "./storage";

    try {
        await fs.mkdir(directory)
    } catch (e) {}

    const allowedTokens = [
        USDC_ADDRESS==null ? "" : USDC_ADDRESS.toBase58(),
        USDT_ADDRESS==null ? "" : USDT_ADDRESS.toBase58(),
        "So11111111111111111111111111111111111111112",
        WBTC_ADDRESS.toBase58()
    ];

    const prices = new BinanceSwapPrice(null, allowedTokens[0], allowedTokens[1], allowedTokens[2], allowedTokens[3]);

    const bitcoinRpc = new BitcoindRpc(
        BtcRPCConfig.protocol,
        BtcRPCConfig.user,
        BtcRPCConfig.pass,
        BtcRPCConfig.host,
        BtcRPCConfig.port
    );

    console.log("[Main]: Running in bitcoin "+process.env.BTC_NETWORK+" mode!");
    console.log("[Main]: Using RPC: "+process.env.SOL_RPC_URL+"!");

    console.log("[Main]: Nonce initialized!");

    let maxFee: number = process.env.SOL_MAX_FEE_MICRO_LAMPORTS==null ? null : parseInt(process.env.SOL_MAX_FEE_MICRO_LAMPORTS);
    if(maxFee!=null && !isNaN(maxFee)) {
        console.log("[Main]: Using max fee: "+maxFee+"!");
    } else {
        maxFee = 250000;
    }

    const btcRelay = new SolanaBtcRelay(AnchorSigner, bitcoinRpc, process.env.BTC_RELAY_CONTRACT_ADDRESS);
    const swapContract = new SolanaSwapProgram(
        AnchorSigner,
        btcRelay,
        new StorageManager<StoredDataAccount>(directory+"/solaccounts"),
        process.env.SWAP_CONTRACT_ADDRESS,
        null,
        new SolanaFeeEstimator(AnchorSigner.connection, maxFee, 8, 100, "auto", {
            address: jitoPubkey,
            endpoint: jitoEndpoint,
            getStaticFee: () => new BN(100000)
        })
    );
    const chainEvents = new SolanaChainEvents(directory, AnchorSigner, swapContract);

    await swapContract.start();
    console.log("[Main]: Swap contract initialized!");

    getEnabledPlugins(
        prices,
        bitcoinRpc,
        btcRelay,
        swapContract,
        chainEvents
    ).forEach(plugin => PluginManager.registerPlugin(plugin));

    await PluginManager.enable(swapContract, btcRelay, chainEvents, LND);

    const swapHandlers: SwapHandler<any, SolanaSwapData>[] = [];

    swapHandlers.push(
        new ToBtcAbs<SolanaSwapData>(new IntermediaryStorageManager(directory+"/tobtc"), "/tobtc", swapContract, chainEvents, allowedTokens, LND, prices, bitcoinRpc, {
            authorizationTimeout: AUTHORIZATION_TIMEOUT,
            bitcoinBlocktime: BITCOIN_BLOCKTIME,
            gracePeriod: GRACE_PERIOD,
            baseFee: CHAIN_BASE_FEE,
            feePPM: CHAIN_FEE_PPM,
            max: CHAIN_MAX,
            min: CHAIN_MIN,
            maxSkew: MAX_SOL_SKEW,
            safetyFactor: SAFETY_FACTOR,
            sendSafetyFactor: CHAIN_SEND_SAFETY_FACTOR,

            bitcoinNetwork: BITCOIN_NETWORK,

            minChainCltv: new BN(10),

            networkFeeMultiplierPPM: NETWORK_FEE_MULTIPLIER_PPM,
            minConfirmations: 1,
            maxConfirmations: 6,
            maxConfTarget: 12,
            minConfTarget: 1,

            txCheckInterval: 10*1000,
            swapCheckInterval: 5*60*1000,

            feeEstimator: new OneDollarFeeEstimator(
                BtcRPCConfig.host,
                BtcRPCConfig.port,
                BtcRPCConfig.user,
                BtcRPCConfig.pass
            )
        })
    );
    swapHandlers.push(
        new FromBtcAbs<SolanaSwapData>(new IntermediaryStorageManager(directory+"/frombtc"), "/frombtc", swapContract, chainEvents, allowedTokens, LND, prices, {
            authorizationTimeout: AUTHORIZATION_TIMEOUT,
            bitcoinBlocktime: BITCOIN_BLOCKTIME,
            baseFee: CHAIN_BASE_FEE,
            feePPM: CHAIN_FEE_PPM,
            max: CHAIN_MAX,
            min: CHAIN_MIN,
            maxSkew: MAX_SOL_SKEW,
            safetyFactor: SAFETY_FACTOR,

            bitcoinNetwork: BITCOIN_NETWORK,

            confirmations: 2,
            swapCsvDelta: 72,

            refundInterval: 5*60*1000,
            securityDepositAPY: SECURITY_DEPOSIT_APY
        })
    );

    swapHandlers.push(
        new ToBtcLnAbs<SolanaSwapData>(new IntermediaryStorageManager(directory+"/tobtcln"), "/tobtcln", swapContract, chainEvents, allowedTokens, LND, prices, {
            authorizationTimeout: AUTHORIZATION_TIMEOUT,
            bitcoinBlocktime: BITCOIN_BLOCKTIME,
            gracePeriod: GRACE_PERIOD,
            baseFee: LN_BASE_FEE,
            feePPM: LN_FEE_PPM,
            max: LN_MAX,
            min: LN_MIN,
            maxSkew: MAX_SOL_SKEW,
            safetyFactor: SAFETY_FACTOR,

            routingFeeMultiplier: new BN(2),

            minSendCltv: new BN(10),

            swapCheckInterval: 5*60*1000,

            allowShortExpiry: process.env.ALLOW_LN_SHORT_EXPIRY==="true",
            allowProbeFailedSwaps: process.env.ALLOW_NON_PROBABLE_SWAPS==="true"
        })
    );
    swapHandlers.push(
        new FromBtcLnAbs<SolanaSwapData>(new IntermediaryStorageManager(directory+"/frombtcln"), "/frombtcln", swapContract, chainEvents, allowedTokens, LND, prices, {
            authorizationTimeout: AUTHORIZATION_TIMEOUT,
            bitcoinBlocktime: BITCOIN_BLOCKTIME,
            gracePeriod: GRACE_PERIOD,
            baseFee: LN_BASE_FEE,
            feePPM: LN_FEE_PPM,
            max: LN_MAX,
            min: LN_MIN,
            maxSkew: MAX_SOL_SKEW,
            safetyFactor: SAFETY_FACTOR,

            minCltv: new BN(20),

            refundInterval: 1*60*1000,
            securityDepositAPY: SECURITY_DEPOSIT_APY
        })
    );

    for(let swapHandler of swapHandlers) {
        await swapHandler.init();
    }

    console.log("[Main]: Swap handlers initialized!");

    await chainEvents.init();

    console.log("[Main]: Chain events synchronized!");

    for(let swapHandler of swapHandlers) {
        await swapHandler.startWatchdog();
    }

    console.log("[Main]: Watchdogs started!");

    const restServer = http2Express(express);
    restServer.use(cors());

    const infoHandler = new InfoHandler(swapContract, "", swapHandlers);

    for(let swapHandler of swapHandlers) {
        swapHandler.startRestServer(restServer);
    }

    infoHandler.startRestServer(restServer);

    await PluginManager.onHttpServerStarted(restServer);

    const listenPort = process.env.REST_PORT==null ? 4000 : parseInt(process.env.REST_PORT);

    const server = http2.createSecureServer(
        {
            key: await fs.readFile(process.env.SSL_KEY),
            cert: await fs.readFile(process.env.SSL_CERT),
            allowHTTP1: true
        },
        restServer
    );

    await new Promise<void>(resolve => server.listen(listenPort, () => resolve()));

    console.log("[Main]: Rest server listening on port: ", listenPort)

}

process.on('unhandledRejection', (reason: string, p: Promise<any>) => {
    console.error('Unhandled Rejection at:', p, 'reason:', reason);
});

main().catch(e => console.error(e));