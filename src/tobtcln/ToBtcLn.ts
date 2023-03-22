import {ToBtcLnData, ToBtcLnSwap, ToBtcLnSwapState} from "./ToBtcLnSwap";
import StorageManager from "../StorageManager";
import * as express from "express";
import {Express} from "express";
import * as cors from "cors";
import * as BN from "bn.js";
import * as bolt11 from "bolt11";
import {
    AUTHORIZATION_TIMEOUT,
    BITCOIN_BLOCKTIME,
    GRACE_PERIOD,
    LN_BASE_FEE,
    LN_FEE_PPM,
    LN_MAX,
    LN_MIN,
    SAFETY_FACTOR,
    WBTC_ADDRESS
} from "../Constants";
import LND from "../btc/LND";
import * as lncli from "ln-service";
import AnchorSigner from "../sol/AnchorSigner";
import SwapProgram, {
    EscrowStateType,
    getEscrow,
    getRefundSignature,
    SwapEscrowState,
    SwapUserVault
} from "../sol/program/SwapProgram";
import {sign} from "tweetnacl";
import SolEvents, {EventObject} from "../sol/SolEvents";
import {createHash} from "crypto";
import {PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY} from "@solana/web3.js";

const MIN_LNSEND_CTLV = new BN(10);
const MIN_LNSEND_TS_DELTA = GRACE_PERIOD.add(BITCOIN_BLOCKTIME.mul(MIN_LNSEND_CTLV).mul(SAFETY_FACTOR));

const INVOICE_CHECK_INTERVAL = 10*1000;

class ToBtcLn {

    storageManager: StorageManager<ToBtcLnSwap>;
    restPort: number;
    restServer: Express;

    activeSubscriptions: Set<string> = new Set<string>();

    constructor(storageDirectory: string, restPort: number) {
        this.storageManager = new StorageManager<ToBtcLnSwap>(storageDirectory);
        this.restPort = restPort;
    }

    async checkPastInvoices() {

        for(let key in this.storageManager.data) {
            const invoiceData = this.storageManager.data[key];
            const decodedPR = bolt11.decode(invoiceData.pr);

            if (invoiceData.state === ToBtcLnSwapState.SAVED) {
                //Yet unpaid
                if (decodedPR.timeExpireDate < Date.now() / 1000) {
                    //Expired
                    await this.storageManager.removeData(Buffer.from(decodedPR.tagsObject.payment_hash, "hex"));
                    continue;
                }
            }

            if (invoiceData.state === ToBtcLnSwapState.COMMITED) {
                await this.processInitialized(invoiceData, invoiceData.offerer, invoiceData.data);
            }
        }
    }

    async processPaymentResult(invoiceData: ToBtcLnSwap, lnPaymentStatus: {is_confirmed?: boolean, is_failed?: boolean, is_pending?: boolean, payment?: any}) {
        const decodedPR = bolt11.decode(invoiceData.pr);
        const paymentHash = Buffer.from(decodedPR.tagsObject.payment_hash, "hex");

        if(lnPaymentStatus.is_failed) {
            console.error("[To BTC-LN: BTCLN.PaymentResult] Invoice payment failed, should refund offerer");
            await this.storageManager.removeData(paymentHash);
            return;
        }

        if(lnPaymentStatus.is_pending) {
            return;
        }

        if(lnPaymentStatus.is_confirmed) {
            //Check if escrow state exists
            const escrow = await getEscrow(paymentHash);

            if(escrow==null) {
                console.error("[To BTC-LN: BTCLN.PaymentResult] Tried to claim but escrow doesn't exist anymore: ", decodedPR.tagsObject.payment_hash);
                return;
            }

            let result = await SwapProgram.methods
                .claimerClaim(Buffer.from(lnPaymentStatus.payment.secret, "hex"))
                .accounts({
                    claimer: AnchorSigner.publicKey,
                    offerer: invoiceData.offerer,
                    initializer: invoiceData.data.initializer,
                    userData: SwapUserVault(AnchorSigner.publicKey),
                    escrowState: SwapEscrowState(paymentHash),
                    systemProgram: SystemProgram.programId,
                    ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY
                })
                .signers([AnchorSigner.signer])
                .transaction();

            const signature = await AnchorSigner.sendAndConfirm(result, [AnchorSigner.signer]);

            console.log("[SOL->BTCLN: SOL.claimer_claim] Transaction sent: ", signature);
            return;
        }

        throw new Error("Invalid lnPaymentStatus");
    }

    subscribeToPayment(invoiceData: ToBtcLnSwap) {

        const decodedPR = bolt11.decode(invoiceData.pr);
        if(this.activeSubscriptions.has(decodedPR.tagsObject.payment_hash)) {
            //Already subscribed
            return;
        }

        const sub = lncli.subscribeToPastPayment({id: decodedPR.tagsObject.payment_hash, lnd: LND});

        console.log("[To BTC-LN: BTCLN.PaymentResult] Subscribed to payment: ", decodedPR.tagsObject.payment_hash);

        const onResult = (lnPaymentStatus: {is_confirmed?: boolean, is_failed?: boolean, payment?: any}) => {
            this.processPaymentResult(invoiceData, lnPaymentStatus);
            sub.removeAllListeners();
            this.activeSubscriptions.delete(decodedPR.tagsObject.payment_hash);
        };

        sub.on('confirmed', (payment) => {
            const lnPaymentStatus = {
                is_confirmed: true,
                payment
            };

            console.log("[To BTC-LN: BTCLN.PaymentResult] Invoice paid, result: ", payment);

            onResult(lnPaymentStatus);
        });

        sub.on('failed', (payment) => {
            const lnPaymentStatus = {
                is_failed: true
            };

            console.log("[To BTC-LN: BTCLN.PaymentResult] Invoice pay failed, result: ", payment);

            onResult(lnPaymentStatus);
        });

        this.activeSubscriptions.add(decodedPR.tagsObject.payment_hash);

    }

    async processInitialized(invoiceData: ToBtcLnSwap, offerer: PublicKey, data: ToBtcLnData) {

        const lnPr = invoiceData.pr;
        const decodedPR = bolt11.decode(lnPr);

        //Check if payment was already made
        let lnPaymentStatus = await lncli.getPayment({
            id: decodedPR.tagsObject.payment_hash,
            lnd: LND
        }).catch(e => {
            console.error(e);
        });

        const markAsNonPayable = async() => {
            invoiceData.data = data;
            invoiceData.offerer = offerer;
            invoiceData.state = ToBtcLnSwapState.NON_PAYABLE;
            await this.storageManager.saveData(Buffer.from(decodedPR.tagsObject.payment_hash, "hex"), invoiceData);
        };

        if(lnPaymentStatus==null) {
            const tokenAddress = data.token;

            if (!tokenAddress.equals(WBTC_ADDRESS)) {
                console.error("[To BTC-LN: Solana.Initialize] Invalid token used");
                return;
            }

            console.log("[To BTC-LN: Solana.Initialize] Struct: ", data);

            const tokenAmount: BN = data.amount;
            const expiryTimestamp: BN = data.expiry;
            const currentTimestamp: BN = new BN(Math.floor(Date.now()/1000));

            console.log("[To BTC-LN: Solana.Initialize] Expiry time: ", expiryTimestamp.toString(10));

            if(expiryTimestamp.sub(currentTimestamp).lt(MIN_LNSEND_TS_DELTA)) {
                console.error("[To BTC-LN: Solana.Initialize] Not enough time to reliably pay the invoice");
                await markAsNonPayable();
                return;
            }

            console.log("[To BTC-LN: Solana.Initialize] lightning payment request: ", lnPr);
            console.log("[To BTC-LN: Solana.Initialize] Decoded lightning payment request: ", decodedPR);

            if(decodedPR.satoshis==null) {
                console.error("[To BTC-LN: Solana.Initialize] Invalid invoice with no amount");
                await markAsNonPayable();
                return;
            }

            const amountBD = new BN(decodedPR.satoshis);

            if(amountBD.lt(LN_MIN)) {
                console.error("[To BTC-LN: Solana.Initialize] Low payment amount: "+amountBD.toString(10)+" minimum: "+LN_MIN.toString(10));
                await markAsNonPayable();
                return;
            }
            if(amountBD.gt(LN_MAX)) {
                console.error("[To BTC-LN: Solana.Initialize] High payment amount: "+amountBD.toString(10)+" maximum: "+LN_MAX.toString(10));
                await markAsNonPayable();
                return;
            }

            const maxFee = tokenAmount.sub(amountBD).sub(invoiceData.swapFee);

            console.log("[To BTC-LN: Solana.Initialize] Invoice amount (sats): ", amountBD.toString(10));
            console.log("[To BTC-LN: Solana.Initialize] Token amount (sats WBTC): ", tokenAmount.toString(10));

            if(maxFee.lt(new BN(0))) {
                console.error("[To BTC-LN: Solana.Initialize] Not enough paid!");
                await markAsNonPayable();
                return;
            }

            const maxUsableCLTV = expiryTimestamp.sub(currentTimestamp).sub(GRACE_PERIOD).div(BITCOIN_BLOCKTIME.mul(SAFETY_FACTOR));

            console.log("[To BTC-LN: Solana.Initialize] Max usable CLTV expiry: ", maxUsableCLTV.toString(10));
            console.log("[To BTC-LN: Solana.Initialize] Max fee: ", maxFee.toString(10));

            invoiceData.state = ToBtcLnSwapState.COMMITED;
            invoiceData.offerer = offerer;
            invoiceData.data = data;
            await this.storageManager.saveData(Buffer.from(decodedPR.tagsObject.payment_hash, "hex"), invoiceData);

            const { current_block_height } = await lncli.getHeight({lnd: LND});

            const obj: any = {
                request: lnPr,
                max_fee: maxFee.toString(10),
                max_timeout_height: new BN(current_block_height).add(maxUsableCLTV).toString(10)
            };

            console.log("[To BTC-LN: Solana.Initialize] Paying invoice: ", obj);

            obj.lnd = LND;

            const payment = await lncli.pay(obj).catch(e => {
                console.error(e);
            });

            this.subscribeToPayment(invoiceData);
            return;
        }

        if(lnPaymentStatus.is_pending) {
            this.subscribeToPayment(invoiceData);
            return;
        }

        await this.processPaymentResult(invoiceData, lnPaymentStatus);

    }

    async processEvent(eventData: EventObject): Promise<boolean> {
        const {events, instructions} = eventData;

        for(let event of events) {
            if(event.name==="ClaimEvent") {
                const secret = Buffer.from(event.data.secret);

                const paymentHashBuffer = createHash("sha256").update(secret).digest();
                const paymentHash = paymentHashBuffer.toString("hex");

                const savedInvoice = this.storageManager.data[paymentHash];

                if(savedInvoice==null) {
                    console.error("[To BTC-LN: Solana.ClaimEvent] No invoice submitted: ", paymentHash);
                    continue;
                }

                console.log("[To BTC-LN: Solana.ClaimEvent] Transaction confirmed! Event: ", event);

                await this.storageManager.removeData(paymentHashBuffer);
            }
        }

        for(let ix of instructions) {
            if (ix == null) continue;

            if (
                (ix.name === "offererInitializePayIn" || ix.name === "offererInitialize") &&
                ix.accounts.claimer.equals(AnchorSigner.wallet.publicKey)
            ) {
                if(ix.data.kind!==0) {
                    //Only process ln requests
                    continue;
                }

                const paymentHash = Buffer.from(ix.data.hash).toString("hex");

                const savedInvoice = this.storageManager.data[paymentHash];

                if(savedInvoice==null) {
                    console.error("[To BTC-LN: Solana.Initialize] No invoice submitted: ", paymentHash);
                    continue;
                }

                console.log("[To BTC-LN: Solana.Initialize] SOL request submitted: ", paymentHash);

                let offerer: PublicKey;
                if(ix.name === "offererInitializePayIn") {
                    offerer = ix.accounts.initializer;
                } else {
                    offerer = ix.accounts.offerer;
                }

                await this.processInitialized(savedInvoice, offerer, {
                    initializer: ix.accounts.initializer,
                    intermediary: ix.accounts.claimer,
                    token: ix.accounts.mint,
                    amount: new BN(ix.data.initializerAmount.toString(10)),
                    paymentHash: Buffer.from(ix.data.hash).toString("hex"),
                    expiry: new BN(ix.data.expiry.toString(10))
                });
            }
        }

        return true;

    }

    startRestServer() {
        this.restServer = express();
        this.restServer.use(cors());
        this.restServer.use(express.json());

        this.restServer.post("/payInvoice", async (req, res) => {
            /**
             * pr: string                   bolt11 lightning invoice
             * maxFee: string               maximum routing fee
             * expiryTimestamp: string      expiry timestamp of the to be created HTLC, determines how many LN paths can be considered
             */
            if (
                req.body == null ||

                req.body.pr == null ||
                typeof(req.body.pr) !== "string" ||

                req.body.maxFee == null ||
                typeof(req.body.maxFee) !== "string" ||

                req.body.expiryTimestamp == null ||
                typeof(req.body.expiryTimestamp) !== "string"
            ) {
                res.status(400).json({
                    msg: "Invalid request body (pr/maxFee/expiryTimestamp)"
                });
                return;
            }

            let maxFeeBD: BN;

            try {
                maxFeeBD = new BN(req.body.maxFee);
            } catch (e) {
                res.status(400).json({
                    msg: "Invalid request body (maxFee - cannot be parsed)"
                });
                return;
            }

            let expiryTimestamp: BN;

            try {
                expiryTimestamp = new BN(req.body.expiryTimestamp)
            } catch (e) {
                res.status(400).json({
                    msg: "Invalid request body (expiryTimestamp - cannot be parsed)"
                });
                return;
            }
            const currentTimestamp = new BN(Math.floor(Date.now()/1000));

            let parsedPR: bolt11.PaymentRequestObject & { tagsObject: bolt11.TagsObject };

            try {
                parsedPR = bolt11.decode(req.body.pr);
            } catch (e) {
                console.error(e);
                res.status(400).json({
                    msg: "Invalid request body (pr - cannot be parsed)"
                });
                return;
            }

            if(parsedPR.timeExpireDate < Date.now()/1000) {
                res.status(400).json({
                    msg: "Invalid request body (pr - expired)"
                });
                return;
            }

            if(expiryTimestamp.sub(currentTimestamp).lt(MIN_LNSEND_TS_DELTA)) {
                res.status(400).json({
                    code: 20001,
                    msg: "Expiry time too low!"
                });
                return;
            }

            const amountBD = new BN(parsedPR.satoshis);

            if(amountBD.lt(LN_MIN)) {
                res.status(400).json({
                    code: 20003,
                    msg: "Amount too low!",
                    data: {
                        min: LN_MIN.toString(10),
                        max: LN_MAX.toString(10)
                    }
                });
                return;
            }

            if(amountBD.gt(LN_MAX)) {
                res.status(400).json({
                    code: 20004,
                    msg: "Amount too high!",
                    data: {
                        min: LN_MIN.toString(10),
                        max: LN_MAX.toString(10)
                    }
                });
                return;
            }

            //Check if prior payment has been made
            try {
                const payment = await lncli.getPayment({
                    lnd: LND,
                    id: parsedPR.tagsObject.payment_hash
                });

                if(payment!=null) {
                    res.status(400).json({
                        code: 20010,
                        msg: "Already processed"
                    });
                    return;
                }
            } catch (e) {}

            const maxUsableCLTV: BN = expiryTimestamp.sub(currentTimestamp).sub(GRACE_PERIOD).div(BITCOIN_BLOCKTIME.mul(SAFETY_FACTOR));

            const { current_block_height } = await lncli.getHeight({lnd: LND});

            //Probe for a route
            let obj;
            try {
                const parsedRequest = await lncli.parsePaymentRequest({
                    request: req.body.pr
                });

                const probeReq: any = {
                    destination: parsedPR.payeeNodeKey,
                    cltv_delta: parsedPR.tagsObject.min_final_cltv_expiry,
                    mtokens: parsedPR.millisatoshis,
                    max_fee_mtokens: maxFeeBD.mul(new BN(1000)).toString(10),
                    max_timeout_height: new BN(current_block_height).add(maxUsableCLTV).toString(10),
                    payment: parsedRequest.payment,
                    total_mtokens: parsedPR.millisatoshis,
                    routes: parsedRequest.routes
                };
                //if(hints.length>0) req.routes = [hints];
                console.log("[To BTC-LN: REST.payInvoice] Probe for route: ", probeReq);
                probeReq.lnd = LND;
                obj = await lncli.probeForRoute(probeReq);
            } catch (e) {
                console.log(e);
            }

            console.log("[To BTC-LN: REST.payInvoice] Probe result: ", obj);

            if(obj==null || obj.route==null) {
                res.status(400).json({
                    code: 20002,
                    msg: "Cannot route the payment!"
                });
                return;
            }

            const swapFee = amountBD.mul(LN_FEE_PPM).div(new BN(1000000)).add(LN_BASE_FEE);

            const createdSwap = new ToBtcLnSwap(req.body.pr, swapFee);

            await this.storageManager.saveData(Buffer.from(parsedPR.tagsObject.payment_hash, "hex"), createdSwap);

            res.status(200).json({
                code: 20000,
                msg: "Success",
                data: {
                    swapFee: swapFee.toString(10),
                    total: amountBD.add(maxFeeBD).add(swapFee).toString(10),
                    confidence: obj.route.confidence/1000000,
                    address: AnchorSigner.publicKey.toBase58()
                }
            });
        });

        this.restServer.post('/getRefundAuthorization', async (req, res) => {
            /**
             * paymentHash: string          Identifier of the swap
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

            const data = this.storageManager.data[req.body.paymentHash];

            if(data!=null) {
                if(data.state===ToBtcLnSwapState.NON_PAYABLE) {
                    const hash = Buffer.from(req.body.paymentHash, "hex");
                    const escrowAccount = await getEscrow(hash);

                    if(escrowAccount==null) {
                        res.status(400).json({
                            code: 20005,
                            msg: "Not committed"
                        });
                        return;
                    }

                    const refundSigData = getRefundSignature(escrowAccount);

                    res.status(200).json({
                        code: 20000,
                        msg: "Success",
                        data: {
                            address: AnchorSigner.wallet.publicKey.toBase58(),
                            prefix: refundSigData.prefix,
                            timeout: refundSigData.timeout,
                            signature: refundSigData.signature
                        }
                    });
                    return;
                }
            }

            const payment = await lncli.getPayment({
                id: req.body.paymentHash,
                lnd: LND
            }).catch(err => {
                console.error(err);
            });

            if(payment==null) {
                res.status(200).json({
                    code: 20007,
                    msg: "Payment not found"
                });
                return;
            }

            if(payment.is_pending) {
                res.status(200).json({
                    code: 20008,
                    msg: "Payment in-flight"
                });
                return;
            }

            if(payment.is_confirmed) {
                res.status(200).json({
                    code: 20006,
                    msg: "Already paid",
                    data: {
                        secret: payment.payment.secret
                    }
                });
                return;
            }

            if(payment.is_failed) {
                const hash = Buffer.from(req.body.paymentHash, "hex");
                const escrowAccount = await getEscrow(hash);

                if(escrowAccount==null) {
                    res.status(400).json({
                        code: 20005,
                        msg: "Not committed"
                    });
                    return;
                }

                const refundSigData = getRefundSignature(escrowAccount);

                res.status(200).json({
                    code: 20000,
                    msg: "Success",
                    data: {
                        address: AnchorSigner.wallet.publicKey.toBase58(),
                        prefix: refundSigData.prefix,
                        timeout: refundSigData.timeout,
                        signature: refundSigData.signature
                    }
                });
            }
        });

        this.restServer.listen(this.restPort);

        console.log("[To BTC-LN: REST] Started on port: ", this.restPort);

    }

    subscribeToEvents() {
        SolEvents.registerListener(this.processEvent.bind(this));

        console.log("[To BTC-LN: Solana.Events] Subscribed to Solana events");
    }

    async init() {
        await this.storageManager.loadData(ToBtcLnSwap);

        let rerun;
        rerun = async () => {
            await this.checkPastInvoices();
            setTimeout(rerun, INVOICE_CHECK_INTERVAL);
        };
        await rerun();

        this.subscribeToEvents();
        this.startRestServer();
    }

}

export default ToBtcLn;