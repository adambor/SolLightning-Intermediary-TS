import * as BN from "bn.js";
import * as express from "express";
import {Express} from "express";
import * as cors from "cors";
import StorageManager from "../../storagemanager/StorageManager";
import {
    BITCOIN_BLOCKTIME,
    GRACE_PERIOD,
    LN_BASE_FEE,
    LN_FEE_PPM,
    LN_MAX,
    LN_MIN,
    MAX_SOL_SKEW,
    SAFETY_FACTOR
} from "../../constants/Constants";
import LND from "../../btc/LND";
import * as lncli from "ln-service";
import {createHash} from "crypto";
import * as bolt11 from "bolt11";
import SwapData from "../SwapData";
import {FromBtcLnSwapAbs, FromBtcLnSwapState} from "./FromBtcLnSwapAbs";
import SwapContract from "../SwapContract";
import ChainEvents from "../../events/ChainEvents";
import SwapNonce from "../SwapNonce";
import {TokenAddress} from "../TokenAddress";
import SwapEvent from "../../events/types/SwapEvent";
import InitializeEvent from "../../events/types/InitializeEvent";
import ClaimEvent from "../../events/types/ClaimEvent";
import RefundEvent from "../../events/types/RefundEvent";
import SwapType from "../SwapType";
import SwapHandler, {SwapHandlerType} from "../SwapHandler";

const HEX_REGEX = /[0-9a-fA-F]+/;

const MIN_LNRECEIVE_CTLV = new BN(20);

const SWAP_CHECK_INTERVAL = 5*60*1000;

class FromBtcLnAbs<T extends SwapData> implements SwapHandler {

    readonly type = SwapHandlerType.FROM_BTCLN;

    storageManager: StorageManager<FromBtcLnSwapAbs<T>>;

    readonly path: string;

    readonly swapContract: SwapContract<T>;
    readonly chainEvents: ChainEvents<T>;
    readonly nonce: SwapNonce;
    readonly WBTC_ADDRESS: TokenAddress;

    constructor(storageDirectory: string, path: string, swapContract: SwapContract<T>, chainEvents: ChainEvents<T>, swapNonce: SwapNonce, WBTC_ADDRESS: TokenAddress) {
        this.storageManager = new StorageManager<FromBtcLnSwapAbs<T>>(storageDirectory);
        this.swapContract = swapContract;
        this.chainEvents = chainEvents;
        this.nonce = swapNonce;
        this.WBTC_ADDRESS = WBTC_ADDRESS;
        this.path = path;
    }

    async checkPastSwaps() {

        const removeSwaps: string[] = [];
        const settleInvoices: string[] = [];
        const cancelInvoices: string[] = [];
        const refundSwaps: FromBtcLnSwapAbs<T>[] = [];

        for(let key in this.storageManager.data) {
            const swap = this.storageManager.data[key];

            if(swap.state===FromBtcLnSwapState.CREATED) {
                const parsedPR = bolt11.decode(swap.pr);
                //Invoice is expired
                if(parsedPR.timeExpireDate<Date.now()/1000) {
                    //Check if it really wasn't paid
                    const invoice = await lncli.getInvoice({
                        id: parsedPR.tagsObject.payment_hash,
                        lnd: LND
                    });

                    if(!invoice.is_held) {
                        //Remove
                        removeSwaps.push(parsedPR.tagsObject.payment_hash);
                    }
                }
                continue;
            }

            const expiryTime = swap.data.getExpiry();
            const currentTime = new BN(Math.floor(Date.now()/1000)-MAX_SOL_SKEW);

            if(swap.state===FromBtcLnSwapState.CLAIMED) {
                //Try to settle the hodl invoice
                settleInvoices.push(swap.secret);
                continue;
            }

            if(swap.state===FromBtcLnSwapState.CANCELED) {
                cancelInvoices.push(swap.data.getHash());
                continue;
            }

            if(expiryTime.lt(currentTime)) {
                const isCommited = await this.swapContract.isCommited(swap.data);

                if(isCommited) {
                    refundSwaps.push(swap);
                    continue;
                }

                cancelInvoices.push(swap.data.getHash());
            }
        }

        for(let swapHash of removeSwaps) {
            await this.storageManager.removeData(Buffer.from(swapHash, "hex"));
        }

        for(let refundSwap of refundSwaps) {
            const unlock = refundSwap.lock(this.swapContract.refundTimeout);
            if(unlock==null) continue;

            await this.swapContract.refund(refundSwap.data);

            unlock();
        }

        for(let paymentHash of cancelInvoices) {
            //Refund
            try {
                await lncli.cancelHodlInvoice({
                    lnd: LND,
                    id: paymentHash
                });
                console.log("[From BTC-LN: BTCLN.CancelHodlInvoice] Invoice cancelled, because was timed out, id: ", paymentHash);
                await this.storageManager.removeData(Buffer.from(paymentHash, "hex"));
            } catch (e) {
                console.error("[From BTC-LN: BTCLN.CancelHodlInvoice] Cannot cancel hodl invoice id: ", paymentHash);
            }
        }

        for(let secret of settleInvoices) {
            //Refund
            const secretBuffer = Buffer.from(secret, "hex");
            const paymentHash = createHash("sha256").update(secretBuffer).digest();

            try {
                await lncli.settleHodlInvoice({
                    lnd: LND,
                    secret: secret
                });

                console.log("[From BTC-LN: BTCLN.SettleHodlInvoice] Invoice settled, id: ", paymentHash.toString("hex"));
                await this.storageManager.removeData(paymentHash);
            } catch (e) {
                console.error("[From BTC-LN: BTCLN.SettleHodlInvoice] Cannot cancel hodl invoice id: ", paymentHash.toString("hex"));
            }
        }
    }

    async processEvent(eventData: SwapEvent<T>[]): Promise<boolean> {

        for(let event of eventData) {
            if(event instanceof InitializeEvent) {
                if (!this.swapContract.areWeOfferer(event.swapData)) {
                    continue;
                }

                if (event.swapData.isPayIn()) {
                    continue;
                }

                if (event.swapData.getType() !== SwapType.HTLC) {
                    //Only process HTLC requests
                    continue;
                }

                //Increment nonce
                const paymentHash = event.paymentHash;
                const paymentHashBuffer = Buffer.from(paymentHash, "hex");

                const savedSwap = this.storageManager.data[paymentHash];

                if (savedSwap != null) {
                    savedSwap.state = FromBtcLnSwapState.COMMITED;
                }

                const usedNonce = event.signatureNonce;
                if (usedNonce > this.nonce.getNonce()) {
                    await this.nonce.saveNonce(usedNonce);
                }

                if (savedSwap != null) {
                    savedSwap.data = event.swapData;
                    await this.storageManager.saveData(paymentHashBuffer, savedSwap);
                }

            }
            if(event instanceof ClaimEvent) {
                //Claim
                //This is the important part, we need to catch the claim TX, else we may lose money
                const secret: Buffer = Buffer.from(event.secret, "hex");
                const paymentHash: Buffer = createHash("sha256").update(secret).digest();

                const secretHex = secret.toString("hex");
                const paymentHashHex = paymentHash.toString("hex");

                const savedSwap = this.storageManager.data[paymentHashHex];

                if (savedSwap == null) {
                    continue;
                }

                try {
                    await lncli.settleHodlInvoice({
                        lnd: LND,
                        secret: secretHex
                    });
                    console.log("[From BTC-LN: BTCLN.SettleHodlInvoice] Invoice settled, id: ", paymentHashHex);
                    await this.storageManager.removeData(paymentHash);
                } catch (e) {
                    console.error("[From BTC-LN: BTCLN.SettleHodlInvoice] FATAL Cannot settle hodl invoice id: " + paymentHashHex + " secret: ", secretHex);
                    savedSwap.state = FromBtcLnSwapState.CLAIMED;
                    savedSwap.secret = secretHex;
                    await this.storageManager.saveData(paymentHash, savedSwap);
                }

                continue;
            }
            if(event instanceof RefundEvent) {
                //Refund
                //Try to get the hash from the refundMap
                if (event.paymentHash == null) {
                    continue;
                }

                const paymentHashBuffer: Buffer = Buffer.from(event.paymentHash, "hex");

                const savedSwap = this.storageManager.data[event.paymentHash];

                if (savedSwap == null) {
                    continue;
                }

                try {
                    await lncli.cancelHodlInvoice({
                        lnd: LND,
                        id: event.paymentHash
                    });
                    console.log("[From BTC-LN: BTCLN.CancelHodlInvoice] Invoice cancelled, because was refunded, id: ", event.paymentHash);
                    await this.storageManager.removeData(paymentHashBuffer);
                } catch (e) {
                    console.error("[From BTC-LN: BTCLN.CancelHodlInvoice] Cannot cancel hodl invoice id: ", event.paymentHash);
                    savedSwap.state = FromBtcLnSwapState.CANCELED;
                    await this.storageManager.saveData(paymentHashBuffer, savedSwap);
                }

                continue;
            }
        }

        return true;
    }

    startRestServer(restServer: Express) {

        restServer.post(this.path+"/createInvoice", async (req, res) => {
            /**
             * address: string              solana address of the recipient
             * paymentHash: string          payment hash of the to-be-created invoice
             * amount: string               amount (in sats) of the invoice
             * expiry: number               expiry time of the invoice (in seconds)
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
                req.body.paymentHash==null ||
                typeof(req.body.paymentHash)!=="string" ||
                req.body.paymentHash.length!==64 ||
                !HEX_REGEX.test(req.body.paymentHash)
            ) {
                res.status(400).json({
                    msg: "Invalid request body (paymentHash)"
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

            if(amountBD.lt(LN_MIN)) {
                res.status(400).json({
                    msg: "Amount too low"
                });
                return;
            }

            if(amountBD.gt(LN_MAX)) {
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

            if(
                req.body.expiry==null ||
                typeof(req.body.expiry)!=="number" ||
                isNaN(req.body.expiry) ||
                req.body.expiry<=0
            ) {
                res.status(400).json({
                    msg: "Invalid request body (expiry)"
                });
                return;
            }

            const hodlInvoiceObj: any = {
                description: req.body.address,
                cltv_delta: MIN_LNRECEIVE_CTLV.toString(10),
                expires_at: new Date(Date.now()+(req.body.expiry*1000)).toISOString(),
                id: req.body.paymentHash,
                tokens: amountBD.toString(10)
            };

            console.log("[From BTC-LN: REST.CreateInvoice] creating hodl invoice: ", hodlInvoiceObj);

            hodlInvoiceObj.lnd = LND;

            const hodlInvoice = await lncli.createHodlInvoice(hodlInvoiceObj);

            console.log("[From BTC-LN: REST.CreateInvoice] hodl invoice created: ", hodlInvoice);

            const swapFee = LN_BASE_FEE.add(amountBD.mul(LN_FEE_PPM).div(new BN(1000000)));

            const paymentHash = Buffer.from(req.body.paymentHash, "hex");
            const createdSwap = new FromBtcLnSwapAbs<T>(hodlInvoice.request, swapFee);

            await this.storageManager.saveData(paymentHash, createdSwap);

            res.status(200).json({
                msg: "Success",
                data: {
                    pr: hodlInvoice.request,
                    swapFee: swapFee.toString(10)
                }
            });

        });


        restServer.post(this.path+"/getInvoiceStatus", async (req, res) => {
            /**
             * paymentHash: string          payment hash of the invoice
             */
            if (
                req.body == null ||

                req.body.paymentHash == null ||
                typeof(req.body.paymentHash) !== "string" ||
                req.body.paymentHash.length !== 64
            ) {
                res.status(400).json({
                    msg: "Invalid request body (paymentHash)"
                });
                return;
            }

            const invoice = await lncli.getInvoice({
                id: req.body.paymentHash,
                lnd: LND
            });

            if(invoice==null) {
                res.status(200).json({
                    code: 10001,
                    msg: "Invoice expired/canceled"
                });
                return;
            }

            try {
                if(!this.swapContract.isValidAddress(invoice.description)) {
                    res.status(200).json({
                        code: 10001,
                        msg: "Invoice expired/canceled"
                    });
                    return;
                }
            } catch (e) {
                res.status(200).json({
                    code: 10001,
                    msg: "Invoice expired/canceled"
                });
                return;
            }

            if (!invoice.is_held) {
                if (invoice.is_canceled) {
                    res.status(200).json({
                        code: 10001,
                        msg: "Invoice expired/canceled"
                    });
                } else if (invoice.is_confirmed) {
                    res.status(200).json({
                        code: 10002,
                        msg: "Invoice already paid"
                    });
                } else {
                    res.status(200).json({
                        code: 10003,
                        msg: "Invoice yet unpaid"
                    });
                }
            }

            res.status(200).json({
                code: 10000,
                msg: "Success"
            });

        });

        restServer.post(this.path+"/getInvoicePaymentAuth", async (req, res) => {
            try {
                /**
                 * paymentHash: string          payment hash of the invoice
                 */
                if (
                    req.body == null ||

                    req.body.paymentHash == null ||
                    typeof(req.body.paymentHash) !== "string" ||
                    req.body.paymentHash.length !== 64
                ) {
                    res.status(400).json({
                        msg: "Invalid request body (paymentHash)"
                    });
                    return;
                }

                const invoice = await lncli.getInvoice({
                    id: req.body.paymentHash,
                    lnd: LND
                });

                if (invoice == null) {
                    res.status(200).json({
                        code: 10001,
                        msg: "Invoice expired/canceled"
                    });
                    return;
                }

                try {
                    if (!this.swapContract.isValidAddress(invoice.description)) {
                        res.status(200).json({
                            code: 10001,
                            msg: "Invoice expired/canceled"
                        });
                        return;
                    }
                } catch (e) {
                    res.status(200).json({
                        code: 10001,
                        msg: "Invoice expired/canceled"
                    });
                    return;
                }

                if (!invoice.is_held) {
                    if (invoice.is_canceled) {
                        res.status(200).json({
                            code: 10001,
                            msg: "Invoice expired/canceled"
                        });
                    } else if (invoice.is_confirmed) {
                        res.status(200).json({
                            code: 10002,
                            msg: "Invoice already paid"
                        });
                    } else {
                        res.status(200).json({
                            code: 10003,
                            msg: "Invoice yet unpaid"
                        });
                    }
                    return;
                }

                const paymentHash = Buffer.from(req.body.paymentHash, "hex");
                const invoiceData: FromBtcLnSwapAbs<T> = this.storageManager.data[req.body.paymentHash];

                if (invoiceData == null) {
                    res.status(200).json({
                        code: 10001,
                        msg: "Invoice expired/canceled"
                    });
                    return;
                }

                if (invoiceData.state === FromBtcLnSwapState.CREATED) {
                    console.log("[From BTC-LN: REST.GetInvoicePaymentAuth] held ln invoice: ", invoice);

                    const balance: BN = await this.swapContract.getBalance(this.WBTC_ADDRESS);

                    const invoiceAmount: BN = new BN(invoice.received);
                    const fee: BN = invoiceData.swapFee;
                    const sendAmount: BN = invoiceAmount.sub(fee);

                    const cancelAndRemove = async () => {
                        await lncli.cancelHodlInvoice({
                            id: invoice.id,
                            lnd: LND
                        });
                        await this.storageManager.removeData(paymentHash);
                    };

                    if (balance.lt(sendAmount)) {
                        await cancelAndRemove();
                        console.error("[From BTC-LN: REST.GetInvoicePaymentAuth] ERROR Not enough balance on SOL to honor the request");
                        res.status(200).json({
                            code: 20001,
                            msg: "Not enough liquidity"
                        });
                        return;
                    }

                    let timeout: number = null;
                    invoice.payments.forEach((curr) => {
                        if (timeout == null || timeout > curr.timeout) timeout = curr.timeout;
                    });
                    const {current_block_height} = await lncli.getHeight({lnd: LND});

                    const blockDelta = new BN(timeout - current_block_height);

                    console.log("[From BTC-LN: REST.GetInvoicePaymentAuth] block delta: ", blockDelta.toString(10));

                    const expiryTimeout = blockDelta.mul(BITCOIN_BLOCKTIME.div(SAFETY_FACTOR)).sub(GRACE_PERIOD);

                    console.log("[From BTC-LN: REST.GetInvoicePaymentAuth] expiry timeout: ", expiryTimeout.toString(10));

                    if (expiryTimeout.isNeg()) {
                        await cancelAndRemove();
                        console.error("[From BTC-LN: REST.GetInvoicePaymentAuth] Expire time is lower than 0");
                        res.status(200).json({
                            code: 20002,
                            msg: "Not enough time to reliably process the swap"
                        });
                        return;
                    }

                    /*
                    {
                        intermediary: new PublicKey(invoice.description),
                        token: WBTC_ADDRESS,
                        amount: sendAmount,
                        paymentHash: req.body.paymentHash,
                        expiry: new BN(Math.floor(Date.now() / 1000)).add(expiryTimeout)
                    }
                     */
                    const payInvoiceObject: T = this.swapContract.createSwapData(
                        SwapType.HTLC,
                        this.swapContract.getAddress(),
                        invoice.description,
                        this.WBTC_ADDRESS,
                        sendAmount,
                        req.body.paymentHash,
                        new BN(Math.floor(Date.now() / 1000)).add(expiryTimeout),
                        new BN(0),
                        0,
                        null
                    );

                    invoiceData.data = payInvoiceObject;
                    invoiceData.state = FromBtcLnSwapState.RECEIVED;
                    await this.storageManager.saveData(paymentHash, invoiceData);
                }

                if (invoiceData.state === FromBtcLnSwapState.COMMITED) {
                    res.status(200).json({
                        code: 10004,
                        msg: "Invoice already committed"
                    });
                    return;
                }

                const sigData = await this.swapContract.getInitSignature(invoiceData.data, this.nonce);

                res.status(200).json({
                    code: 10000,
                    msg: "Success",
                    data: {
                        address: this.swapContract.getAddress(),
                        data: invoiceData.serialize().data,
                        nonce: sigData.nonce,
                        prefix: sigData.prefix,
                        timeout: sigData.timeout,
                        signature: sigData.signature
                    }
                });
            } catch (e) {
                console.error(e);
                res.status(500).json({
                    msg: "Internal server error"
                });
            }
        });

        console.log("[From BTC-LN: REST] Started at path: ", this.path);
    }

    subscribeToEvents() {
        this.chainEvents.registerListener(this.processEvent.bind(this));

        console.log("[From BTC-LN: Solana.Events] Subscribed to Solana events");
    }

    async startWatchdog() {
        let rerun;
        rerun = async () => {
            await this.checkPastSwaps();
            setTimeout(rerun, SWAP_CHECK_INTERVAL);
        };
        await rerun();
    }

    async init() {
        await this.storageManager.loadData(FromBtcLnSwapAbs);
        this.subscribeToEvents();
    }

    getInfo(): { swapFeePPM: number, swapBaseFee: number, min: number, max: number, data?: any } {
        return {
            swapFeePPM: LN_FEE_PPM.toNumber(),
            swapBaseFee: LN_BASE_FEE.toNumber(),
            min: LN_MIN.toNumber(),
            max: LN_MAX.toNumber(),
            data: {
                minCltv: MIN_LNRECEIVE_CTLV.toNumber()
            }
        };
    }

}

export default FromBtcLnAbs;