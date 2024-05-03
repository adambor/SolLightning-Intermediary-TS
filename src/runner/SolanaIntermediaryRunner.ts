import {getEnabledPlugins} from "../plugins";
import {getAuthenticatedLndGrpc, getUnauthenticatedLndGrpc} from "../btc/LND";
import {
    AUTHORIZATION_TIMEOUT,
    BITCOIN_BLOCKTIME, BITCOIN_NETWORK, CHAIN_SEND_SAFETY_FACTOR,
    GRACE_PERIOD,
    MAX_SOL_SKEW, NETWORK_FEE_MULTIPLIER_PPM,
    SAFETY_FACTOR
} from "../constants/Constants";
import {IntermediaryConfig} from "../IntermediaryConfig";
import * as BN from "bn.js";
import * as http2 from "http2";
import * as fs from "fs/promises";
import {
    FromBtcAbs,
    FromBtcLnAbs,
    IBtcFeeEstimator,
    InfoHandler,
    IntermediaryStorageManager, ISwapPrice, OneDollarFeeEstimator, PluginManager, SwapHandler, ToBtcAbs, ToBtcLnAbs} from "crosslightning-intermediary";
import {BitcoinRpc, BtcRelay, BtcSyncInfo, ChainEvents, SwapContract, SwapData} from "crosslightning-base";
import http2Express from "http2-express-bridge";
import * as express from "express";
import * as cors from "cors";
import {AuthenticatedLnd, UnauthenticatedLnd} from "lightning";
import * as lncli from "ln-service";
import {AnchorProvider} from "@coral-xyz/anchor";
import {Keypair, PublicKey} from "@solana/web3.js";
import {LetsEncryptACME} from "../LetsEncryptACME";
import * as tls from "node:tls";


export class SolanaIntermediaryRunner<T extends SwapData> {

    readonly directory: string;
    readonly tokens: {
        [ticker: string]: {
            address: PublicKey,
            decimals: number
        }
    };
    readonly allowedTokens: string[];
    readonly prices: ISwapPrice;
    readonly bitcoinRpc: BitcoinRpc<any>;
    readonly btcRelay: BtcRelay<any, any, any>;
    readonly swapContract: SwapContract<T, any, any, any>;
    readonly chainEvents: ChainEvents<T>;
    readonly signer: (AnchorProvider & {signer: Keypair});

    readonly btcFeeEstimator: IBtcFeeEstimator;
    readonly swapHandlers: SwapHandler<any, T>[] = [];
    infoHandler: InfoHandler<T>;
    LND: AuthenticatedLnd;

    constructor(
        directory: string,
        signer: (AnchorProvider & {signer: Keypair}),
        tokens: {
            [ticker: string]: {
                address: PublicKey,
                decimals: number
            }
        },
        prices: ISwapPrice,
        bitcoinRpc: BitcoinRpc<any>,
        btcRelay: BtcRelay<any, any, any>,
        swapContract: SwapContract<T, any, any, any>,
        chainEvents: ChainEvents<T>
    ) {
        this.directory = directory;
        this.signer = signer;
        this.tokens = tokens;
        this.allowedTokens = Object.keys(IntermediaryConfig.ASSETS).map<string>(key => IntermediaryConfig.ASSETS[key].toString());
        this.prices = prices;
        this.bitcoinRpc = bitcoinRpc;
        this.btcRelay = btcRelay;
        this.swapContract = swapContract;
        this.chainEvents = chainEvents;

        this.btcFeeEstimator = new OneDollarFeeEstimator(
            IntermediaryConfig.BITCOIND.HOST,
            IntermediaryConfig.BITCOIND.PORT,
            IntermediaryConfig.BITCOIND.RPC_USERNAME,
            IntermediaryConfig.BITCOIND.RPC_PASSWORD
        );
    }

    /**
     * Checks if IBD on the bitcoind has finished yet
     */
    async waitForBitcoinRpc() {
        console.log("[Main] Waiting for bitcoin RPC...");
        let rpcState: BtcSyncInfo = null;
        while(rpcState==null || rpcState.ibd) {
            rpcState = await this.bitcoinRpc.getSyncInfo().catch(e => {
                console.error(e);
                return null;
            });
            console.log("[Main] Bitcoin RPC state: ", rpcState==null ? "offline" : rpcState.ibd ? "IBD" : "ready");
            if(rpcState==null || rpcState.ibd) await new Promise(resolve => setTimeout(resolve, 30*1000));
        }
        console.log("[Main] Bitcoin RPC ready, continue");
    }

    async getLNDWalletStatus(lnd: UnauthenticatedLnd): Promise<"offline" | "ready" | "active" | "waiting" | "starting" | "absent" | "locked"> {
        let walletStatus = null;
        try {
            walletStatus = await lncli.getWalletStatus({lnd});
        } catch (e) {
            console.error(e);
            return "offline";
        }
        if (walletStatus.is_absent) return "absent";
        if (walletStatus.is_active) return "active";
        if (walletStatus.is_locked) return "locked";
        if (walletStatus.is_ready) return "ready";
        if (walletStatus.is_starting) return "starting";
        if (walletStatus.is_waiting) return "waiting";
    }

    async tryConnectLNDWallet(): Promise<boolean> {
        let lnd: UnauthenticatedLnd;
        try {
            lnd = getUnauthenticatedLndGrpc();
        } catch (e) {
            console.error(e);
            throw new Error("Error creating unathenticated connection to LND, cert file probably missing!");
        }

        const walletStatus = await this.getLNDWalletStatus(lnd);

        console.log("[Main] LND wallet status: "+walletStatus);

        if(walletStatus==="active" || walletStatus==="ready") return true;
        if(walletStatus==="waiting" || walletStatus==="starting" || walletStatus==="offline") return false;
        if(walletStatus==="absent") {
            //Create a new wallet based on the the seed in LND mnemonic file config
            if(IntermediaryConfig.LND.MNEMONIC_FILE==null || IntermediaryConfig.LND.WALLET_PASSWORD_FILE==null) {
                throw new Error("Error initializing LND, no mnemonic and/or wallet password provided!");
            }
            let mnemonic: string;
            let password: string;
            try {
                const result = await fs.readFile(IntermediaryConfig.LND.MNEMONIC_FILE);
                mnemonic = result.toString();
                const resultPass = await fs.readFile(IntermediaryConfig.LND.WALLET_PASSWORD_FILE);
                password = resultPass.toString();
            } catch (e) {
                console.error(e);
            }
            if(mnemonic==null) {
                throw new Error("Invalid LND mnemonic file provided!");
            }
            if(password==null) {
                throw new Error("Invalid LND wallet password file provided!");
            }
            await lncli.createWallet({
                lnd,
                seed: mnemonic,
                password
            });
            return false;
        }
        if(walletStatus==="locked") {
            if(IntermediaryConfig.LND.WALLET_PASSWORD_FILE==null) {
                throw new Error("Error initializing LND, no wallet password provided!");
            }
            let password: string;
            try {
                const resultPass = await fs.readFile(IntermediaryConfig.LND.WALLET_PASSWORD_FILE);
                password = resultPass.toString();
            } catch (e) {
                console.error(e);
            }
            if(password==null) {
                throw new Error("Invalid LND wallet password file provided!");
            }
            await lncli.unlockWallet({
                lnd,
                password
            });
            return false;
        }

    }

    /**
     * Checks if LND wallet is unlocked and ready to roll
     */
    async waitForLNDWallet() {
        console.log("[Main] Waiting for LND wallet initialization...");
        let lndReady: boolean = false;
        while(!lndReady) {
            lndReady = await this.tryConnectLNDWallet();
            if(!lndReady) await new Promise(resolve => setTimeout(resolve, 30*1000));
        }
        console.log("[Main] LND wallet ready, continue!");
    }

    /**
     * Checks if LND node is synchronized and ready
     */
    async waitForLNDSync() {
        console.log("[Main] Waiting for LND node synchronization...");
        let lndReady: boolean = false;
        while(!lndReady) {
            const resp = await lncli.getWalletInfo({
                lnd: this.LND
            });
            console.log("[Main] LND blockheight: "+resp.current_block_height+" is_synced: "+resp.is_synced_to_chain);
            if(resp.is_synced_to_chain) lndReady = true;
            if(!lndReady) await new Promise(resolve => setTimeout(resolve, 30*1000));
        }
        console.log("[Main] LND node ready, continue!");
    }

    async registerPlugins(): Promise<void> {
        const plugins = await getEnabledPlugins();
        plugins.forEach(pluginData => PluginManager.registerPlugin(pluginData.name, pluginData.plugin));
        await PluginManager.enable(
            this.swapContract,
            this.btcRelay,
            this.chainEvents,
            this.bitcoinRpc,
            this.LND,
            this.prices,
            this.tokens,
            process.env.PLUGINS_DIR
        );
    }

    registerSwapHandlers(): void {
        this.swapHandlers.push(
            new ToBtcAbs<T>(new IntermediaryStorageManager(this.directory+"/tobtc"), "/tobtc", this.swapContract, this.chainEvents, this.allowedTokens, this.LND, this.prices, this.bitcoinRpc, {
                authorizationTimeout: AUTHORIZATION_TIMEOUT,
                bitcoinBlocktime: BITCOIN_BLOCKTIME,
                gracePeriod: GRACE_PERIOD,
                baseFee: IntermediaryConfig.ONCHAIN.BASE_FEE,
                feePPM: IntermediaryConfig.ONCHAIN.FEE_PERCENTAGE,
                max: IntermediaryConfig.ONCHAIN.MAX,
                min: IntermediaryConfig.ONCHAIN.MIN,
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

                feeEstimator: this.btcFeeEstimator
            })
        );

        this.swapHandlers.push(
            new FromBtcAbs<T>(new IntermediaryStorageManager(this.directory+"/frombtc"), "/frombtc", this.swapContract, this.chainEvents, this.allowedTokens, this.LND, this.prices, {
                authorizationTimeout: AUTHORIZATION_TIMEOUT,
                bitcoinBlocktime: BITCOIN_BLOCKTIME,
                baseFee: IntermediaryConfig.ONCHAIN.BASE_FEE,
                feePPM: IntermediaryConfig.ONCHAIN.FEE_PERCENTAGE,
                max: IntermediaryConfig.ONCHAIN.MAX,
                min: IntermediaryConfig.ONCHAIN.MIN,
                maxSkew: MAX_SOL_SKEW,
                safetyFactor: SAFETY_FACTOR,

                bitcoinNetwork: BITCOIN_NETWORK,

                confirmations: 2,
                swapCsvDelta: 72,

                refundInterval: 5*60*1000,
                securityDepositAPY: IntermediaryConfig.SOLANA.SECURITY_DEPOSIT_APY.toNumber()/1000000
            })
        );

        this.swapHandlers.push(
            new ToBtcLnAbs<T>(new IntermediaryStorageManager(this.directory+"/tobtcln"), "/tobtcln", this.swapContract, this.chainEvents, this.allowedTokens, this.LND, this.prices, {
                authorizationTimeout: AUTHORIZATION_TIMEOUT,
                bitcoinBlocktime: BITCOIN_BLOCKTIME,
                gracePeriod: GRACE_PERIOD,
                baseFee: IntermediaryConfig.LN.BASE_FEE,
                feePPM: IntermediaryConfig.LN.FEE_PERCENTAGE,
                max: IntermediaryConfig.LN.MAX,
                min: IntermediaryConfig.LN.MIN,
                maxSkew: MAX_SOL_SKEW,
                safetyFactor: SAFETY_FACTOR,

                routingFeeMultiplier: new BN(2),

                minSendCltv: new BN(10),

                swapCheckInterval: 5*60*1000,

                allowShortExpiry: IntermediaryConfig.LN.ALLOW_LN_SHORT_EXPIRY,
                allowProbeFailedSwaps: IntermediaryConfig.LN.ALLOW_NON_PROBABLE_SWAPS
            })
        );
        this.swapHandlers.push(
            new FromBtcLnAbs<T>(new IntermediaryStorageManager(this.directory+"/frombtcln"), "/frombtcln", this.swapContract, this.chainEvents, this.allowedTokens, this.LND, this.prices, {
                authorizationTimeout: AUTHORIZATION_TIMEOUT,
                bitcoinBlocktime: BITCOIN_BLOCKTIME,
                gracePeriod: GRACE_PERIOD,
                baseFee: IntermediaryConfig.LN.BASE_FEE,
                feePPM: IntermediaryConfig.LN.FEE_PERCENTAGE,
                max: IntermediaryConfig.LN.MAX,
                min: IntermediaryConfig.LN.MIN,
                maxSkew: MAX_SOL_SKEW,
                safetyFactor: SAFETY_FACTOR,

                minCltv: new BN(20),

                refundInterval: 1*60*1000,
                securityDepositAPY: IntermediaryConfig.SOLANA.SECURITY_DEPOSIT_APY.toNumber()/1000000
            })
        );
    }

    initSwapHandlers(): Promise<void[]> {
        return Promise.all(this.swapHandlers.map(service => service.init()));
    }

    startHandlerWatchdogs(): Promise<void[]> {
        return Promise.all(this.swapHandlers.map(service => service.startWatchdog()));
    }

    async startRestServer() {

        let useSsl = false;
        let key: Buffer;
        let cert: Buffer;

        let server: http2.Http2Server | http2.Http2SecureServer;

        const renewCallback = (_key: Buffer, _cert: Buffer) => {
            key = _key;
            cert = _cert;
            if(server instanceof tls.Server) {
                server.setSecureContext({
                    key,
                    cert
                });
            }
        }

        if(IntermediaryConfig.SSL_AUTO!=null) {
            console.log("[Main]: Using automatic SSL cert provision through Let's Encrypt & dns proxy: "+process.env.DNS_PROXY);
            useSsl = true;
            let address: string;
            try {
                const addressBuff = await fs.readFile(IntermediaryConfig.SSL_AUTO.IP_ADDRESS_FILE);
                address = addressBuff.toString();
            } catch (e) {
                console.error(e);
                throw new Error("Cannot read SSL_AUTO.IP_ADDRESS_FILE");
            }
            console.log("[Main]: IP address: "+address);
            const dir = this.directory+"/ssl";
            try {
                await fs.mkdir(dir);
            } catch (e) {}

            const ipWithDashes = address.replace(new RegExp("\\.", 'g'), "-");
            console.log("[Main]: Domain name: "+address);
            const acme = new LetsEncryptACME(ipWithDashes+"."+process.env.DNS_PROXY, dir+"/key.pem", dir+"/cert.pem", IntermediaryConfig.SSL_AUTO.HTTP_LISTEN_PORT);

            await acme.init(renewCallback);
        }
        if(IntermediaryConfig.SSL!=null) {
            console.log("[Main]: Using existing SSL certs");
            useSsl = true;

            key = await fs.readFile(IntermediaryConfig.SSL.KEY_FILE);
            cert = await fs.readFile(IntermediaryConfig.SSL.CERT_FILE);

            (async() => {
                for await (let change of fs.watch(IntermediaryConfig.SSL.KEY_FILE)) {
                    if(change.eventType==="change") {
                        try {
                            renewCallback(await fs.readFile(IntermediaryConfig.SSL.KEY_FILE), cert);
                        } catch (e) {
                            console.log("SSL KEY watcher error: ", e);
                            console.error(e);
                        }
                    }
                }
            })();
            (async() => {
                for await (let change of fs.watch(IntermediaryConfig.SSL.CERT_FILE)) {
                    if(change.eventType==="change") {
                        try {
                            renewCallback(key, await fs.readFile(IntermediaryConfig.SSL.CERT_FILE));
                        } catch (e) {
                            console.log("SSL CERT watcher error: ", e);
                            console.error(e);
                        }
                    }
                }
            })();
        }

        const restServer = http2Express(express);
        restServer.use(cors());

        for(let swapHandler of this.swapHandlers) {
            swapHandler.startRestServer(restServer);
        }
        this.infoHandler.startRestServer(restServer);

        await PluginManager.onHttpServerStarted(restServer);

        const listenPort = process.env.REST_PORT==null ? 4000 : parseInt(process.env.REST_PORT);

        if(useSsl) {
            server = http2.createServer(restServer);
        } else {
            server = http2.createSecureServer(
                {
                    key,
                    cert,
                    allowHTTP1: true
                },
                restServer
            );
        }

        await new Promise<void>(resolve => server.listen(listenPort, () => resolve()));

        console.log("[Main]: Rest server listening on port: "+listenPort+" ssl: "+useSsl);
    }

    async init() {
        await this.waitForBitcoinRpc();
        await this.waitForLNDWallet();
        this.LND = getAuthenticatedLndGrpc();
        await this.waitForLNDSync();

        await this.swapContract.start();
        console.log("[Main]: Swap contract initialized!");

        await this.registerPlugins();

        console.log("[Main]: Plugins registered!");

        this.registerSwapHandlers();
        this.infoHandler = new InfoHandler<T>(this.swapContract, "", this.swapHandlers);

        console.log("[Main]: Swap handlers registered!");

        await this.initSwapHandlers();

        console.log("[Main]: Swap handlers initialized!");

        await this.chainEvents.init();

        console.log("[Main]: Chain events synchronized!");

        await this.startHandlerWatchdogs();

        console.log("[Main]: Watchdogs started!");

        await this.startRestServer();
    }

}