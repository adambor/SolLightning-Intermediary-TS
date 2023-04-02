import * as cors from "cors";
import * as BN from "bn.js";
import * as lncli from "ln-service";
import LND from "../btc/LND";
import StorageManager from "../StorageManager";
import * as express from "express";
import {Express} from "express";
import {
    BITCOIN_BLOCKTIME,
    CHAIN_BASE_FEE,
    CHAIN_FEE_PPM,
    CHAIN_MAX,
    CHAIN_MIN,
    MAX_SOL_SKEW,
    SAFETY_FACTOR
} from "../Constants";
import SwapData from "../swaps/SwapData";
import {FromBtcSwapAbs, FromBtcSwapState} from "./FromBtcSwapAbs";
import SwapContract from "../swaps/SwapContract";
import ChainEvents from "../events/ChainEvents";
import SwapNonce from "../swaps/SwapNonce";
import {TokenAddress} from "../swaps/TokenAddress";
import SwapEvent from "../events/types/SwapEvent";
import InitializeEvent from "../events/types/InitializeEvent";
import SwapType from "../swaps/SwapType";
import ClaimEvent from "../events/types/ClaimEvent";
import RefundEvent from "../events/types/RefundEvent";

const CONFIRMATIONS = 1;
const SWAP_CSV_DELTA = 144; //A day

const REFUND_CHECK_INTERVAL = 5*60*1000;

class FromBtcAbs<T extends SwapData> {

    storageManager: StorageManager<FromBtcSwapAbs<T>>;
    restPort: number;
    restServer: Express;

    readonly swapContract: SwapContract<T>;
    readonly chainEvents: ChainEvents<T>;
    readonly nonce: SwapNonce;
    readonly WBTC_ADDRESS: TokenAddress;

    constructor(storageDirectory: string, restPort: number, swapContract: SwapContract<T>, chainEvents: ChainEvents<T>, swapNonce: SwapNonce, WBTC_ADDRESS: TokenAddress) {
        this.storageManager = new StorageManager<FromBtcSwapAbs<T>>(storageDirectory);
        this.restPort = restPort;
        this.swapContract = swapContract;
        this.chainEvents = chainEvents;
        this.nonce = swapNonce;
        this.WBTC_ADDRESS = WBTC_ADDRESS;
    }

    async checkPastSwaps() {

        const removeSwaps: Buffer[] = [];
        const refundSwaps: FromBtcSwapAbs<T>[] = [];

        for(let key in this.storageManager.data) {
            const swap = this.storageManager.data[key];

            const currentTime = new BN(Math.floor(Date.now()/1000)-MAX_SOL_SKEW);

            if(swap.state===FromBtcSwapState.CREATED) {
                //Invoice is expired
                if(swap.authorizationExpiry.lt(currentTime)) {
                    removeSwaps.push(swap.getHash());
                }
                continue;
            }

            const expiryTime = swap.data.getExpiry();
            if(swap.state===FromBtcSwapState.COMMITED) {
                if(expiryTime.lt(currentTime)) {
                    const isCommited = await this.swapContract.isCommited(swap.data);

                    if(isCommited) {
                        refundSwaps.push(swap);
                    }
                }
            }
        }

        for(let swapHash of removeSwaps) {
            await this.storageManager.removeData(swapHash);
        }

        for(let refundSwap of refundSwaps) {
            const unlock = refundSwap.lock(this.swapContract.refundTimeout);
            if(unlock==null) continue;
            await this.swapContract.refund(refundSwap.data);
            unlock();
        }
    }

    async processEvent(eventData: SwapEvent<T>[]): Promise<boolean> {

        for(let event of eventData) {

            if(event instanceof InitializeEvent) {
                if (!this.swapContract.areWeOfferer(event.swapData)) {
                    continue;
                }

                if (event.swapData.isPayIn()) {
                    //Only process requests that don't pay in from the program
                    continue;
                }

                if (event.swapData.getType() !== SwapType.CHAIN) {
                    //Only process nonced on-chain requests
                    continue;
                }

                const paymentHash = event.paymentHash;
                const paymentHashBuffer = Buffer.from(paymentHash, "hex");
                const savedSwap = this.storageManager.data[paymentHash];

                if (savedSwap != null) {
                    savedSwap.state = FromBtcSwapState.COMMITED;
                }

                const usedNonce = event.signatureNonce;
                if (usedNonce > this.nonce.getNonce()) {
                    await this.nonce.saveNonce(usedNonce);
                }

                if (savedSwap != null) {
                    savedSwap.data = event.swapData;
                    await this.storageManager.saveData(paymentHashBuffer, savedSwap);
                }

                continue;
            }
            if(event instanceof ClaimEvent) {
                const paymentHashHex = event.paymentHash;
                const paymentHash: Buffer = Buffer.from(paymentHashHex, "hex");

                const savedSwap = this.storageManager.data[paymentHashHex];

                if (savedSwap == null) {
                    continue;
                }

                console.log("[From BTC: Solana.ClaimEvent] Swap claimed by claimer: ", paymentHashHex);
                await this.storageManager.removeData(paymentHash);

                continue;
            }
            if(event instanceof RefundEvent) {
                continue;
            }
        }

        return true;
    }

    startRestServer() {
        this.restServer = express();
        this.restServer.use(cors());
        this.restServer.use(express.json());

        this.restServer.post("/getAddress", async (req, res) => {
            /**
             * address: string              solana address of the recipient
             * amount: string               amount (in sats) of the invoice
             */

            if(
                req.body==null ||

                req.body.address==null ||
                typeof(req.body.address)!=="string"
            ) {
                res.status(400).json({
                    msg: "Invalid request body (address)"
                });
                return;
            }

            try {
                if(!this.swapContract.isValidAddress(req.body.address)) {
                    res.status(400).json({
                        msg: "Invalid request body (address)"
                    });
                    return;
                }
            } catch (e) {
                res.status(400).json({
                    msg: "Invalid request body (address)"
                });
                return;
            }

            if(
                req.body.amount==null ||
                typeof(req.body.amount)!=="string"
            ) {
                res.status(400).json({
                    msg: "Invalid request body (amount)"
                });
                return;
            }

            let amountBD: BN;
            try {
                amountBD = new BN(req.body.amount);
            } catch (e) {
                res.status(400).json({
                    msg: "Invalid request body (amount)"
                });
                return;
            }

            if(amountBD.lt(CHAIN_MIN)) {
                res.status(400).json({
                    msg: "Amount too low"
                });
                return;
            }

            if(amountBD.gt(CHAIN_MAX)) {
                res.status(400).json({
                    msg: "Amount too high"
                });
                return;
            }

            const balance = await this.swapContract.getBalance(this.WBTC_ADDRESS);

            if(amountBD.gt(balance)) {
                res.status(400).json({
                    msg: "Not enough liquidity"
                });
                return;
            }

            const swapFee = CHAIN_BASE_FEE.add(amountBD.mul(CHAIN_FEE_PPM).div(new BN(1000000)));

            const {address: receiveAddress} = await lncli.createChainAddress({
                lnd: LND,
                format: "p2wpkh"
            });

            console.log("[From BTC: REST.CreateInvoice] Created receiving address: ", receiveAddress);

            const createdSwap: FromBtcSwapAbs<T> = new FromBtcSwapAbs<T>(receiveAddress, amountBD, swapFee);

            const paymentHash = createdSwap.getHash();

            const currentTimestamp = new BN(Math.floor(Date.now()/1000));
            const expiryTimeout = new BN(SWAP_CSV_DELTA).mul(BITCOIN_BLOCKTIME.div(SAFETY_FACTOR));

            const data: T = this.swapContract.createSwapData(
                SwapType.CHAIN,
                this.swapContract.getAddress(),
                req.body.address,
                this.WBTC_ADDRESS,
                amountBD.sub(swapFee),
                paymentHash.toString("hex"),
                currentTimestamp.add(expiryTimeout),
                new BN(0),
                CONFIRMATIONS,
                null
            );

            createdSwap.data = data;

            const sigData = await this.swapContract.getInitSignature(data, this.nonce);

            createdSwap.authorizationExpiry = new BN(sigData.timeout);

            await this.storageManager.saveData(createdSwap.getHash(), createdSwap);

            res.status(200).json({
                code: 10000,
                msg: "Success",
                data: {
                    btcAddress: receiveAddress,
                    address: this.swapContract.getAddress(),
                    data: data.serialize(),
                    nonce: sigData.nonce,
                    prefix: sigData.prefix,
                    timeout: sigData.timeout,
                    signature: sigData.signature
                }
            });

        });

        this.restServer.listen(this.restPort);

        console.log("[From BTC: REST] Started on port: ", this.restPort);
    }

    subscribeToEvents() {
        this.chainEvents.registerListener(this.processEvent.bind(this));

        console.log("[From BTC: Solana.Events] Subscribed to Solana events");
    }

    async startWatchdog() {
        let rerun;
        rerun = async () => {
            await this.checkPastSwaps();
            setTimeout(rerun, REFUND_CHECK_INTERVAL);
        };
        await rerun();
    }

    async init() {
        await this.storageManager.loadData(FromBtcSwapAbs);
        this.subscribeToEvents();
    }
}

export default FromBtcAbs;