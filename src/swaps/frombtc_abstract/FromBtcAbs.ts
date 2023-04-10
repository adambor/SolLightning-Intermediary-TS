import * as cors from "cors";
import * as BN from "bn.js";
import * as lncli from "ln-service";
import LND from "../../btc/LND";
import StorageManager from "../../storagemanager/StorageManager";
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
} from "../../constants/Constants";
import SwapData from "../SwapData";
import {FromBtcSwapAbs, FromBtcSwapState} from "./FromBtcSwapAbs";
import SwapContract from "../SwapContract";
import ChainEvents from "../../events/ChainEvents";
import SwapNonce from "../SwapNonce";
import {TokenAddress} from "../TokenAddress";
import SwapEvent from "../../events/types/SwapEvent";
import InitializeEvent from "../../events/types/InitializeEvent";
import SwapType from "../SwapType";
import ClaimEvent from "../../events/types/ClaimEvent";
import RefundEvent from "../../events/types/RefundEvent";
import SwapHandler, {SwapHandlerType} from "../SwapHandler";
import ISwapPrice from "../ISwapPrice";

const CONFIRMATIONS = 1;
const SWAP_CSV_DELTA = 144; //A day
const SWAP_TS_CSV_DELTA = new BN(SWAP_CSV_DELTA).mul(BITCOIN_BLOCKTIME.div(SAFETY_FACTOR));

const REFUND_CHECK_INTERVAL = 5*60*1000;

class FromBtcAbs<T extends SwapData> extends SwapHandler<FromBtcSwapAbs<T>, T> {

    readonly type = SwapHandlerType.FROM_BTC;

    constructor(storageDirectory: string, path: string, swapContract: SwapContract<T>, chainEvents: ChainEvents<T>, swapNonce: SwapNonce, allowedTokens: TokenAddress[], swapPricing: ISwapPrice) {
        super(storageDirectory, path, swapContract, chainEvents, swapNonce, allowedTokens, swapPricing);
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

    startRestServer(restServer: Express) {

        restServer.post(this.path+"/getAddress", async (req, res) => {
            /**
             * address: string              solana address of the recipient
             * amount: string               amount (in sats) of the invoice
             * token: string                Desired token to use
             */

            if(
                req.body==null ||

                req.body.token==null ||
                typeof(req.body.token)!=="string" ||
                !this.allowedTokens.has(req.body.token)
            ) {
                res.status(400).json({
                    msg: "Invalid request body (token)"
                });
                return;
            }

            if(
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

            const useToken = this.swapContract.toTokenAddress(req.body.token);

            const swapFee = CHAIN_BASE_FEE.add(amountBD.mul(CHAIN_FEE_PPM).div(new BN(1000000)));

            const amountInToken = await this.swapPricing.getFromBtcSwapAmount(amountBD, useToken);
            const swapFeeInToken = await this.swapPricing.getFromBtcSwapAmount(swapFee, useToken);

            const balance = await this.swapContract.getBalance(useToken);

            if(amountInToken.sub(swapFeeInToken).gt(balance)) {
                res.status(400).json({
                    msg: "Not enough liquidity"
                });
                return;
            }


            const {address: receiveAddress} = await lncli.createChainAddress({
                lnd: LND,
                format: "p2wpkh"
            });

            console.log("[From BTC: REST.CreateInvoice] Created receiving address: ", receiveAddress);

            const createdSwap: FromBtcSwapAbs<T> = new FromBtcSwapAbs<T>(receiveAddress, amountBD, swapFee);

            const paymentHash = createdSwap.getHash();

            const currentTimestamp = new BN(Math.floor(Date.now()/1000));
            const expiryTimeout = SWAP_TS_CSV_DELTA;

            const data: T = this.swapContract.createSwapData(
                SwapType.CHAIN,
                this.swapContract.getAddress(),
                req.body.address,
                useToken,
                amountInToken.sub(swapFeeInToken),
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
                    swapFee: swapFeeInToken.toString(10),
                    total: amountInToken.sub(swapFeeInToken).toString(10),
                    data: data.serialize(),
                    nonce: sigData.nonce,
                    prefix: sigData.prefix,
                    timeout: sigData.timeout,
                    signature: sigData.signature
                }
            });

        });

        console.log("[From BTC: REST] Started at path: ", this.path);
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

    getInfo(): { swapFeePPM: number, swapBaseFee: number, min: number, max: number, data?: any, tokens: string[] } {
        return {
            swapFeePPM: CHAIN_FEE_PPM.toNumber(),
            swapBaseFee: CHAIN_BASE_FEE.toNumber(),
            min: CHAIN_MIN.toNumber(),
            max: CHAIN_MAX.toNumber(),
            data: {
                confirmations: CONFIRMATIONS,

                cltv: SWAP_CSV_DELTA,
                timestampCltv: SWAP_TS_CSV_DELTA.toNumber()
            },
            tokens: Array.from<string>(this.allowedTokens)
        };
    }
}

export default FromBtcAbs;