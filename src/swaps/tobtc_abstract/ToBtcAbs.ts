import StorageManager from "../../storagemanager/StorageManager";
import * as express from "express";
import {Express} from "express";
import * as cors from "cors";
import * as BN from "bn.js";
import * as bitcoin from "bitcoinjs-lib";
import {
    BITCOIN_BLOCKTIME,
    BITCOIN_NETWORK,
    CHAIN_BASE_FEE,
    CHAIN_FEE_PPM,
    CHAIN_MAX,
    CHAIN_MIN,
    CHAIN_SEND_SAFETY_FACTOR,
    GRACE_PERIOD, LN_BASE_FEE, LN_FEE_PPM,
    NETWORK_FEE_MULTIPLIER_PPM,
    SAFETY_FACTOR
} from "../../constants/Constants";
import * as lncli from "ln-service";
import LND from "../../btc/LND";
import BtcRPC from "../../btc/BtcRPC";
import SwapData from "../SwapData";
import {ToBtcSwapAbs, ToBtcSwapState} from "./ToBtcSwapAbs";
import SwapContract from "../SwapContract";
import SwapEvent from "../../events/types/SwapEvent";
import ClaimEvent from "../../events/types/ClaimEvent";
import RefundEvent from "../../events/types/RefundEvent";
import InitializeEvent from "../../events/types/InitializeEvent";
import SwapType from "../SwapType";
import {TokenAddress} from "../TokenAddress";
import SwapNonce from "../SwapNonce";
import ChainEvents from "../../events/ChainEvents";
import SwapHandler, {SwapHandlerType} from "../SwapHandler";
import {MAX_SOL_SKEW} from "../../../dist/Constants";
import ISwapPrice from "../ISwapPrice";

const TX_CHECK_INTERVAL = 10*1000;

const MIN_ONCHAIN_END_CTLV = new BN(10);

const MAX_CONFIRMATIONS = 6;
const MIN_CONFIRMATIONS = 2;

const MAX_CONFIRMATION_TARGET = 6;
const MIN_CONFIRMATION_TARGET = 1;

const OUTPUT_SCRIPT_MAX_LENGTH = 200;

const SWAP_CHECK_INTERVAL = 1*60*1000;

class ToBtcAbs<T extends SwapData> extends SwapHandler<ToBtcSwapAbs<T>, T>  {

    readonly type = SwapHandlerType.TO_BTC;

    activeSubscriptions: {[txId: string]: ToBtcSwapAbs<T>} = {};

    constructor(storageDirectory: string, path: string, swapContract: SwapContract<T>, chainEvents: ChainEvents<T>, swapNonce: SwapNonce, allowedTokens: TokenAddress[], swapPricing: ISwapPrice) {
        super(storageDirectory, path, swapContract, chainEvents, swapNonce, allowedTokens, swapPricing);
    }

    async processPaymentResult(tx: {blockhash: string, confirmations: number, txid: string, hex: string}, payment: ToBtcSwapAbs<T>, vout: number): Promise<boolean> {
        //Set flag that we are sending the transaction already, so we don't end up with race condition
        const unlock: () => boolean = payment.lock(this.swapContract.claimWithTxDataTimeout);

        if(unlock==null) return false;

        const result = await this.swapContract.claimWithTxData(payment.data, tx, vout);

        unlock();

        return result;
    }

    async checkPastSwaps() {

        for(let key in this.storageManager.data) {
            const payment: ToBtcSwapAbs<T> = this.storageManager.data[key];

            const timestamp = new BN(Math.floor(Date.now()/1000)).sub(new BN(MAX_SOL_SKEW));

            if(payment.state===ToBtcSwapState.SAVED && payment.signatureExpiry!=null) {
                if(payment.signatureExpiry.lt(timestamp)) {
                    //Signature expired
                    await this.storageManager.removeData(payment.getHash());
                    continue;
                }
            }

            if(payment.state===ToBtcSwapState.NON_PAYABLE || payment.state===ToBtcSwapState.SAVED) {
                if(payment.data.getExpiry().lt(timestamp)) {
                    //Expired
                    await this.storageManager.removeData(payment.getHash());
                    continue;
                }
            }

            if(payment.state===ToBtcSwapState.COMMITED || payment.state===ToBtcSwapState.BTC_SENDING || payment.state===ToBtcSwapState.BTC_SENT) {
                await this.processInitialized(payment, payment.data);
                continue;
            }

        }

    }

    async checkBtcTxs() {

        for(let txId in this.activeSubscriptions) {
            const payment: ToBtcSwapAbs<T> = this.activeSubscriptions[txId];
            let tx;
            try {
                tx = await new Promise((resolve, reject) => {
                    BtcRPC.getRawTransaction(txId, 1, (err, info) => {
                        if(err) {
                            reject(err);
                            return;
                        }
                        resolve(info.result);
                    });
                });
            } catch (e) {
                console.error(e);
            }

            if(tx==null) {
                continue;
            }

            if(tx.confirmations==null) tx.confirmations = 0;

            if(tx.confirmations<payment.data.getConfirmations()) {
                //not enough confirmations
                continue;
            }

            const outputScript = bitcoin.address.toOutputScript(payment.address, BITCOIN_NETWORK);

            console.log("[To BTC: Bitcoin.CheckTransactions] TX vouts: ", tx.vout);
            console.log("[To BTC: Bitcoin.CheckTransactions] Required output script: ", outputScript.toString("hex"));
            console.log("[To BTC: Bitcoin.CheckTransactions] Required amount: ", payment.amount.toString(10));

            const vout = tx.vout.find(e => new BN(e.value*100000000).eq(payment.amount) && Buffer.from(e.scriptPubKey.hex, "hex").equals(outputScript));

            if(vout==null) {
                console.error("Cannot find vout!!");
                continue;
            }

            const success = await this.processPaymentResult(tx, payment, vout.n);

            if(success) delete this.activeSubscriptions[txId];
        }

    }

    subscribeToPayment(payment) {
        this.activeSubscriptions[payment.txId] = payment;
    }

    async processInitialized(payment: ToBtcSwapAbs<T>, data: T) {

        if(payment.state===ToBtcSwapState.BTC_SENDING) {
            //Payment was signed (maybe also sent)
            let tx;
            try {
                tx = await new Promise((resolve, reject) => {
                    BtcRPC.getRawTransaction(payment.txId, 1, (err, info) => {
                        if(err) {
                            reject(err);
                            return;
                        }
                        resolve(info.result);
                    });
                });
            } catch (e) {
                console.error(e);
            }

            if(tx==null) {
                //Reset the state to COMMITED
                payment.state = ToBtcSwapState.COMMITED;
            } else {
                payment.state = ToBtcSwapState.BTC_SENT;
                await this.storageManager.saveData(payment.getHash(), payment);
            }
        }

        const setNonPayableAndSave = async() => {
            payment.state = ToBtcSwapState.NON_PAYABLE;
            payment.data = data;
            await this.storageManager.saveData(payment.getHash(), payment);
        };

        if(payment.state===ToBtcSwapState.SAVED) {
            if(!data.isToken(payment.data.getToken())) {
                console.error("[To BTC: Solana.Initialize] Invalid token used");
                await setNonPayableAndSave();
                return;
            }

            payment.state = ToBtcSwapState.COMMITED;
            payment.data = data;
            await this.storageManager.saveData(payment.getHash(), payment);
        }

        if(payment.state===ToBtcSwapState.COMMITED) {
            console.log("[To BTC: Solana.Initialize] Struct: ", data);

            const currentTimestamp = new BN(Math.floor(Date.now()/1000));
            const tsDelta = payment.data.getExpiry().sub(currentTimestamp);

            const minRequiredCLTV = ToBtcAbs.getExpiryFromCLTV(payment.preferedConfirmationTarget, payment.data.getConfirmations());

            if(tsDelta.lt(minRequiredCLTV)) {
                console.error("[To BTC: Solana.Initialize] TS delta too low, required: "+minRequiredCLTV.toString(10)+" has: "+tsDelta.toString(10));
                await setNonPayableAndSave();
                return;
            }

            const maxNetworkFee = payment.networkFee;

            let fundPsbtResponse;
            try {
                fundPsbtResponse = await lncli.fundPsbt({
                    lnd: LND,
                    outputs: [
                        {
                            address: payment.address,
                            tokens: payment.amount.toNumber()
                        }
                    ],
                    target_confirmations: payment.preferedConfirmationTarget,
                    min_confirmations: 0 //TODO: This might not be the best idea
                });
            } catch (e) {
                console.error(e);
            }

            if(fundPsbtResponse==null) {
                //Here we can retry later, so it stays in COMMITED state
                console.error("[To BTC: Solana.Initialize] Failed to call fundPsbt on LND");
                return;
            }

            let psbt = bitcoin.Psbt.fromHex(fundPsbtResponse.psbt);

            //Apply nonce
            const nonceBN = data.getEscrowNonce();
            const nonceBuffer = Buffer.from(nonceBN.toArray("be", 8));

            const locktimeBN = new BN(nonceBuffer.slice(0, 5), "be");
            const sequenceBN = new BN(nonceBuffer.slice(5, 8), "be");

            let locktime = locktimeBN.toNumber();
            console.log("[To BTC: Solana.Initialize] Nonce locktime: ", locktime);

            locktime += 500000000;
            psbt.setLocktime(locktime);

            console.log("[To BTC: Solana.Initialize] Nonce sequence base: ", sequenceBN.toNumber());
            const sequence = 0xFE000000 + sequenceBN.toNumber();
            console.log("[To BTC: Solana.Initialize] Nonce sequence: ", sequence);

            for(let i=0;i<psbt.inputCount;i++) {
                psbt.setInputSequence(i, sequence);
            }

            //Sign the PSBT
            const psbtHex = psbt.toHex();

            let signedPsbt;
            try {
                signedPsbt = await lncli.signPsbt({
                    lnd: LND,
                    psbt: psbtHex
                });
            } catch (e) {
                console.error(e);
            }

            const unlockUtxos = async() => {
                for(let input of fundPsbtResponse.inputs) {
                    await lncli.unlockUtxo({
                        lnd: LND,
                        id: input.lock_id,
                        transaction_id: input.transaction_id,
                        transaction_vout: input.transaction_vout
                    });
                }
            };

            if(signedPsbt==null) {
                console.error("[To BTC: Solana.Initialize] Failed to sign psbt!");
                await unlockUtxos();
                return;
            }

            psbt = bitcoin.Psbt.fromHex(signedPsbt.psbt);

            //Check tx fee
            const txFee = new BN(psbt.getFee());
            if(maxNetworkFee.lt(txFee)) {
                //TODO: Here we can maybe retry with a bit different confirmation target
                console.error("[To BTC: Solana.Initialize] Fee changed too much! Max possible fee: "+maxNetworkFee.toString(10)+" required transaction fee: "+txFee.toString(10));
                await unlockUtxos();
                await setNonPayableAndSave();
                return;
            }

            //Send BTC TX
            console.log("[To BTC: Solana.Initialize] Generated raw transaction: ", signedPsbt.transaction);

            const tx = bitcoin.Transaction.fromHex(signedPsbt.transaction);
            const txId = tx.getId();

            payment.state = ToBtcSwapState.BTC_SENDING;
            payment.data = data;
            payment.txId = txId;
            await this.storageManager.saveData(payment.getHash(), payment);

            let txSendResult;
            try {
                txSendResult = await lncli.broadcastChainTransaction({
                    lnd: LND,
                    transaction: signedPsbt.transaction
                });
            } catch (e) {
                console.error(e);
            }

            if(txSendResult==null) {
                console.error("[To BTC: Solana.Initialize] Failed to broadcast transaction!");
                await unlockUtxos();
                return;
            }

            payment.state = ToBtcSwapState.BTC_SENT;
            await this.storageManager.saveData(payment.getHash(), payment);
        }

        if(payment.state===ToBtcSwapState.NON_PAYABLE) return;

        this.subscribeToPayment(payment);

    }

    async processEvent(eventData: SwapEvent<T>[]): Promise<boolean> {
        for(let event of eventData) {
            if(event instanceof InitializeEvent) {
                if(!this.swapContract.areWeClaimer(event.swapData)) {
                    continue;
                }

                if(event.swapData.getType()!==SwapType.CHAIN_NONCED) {
                    //Only process nonced on-chain requests
                    continue;
                }

                if(event.swapData.isPayOut()) {
                    //Only process requests that don't payout from the program
                    continue;
                }

                if(event.swapData.isPayIn()) {
                    const usedNonce = event.signatureNonce;
                    if (usedNonce > this.nonce.getClaimNonce()) {
                        await this.nonce.saveClaimNonce(usedNonce);
                    }
                }

                const paymentHash = event.swapData.getHash();

                console.log("[To BTC: Solana.Initialize] Payment hash: ", paymentHash);

                const savedInvoice = this.storageManager.data[paymentHash];

                if(savedInvoice==null) {
                    console.error("[To BTC: Solana.Initialize] No invoice submitted");
                    continue;
                }

                console.log("[To BTC: Solana.Initialize] SOL request submitted");

                await this.processInitialized(savedInvoice, event.swapData);

                continue;
            }
            if(event instanceof ClaimEvent) {
                const paymentHash = event.paymentHash;
                const paymentHashBuffer = Buffer.from(event.paymentHash, "hex");

                const savedInvoice = this.storageManager.data[paymentHash];

                if(savedInvoice==null) {
                    console.error("[To BTC: Solana.ClaimEvent] No invoice submitted");
                    continue;
                }

                console.log("[To BTC: Solana.ClaimEvent] Transaction confirmed! Event: ", event);

                await this.storageManager.removeData(paymentHashBuffer);

                continue;
            }
            if(event instanceof RefundEvent) {
                const paymentHash = event.paymentHash;
                const paymentHashBuffer = Buffer.from(event.paymentHash, "hex");

                const savedInvoice = this.storageManager.data[paymentHash];

                if(savedInvoice==null) {
                    console.error("[To BTC: Solana.RefundEvent] No invoice submitted");
                    continue;
                }

                console.log("[To BTC: Solana.RefundEvent] Transaction refunded! Event: ", event);

                await this.storageManager.removeData(paymentHashBuffer);

                continue;
            }
        }

        return true;
    }

    static getExpiryFromCLTV(confirmationTarget, confirmations) {
        //Blocks = 10 + (confirmations + confirmationTarget)*2
        //Time = 3600 + (600*blocks*2)
        const cltv = MIN_ONCHAIN_END_CTLV.add(
            new BN(confirmations).add(new BN(confirmationTarget)).mul(CHAIN_SEND_SAFETY_FACTOR)
        );

        return GRACE_PERIOD.add(BITCOIN_BLOCKTIME.mul(cltv).mul(SAFETY_FACTOR));

    }

    startRestServer(restServer: Express) {
        restServer.post(this.path+"/payInvoice", async (req, res) => {
            /**
             * address: string                      Bitcoin destination address
             * amount: string                       Amount to send (in satoshis)
             * confirmationTarget: number           Desired confirmation target for the swap, how big of a fee should be assigned to TX
             * confirmations: number                Required number of confirmations for us to claim the swap
             * nonce: string                        Nonce for the swap (used for replay protection)
             * token: string                        Desired token to use
             */
            if (
                req.body == null ||

                req.body.address == null ||
                typeof(req.body.address) !== "string" ||

                req.body.amount == null ||
                typeof(req.body.amount) !== "string" ||

                req.body.confirmationTarget == null ||
                typeof(req.body.confirmationTarget) !== "number" ||

                req.body.confirmations == null ||
                typeof(req.body.confirmations) !== "number" ||

                req.body.nonce == null ||
                typeof(req.body.nonce) !== "string" ||

                req.body.token == null ||
                typeof(req.body.token) !== "string"
            ) {
                res.status(400).json({
                    msg: "Invalid request body (address/amount/confirmationTarget/confirmations/nonce/token)"
                });
                return;
            }

            if(!this.allowedTokens.has(req.body.token)) {
                res.status(400).json({
                    msg: "Invalid request body (token)"
                });
                return;
            }

            let amountBD: BN;

            try {
                amountBD = new BN(req.body.amount);
            } catch (e) {
                res.status(400).json({
                    msg: "Invalid request body (amount - cannot be parsed)"
                });
                return;
            }

            let nonce: BN;

            try {
                nonce = new BN(req.body.nonce);
            } catch (e) {
                res.status(400).json({
                    msg: "Invalid request body (nonce - cannot be parsed)"
                });
                return;
            }

            const nonceBuffer = Buffer.from(nonce.toArray("be", 8));
            const firstPart = new BN(nonceBuffer.slice(0, 5), "be");

            const maxAllowedValue = new BN(Math.floor(Date.now()/1000)-600000000);
            if(firstPart.gt(maxAllowedValue)) {
                res.status(400).json({
                    msg: "Invalid request body (nonce - too high)"
                });
                return;
            }

            if(req.body.confirmationTarget>MAX_CONFIRMATION_TARGET) {
                res.status(400).json({
                    msg: "Invalid request body (confirmationTarget - too high)"
                });
                return;
            }
            if(req.body.confirmationTarget<MIN_CONFIRMATION_TARGET) {
                res.status(400).json({
                    msg: "Invalid request body (confirmationTarget - too low)"
                });
                return;
            }

            if(req.body.confirmations>MAX_CONFIRMATIONS) {
                res.status(400).json({
                    msg: "Invalid request body (confirmations - too high)"
                });
                return;
            }
            if(req.body.confirmations<MIN_CONFIRMATIONS) {
                res.status(400).json({
                    msg: "Invalid request body (confirmations - too low)"
                });
                return;
            }

            let parsedOutputScript;

            try {
                parsedOutputScript = bitcoin.address.toOutputScript(req.body.address, BITCOIN_NETWORK);
            } catch (e) {
                res.status(400).json({
                    msg: "Invalid request body (address - cannot be parsed)"
                });
                return;
            }

            if(parsedOutputScript.length > OUTPUT_SCRIPT_MAX_LENGTH) {
                res.status(400).json({
                    msg: "Invalid request body (address's output script - too long)"
                });
                return;
            }

            if(amountBD.lt(CHAIN_MIN)) {
                res.status(400).json({
                    code: 20003,
                    msg: "Amount too low!",
                    data: {
                        min: CHAIN_MIN.toString(10),
                        max: CHAIN_MAX.toString(10)
                    }
                });
                return;
            }
            if(amountBD.gt(CHAIN_MAX)) {
                res.status(400).json({
                    code: 20004,
                    msg: "Amount too high!",
                    data: {
                        min: CHAIN_MIN.toString(10),
                        max: CHAIN_MAX.toString(10)
                    }
                });
                return;
            }

            const expirySeconds = ToBtcAbs.getExpiryFromCLTV(req.body.confirmationTarget, req.body.confirmations).add(new BN(GRACE_PERIOD)); //Add grace period another time, so the user has 1 hour to commit

            let chainFeeResp;
            try {
                chainFeeResp = await lncli.getChainFeeEstimate({
                    lnd: LND,
                    send_to: [
                        {
                            address: req.body.address,
                            tokens: parseInt(req.body.amount)
                        }
                    ],
                    target_confirmations: req.body.confirmationTarget,
                    utxo_confirmations: 0
                });
            } catch (e) {
                console.error(e);
            }

            if(chainFeeResp==null) {
                res.status(400).json({
                    code: 20002,
                    msg: "Insufficient liquidity!"
                });
            }

            const networkFee = chainFeeResp.fee;
            const feeSatsPervByte = chainFeeResp.tokens_per_vbyte;

            console.log("[To BTC: REST.PayInvoice] Total network fee: ", networkFee);
            console.log("[To BTC: REST.PayInvoice] Network fee (sats/vB): ", feeSatsPervByte);

            const networkFeeAdjusted = new BN(networkFee).mul(NETWORK_FEE_MULTIPLIER_PPM).div(new BN(1000000));
            const feeSatsPervByteAdjusted = new BN(feeSatsPervByte).mul(NETWORK_FEE_MULTIPLIER_PPM).div(new BN(1000000));

            console.log("[To BTC: REST.PayInvoice] Adjusted total network fee: ", networkFeeAdjusted.toString(10));
            console.log("[To BTC: REST.PayInvoice] Adjusted network fee (sats/vB): ", feeSatsPervByteAdjusted.toString(10));

            const swapFee = CHAIN_BASE_FEE.add(amountBD.mul(CHAIN_FEE_PPM).div(new BN(1000000)));


            const useToken = this.swapContract.toTokenAddress(req.body.token);

            const networkFeeInToken = await this.swapPricing.getFromBtcSwapAmount(networkFeeAdjusted, useToken);
            const swapFeeInToken = await this.swapPricing.getFromBtcSwapAmount(swapFee, useToken);
            const amountInToken = await this.swapPricing.getFromBtcSwapAmount(amountBD, useToken);

            const total = amountInToken.add(swapFeeInToken).add(networkFeeInToken);

            const currentTimestamp = new BN(Math.floor(Date.now()/1000));
            const minRequiredExpiry = currentTimestamp.add(expirySeconds);

            const payObject: T = this.swapContract.createSwapData(
                SwapType.CHAIN_NONCED,
                null,
                this.swapContract.getAddress(),
                useToken,
                total,
                ToBtcSwapAbs.getHash(req.body.address, nonce, amountBD).toString("hex"),
                minRequiredExpiry,
                nonce,
                req.body.confirmations,
                false
            );

            const sigData = await this.swapContract.getClaimInitSignature(payObject, this.nonce);

            const createdSwap = new ToBtcSwapAbs<T>(req.body.address, amountBD, swapFee, networkFeeAdjusted, nonce, req.body.confirmationTarget, new BN(sigData.timeout));
            const paymentHash = createdSwap.getHash();
            createdSwap.data = payObject;

            await this.storageManager.saveData(paymentHash, createdSwap);

            res.status(200).json({
                code: 20000,
                msg: "Success",
                data: {
                    address: this.swapContract.getAddress(),
                    satsPervByte: feeSatsPervByteAdjusted.toString(10),
                    networkFee: networkFeeInToken.toString(10),
                    swapFee: swapFeeInToken.toString(10),
                    totalFee: swapFeeInToken.add(networkFeeInToken).toString(10),
                    total: total.toString(10),
                    minRequiredExpiry: minRequiredExpiry.toString(),

                    data: payObject.serialize(),

                    nonce: sigData.nonce,
                    prefix: sigData.prefix,
                    timeout: sigData.timeout,
                    signature: sigData.signature
                }
            });

        });

        restServer.post(this.path+"/getRefundAuthorization", async (req, res) => {
            try {
                /**
                 * paymentHash: string              Payment hash identifier of the swap
                 */
                if (
                    req.body == null ||

                    req.body.paymentHash == null ||
                    typeof(req.body.paymentHash) !== "string"
                ) {
                    res.status(400).json({
                        msg: "Invalid request body (paymentHash)"
                    });
                    return;
                }

                const payment = this.storageManager.data[req.body.paymentHash];

                if (payment == null || payment.state === ToBtcSwapState.SAVED) {
                    res.status(200).json({
                        code: 20007,
                        msg: "Payment not found"
                    });
                    return;
                }

                if (payment.state === ToBtcSwapState.COMMITED) {
                    res.status(200).json({
                        code: 20008,
                        msg: "Payment processing"
                    });
                    return;
                }

                if (payment.state === ToBtcSwapState.BTC_SENT || payment.state===ToBtcSwapState.BTC_SENDING) {
                    res.status(200).json({
                        code: 20006,
                        msg: "Already paid",
                        data: {
                            txId: payment.txId
                        }
                    });
                    return;
                }

                if (payment.state === ToBtcSwapState.NON_PAYABLE) {
                    const hash = Buffer.from(req.body.paymentHash, "hex");

                    const isCommited = await this.swapContract.isCommited(payment.data);

                    if (!isCommited) {
                        res.status(400).json({
                            code: 20005,
                            msg: "Not committed"
                        });
                        return;
                    }

                    const refundResponse = await this.swapContract.getRefundSignature(payment.data);

                    res.status(200).json({
                        code: 20000,
                        msg: "Success",
                        data: {
                            address: this.swapContract.getAddress(),
                            prefix: refundResponse.prefix,
                            timeout: refundResponse.timeout,
                            signature: refundResponse.signature
                        }
                    });
                    return;
                }

                res.status(500).json({
                    code: 20009,
                    msg: "Invalid payment status"
                });
            } catch (e) {
                console.error(e);
                res.status(500).json({
                    msg: "Internal server error"
                });
            }
        });

        console.log("[To BTC: REST] Started at path: ", this.path);
    }

    subscribeToEvents() {
        this.chainEvents.registerListener(this.processEvent.bind(this));

        console.log("[To BTC: Solana.Events] Subscribed to Solana events");
    }

    async startPastSwapsTimer() {
        let rerun;
        rerun = async () => {
            await this.checkPastSwaps();
            setTimeout(rerun, SWAP_CHECK_INTERVAL);
        };
        await rerun();
    }

    async startTxTimer() {
        let rerun;
        rerun = async () => {
            await this.checkBtcTxs();
            setTimeout(rerun, TX_CHECK_INTERVAL);
        };
        await rerun();
    }

    async startWatchdog() {
        await this.startPastSwapsTimer();
        await this.startTxTimer();
    }

    async init() {
        await this.storageManager.loadData(ToBtcSwapAbs);
        this.subscribeToEvents();
    }

    getInfo(): { swapFeePPM: number, swapBaseFee: number, min: number, max: number, data?: any, tokens: string[] } {
        return {
            swapFeePPM: CHAIN_FEE_PPM.toNumber(),
            swapBaseFee: CHAIN_BASE_FEE.toNumber(),
            min: CHAIN_MIN.toNumber(),
            max: CHAIN_MAX.toNumber(),
            data: {
                minCltv: MIN_ONCHAIN_END_CTLV.toNumber(),

                minConfirmations: MIN_CONFIRMATIONS,
                maxConfirmations: MAX_CONFIRMATIONS,

                minConfTarget: MIN_CONFIRMATION_TARGET,
                maxConfTarget: MAX_CONFIRMATION_TARGET,

                maxOutputScriptLen: OUTPUT_SCRIPT_MAX_LENGTH
            },
            tokens: Array.from<string>(this.allowedTokens)
        };
    }

}

export default ToBtcAbs;