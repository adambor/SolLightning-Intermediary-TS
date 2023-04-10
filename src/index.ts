import * as dotenv from "dotenv";
dotenv.config();

import * as fs from "fs/promises";
import SwapNonce from "./swaps/SwapNonce";
import SolanaBtcRelay from "./chains/solana/btcrelay/SolanaBtcRelay";
import AnchorSigner from "./chains/solana/signer/AnchorSigner";
import SolanaSwapProgram from "./chains/solana/swaps/SolanaSwapProgram";
import ToBtcAbs from "./swaps/tobtc_abstract/ToBtcAbs";
import SolanaChainEvents from "./chains/solana/events/SolanaChainEvents";
import {USDC_ADDRESS, USDT_ADDRESS, WBTC_ADDRESS} from "./constants/Constants";
import ToBtcLnAbs from "./swaps/tobtcln_abstract/ToBtcLnAbs";
import SolanaSwapData from "./chains/solana/swaps/SolanaSwapData";
import FromBtcAbs from "./swaps/frombtc_abstract/FromBtcAbs";
import FromBtcLnAbs from "./swaps/frombtcln_abstract/FromBtcLnAbs";
import SwapHandler from "./swaps/SwapHandler";
import * as express from "express";
import * as cors from "cors";
import * as lncli from "ln-service";
import InfoHandler from "./info/InfoHandler";
import LND from "./btc/LND";
import * as bitcoin from "bitcoinjs-lib";
import {testnet} from "bitcoinjs-lib/src/networks";

const bitcoin_chainparams = { ...testnet };
bitcoin_chainparams.bip32 = {
    public: 0x045f1cf6,
    private: 0x045f18bc,
};

import BIP32Factory from 'bip32';
import * as ecc from 'tiny-secp256k1';
import CoinGeckoSwapPrice from "./prices/CoinGeckoSwapPrice";

const bip32 = BIP32Factory(ecc);

async function main() {

    const directory = "./storage";

    try {
        await fs.mkdir(directory)
    } catch (e) {}

    const nonce = new SwapNonce(directory);
    await nonce.init();

    console.log("[Main]: Nonce initialized!");

    const btcRelay = new SolanaBtcRelay(AnchorSigner);
    const swapContract = new SolanaSwapProgram(AnchorSigner, btcRelay, directory+"/solaccounts");
    const chainEvents = new SolanaChainEvents(directory, AnchorSigner, swapContract);

    const allowedTokens = [
        USDC_ADDRESS==null ? "" : USDC_ADDRESS.toBase58(),
        USDT_ADDRESS==null ? "" : USDT_ADDRESS.toBase58(),
        "So11111111111111111111111111111111111111112",
        WBTC_ADDRESS.toBase58()
    ];

    const prices = new CoinGeckoSwapPrice(null, allowedTokens[0], allowedTokens[1], allowedTokens[2], allowedTokens[3]);

    await swapContract.init();
    console.log("[Main]: Swap contract initialized!");

    const swapHandlers: SwapHandler<any, SolanaSwapData>[] = [];

    swapHandlers.push(
        new ToBtcAbs<SolanaSwapData>(directory+"/tobtc", "/tobtc", swapContract, chainEvents, nonce, allowedTokens, prices)
    );
    swapHandlers.push(
        new FromBtcAbs<SolanaSwapData>(directory+"/frombtc", "/frombtc", swapContract, chainEvents, nonce, allowedTokens, prices)
    );

    swapHandlers.push(
        new ToBtcLnAbs<SolanaSwapData>(directory+"/tobtcln", "/tobtcln", swapContract, chainEvents, nonce, allowedTokens, prices)
    );
    swapHandlers.push(
        new FromBtcLnAbs<SolanaSwapData>(directory+"/frombtcln", "/frombtcln", swapContract, chainEvents, nonce, allowedTokens, prices)
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

    const restServer = express();
    restServer.use(cors());
    restServer.use(express.json());

    const infoHandler = new InfoHandler(swapContract, "", swapHandlers);

    for(let swapHandler of swapHandlers) {
        swapHandler.startRestServer(restServer);
    }

    infoHandler.startRestServer(restServer);

    const listenPort = process.env.REST_PORT==null ? 4000 : parseInt(process.env.REST_PORT);

    restServer.listen(listenPort);

    console.log("[Main]: Rest server listening on port: ", listenPort)

}

async function test() {

    const {keys} = await lncli.getMasterPublicKeys({lnd: LND});

    const timestamp = Date.now();

    const bech32Key = keys.find(e => e.derivation_path.startsWith("m/84'"));

    console.log(bech32Key);

    const pubRoot = bip32.fromBase58(bech32Key.extended_public_key, bitcoin_chainparams);

    for(let i=0;i<bech32Key.external_key_count;i++) {
        const node = pubRoot.derivePath("0/" + i);
        const address = bitcoin.payments.p2wpkh({ pubkey: node.publicKey, network: bitcoin_chainparams });
        //console.log("Address: ", address);
    }

    for(let i=0;i<bech32Key.internal_key_count;i++) {
        const node = pubRoot.derivePath("1/" + i);
        const address = bitcoin.payments.p2wpkh({ pubkey: node.publicKey, network: bitcoin_chainparams });
        //console.log("Address: ", address);
    }

    console.log("Time taken: ", Date.now()-timestamp)
}

main().catch(e => console.error(e));