import * as BN from "bn.js";
import * as express from "express";
import {Express} from "express";
import * as cors from "cors";
import StorageManager from "../StorageManager";
import {FromBtcLnData, FromBtcLnSwap, FromBtcLnSwapState} from "./FromBtcLnSwap";
import {PublicKey} from "@solana/web3.js";
import {
    AUTHORIZATION_TIMEOUT,
    BITCOIN_BLOCKTIME,
    GRACE_PERIOD,
    LN_BASE_FEE,
    LN_FEE_PPM,
    LN_MAX,
    LN_MIN, MAX_SOL_SKEW,
    SAFETY_FACTOR,
    WBTC_ADDRESS
} from "../Constants";
import SwapProgram, {getEscrow, SwapEscrowState, SwapUserVault} from "../sol/program/SwapProgram";
import AnchorSigner from "../sol/AnchorSigner";
import LND from "../btc/LND";
import * as lncli from "ln-service";
import {sign} from "tweetnacl";
import Nonce from "../sol/Nonce";
import SolEvents, {EventObject} from "../sol/SolEvents";
import {createHash} from "crypto";
import {pay} from "lightning";
import {ToBtcLnSwap} from "../tobtcln/ToBtcLnSwap";


const HEX_REGEX = /[0-9a-fA-F]+/;

const MIN_LNRECEIVE_CTLV = new BN(20);

const SWAP_CHECK_INTERVAL = 5*60*1000;

class FromBtcLn {

    storageManager: StorageManager<FromBtcLnSwap>;
    restPort: number;
    restServer: Express;

    constructor(storageDirectory: string, restPort: number) {
        this.storageManager = new StorageManager<FromBtcLnSwap>(storageDirectory);
        this.restPort = restPort;
    }

    static getInitSignature(data: FromBtcLnData): {
        nonce: number,
        prefix: string,
        timeout: string,
        signature: string
    } {
        const authPrefix = "initialize";
        const authTimeout = Math.floor(Date.now()/1000)+AUTHORIZATION_TIMEOUT;
        const useNonce = Nonce.getNonce()+1;

        const messageBuffers = [
            null,
            Buffer.alloc(8),
            null,
            null,
            Buffer.alloc(8),
            Buffer.alloc(8),
            null,
            Buffer.alloc(1),
            Buffer.alloc(2),
            Buffer.alloc(8)
        ];

        messageBuffers[0] = Buffer.from(authPrefix, "ascii");
        messageBuffers[1].writeBigUInt64LE(BigInt(useNonce));
        messageBuffers[2] = data.token.toBuffer();
        messageBuffers[3] = data.intermediary.toBuffer();
        messageBuffers[4].writeBigUInt64LE(BigInt(data.amount.toString(10)));
        messageBuffers[5].writeBigUInt64LE(BigInt(data.expiry.toString(10)));
        messageBuffers[6] = Buffer.from(data.paymentHash, "hex");
        messageBuffers[7].writeUint8(0);
        messageBuffers[8].writeUint16LE(0);
        messageBuffers[9].writeBigUInt64LE(BigInt(authTimeout));

        const messageBuffer = Buffer.concat(messageBuffers);
        const signature = sign.detached(messageBuffer, AnchorSigner.signer.secretKey);

        return {
            nonce: useNonce,
            prefix: authPrefix,
            timeout: authTimeout.toString(10),
            signature: Buffer.from(signature).toString("hex")
        }
    }

    async checkPastSwaps() {

        const settleInvoices: string[] = [];
        const cancelInvoices: string[] = [];
        const refundSwaps: FromBtcLnSwap[] = [];

        for(let key in this.storageManager.data) {
            const swap = this.storageManager.data[key];

            if(swap.state===FromBtcLnSwapState.CREATED) {
                continue;
            }

            const expiryTime = swap.data.expiry;
            const currentTime = new BN(Math.floor(Date.now()/1000)-MAX_SOL_SKEW);

            if(swap.state===FromBtcLnSwapState.CLAIMED) {
                //Try to settle the hodl invoice
                settleInvoices.push(swap.secret);
                continue;
            }

            if(swap.state===FromBtcLnSwapState.CANCELED) {
                cancelInvoices.push(swap.data.paymentHash);
                continue;
            }

            if(expiryTime.lt(currentTime)) {
                const paymentHash = Buffer.from(swap.data.paymentHash, "hex");

                try {
                    const account = await getEscrow(paymentHash);
                    if(account!=null) {
                        if(
                            account.offerer.equals(AnchorSigner.wallet.publicKey) &&
                            new BN(account.expiry.toString(10)).eq(swap.data.expiry) &&
                            new BN(account.initializerAmount.toString(10)).eq(swap.data.amount) &&
                            account.mint.equals(swap.data.token)
                        ) {
                            refundSwaps.push(swap);
                            continue;
                        }
                    }
                } catch (e) {
                    console.error(e);
                }

                cancelInvoices.push(swap.data.paymentHash);
            }

            for(let refundSwap of refundSwaps) {

                let result = await SwapProgram.methods
                    .offererRefund()
                    .accounts({
                        offerer: AnchorSigner.wallet.publicKey,
                        initializer: refundSwap.data.intermediary,
                        userData: SwapUserVault(AnchorSigner.wallet.publicKey),
                        escrowState: SwapEscrowState(Buffer.from(refundSwap.data.paymentHash, "hex"))
                    })
                    .signers([AnchorSigner.signer])
                    .transaction();

                const signature = await AnchorSigner.sendAndConfirm(result, [AnchorSigner.signer]);

                console.log("[From BTC-LN: Solana.Refund] Transaction confirmed! Signature: ", signature);

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

    }

    async processEvent(eventData: EventObject): Promise<boolean> {
        const {events, instructions} = eventData;

        const refundLogMap = {};

        for(let event of events) {
            if(event.name==="RefundEvent") {
                const hashBuffer = Buffer.from(event.data.hash);
                const key = SwapEscrowState(hashBuffer);
                refundLogMap[key.toBase58()] = hashBuffer.toString("hex");
            }
        }


        for(let ix of instructions) {
            if (ix == null) continue;

            if (
                ix.name === "offererInitialize" &&
                ix.accounts.offerer.equals(AnchorSigner.wallet.publicKey)
            ) {
                //Increment nonce
                const paymentHashBuffer = Buffer.from(ix.data.hash);
                const paymentHash = paymentHashBuffer.toString("hex");
                const savedSwap = this.storageManager.data[paymentHash];

                if (savedSwap != null) {
                    savedSwap.state = FromBtcLnSwapState.COMMITED;
                }

                const usedNonce = ix.data.nonce.toNumber();
                if (usedNonce > Nonce.getNonce()) {
                    await Nonce.saveNonce(usedNonce);
                }

                if (savedSwap != null) {
                    await this.storageManager.saveData(paymentHashBuffer, savedSwap);
                }

            }

            if (
                (ix.name === "claimerClaim" || ix.name === "claimerClaimPayOut") &&
                ix.accounts.offerer.equals(AnchorSigner.wallet.publicKey)
            ) {

                //Claim
                //This is the important part, we need to catch the claim TX, else we may lose money
                const secret = Buffer.from(ix.data.secret);
                const paymentHash = createHash("sha256").update(secret).digest();

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
            }

            if (
                (ix.name === "offererRefund" || ix.name === "offererRefundWithSignature" || ix.name === "offererRefundPayOut" || ix.name === "offererRefundWithSignaturePayOut")
                && ix.accounts.offerer.equals(AnchorSigner.wallet.publicKey)) {

                //Refund
                //Try to get the hash from the refundMap
                const paymentHash = refundLogMap[ix.accounts.escrowState.toBase58()];

                if (paymentHash == null) {
                    continue;
                }

                const paymentHashHex = paymentHash.toString("hex");

                const savedSwap = this.storageManager.data[paymentHashHex];

                if (savedSwap == null) {
                    continue;
                }

                try {
                    await lncli.cancelHodlInvoice({
                        lnd: LND,
                        id: paymentHash
                    });
                    console.log("[From BTC-LN: BTCLN.CancelHodlInvoice] Invoice cancelled, because was refunded, id: ", paymentHash);
                    await this.storageManager.removeData(paymentHash);
                } catch (e) {
                    console.error("[From BTC-LN: BTCLN.CancelHodlInvoice] Cannot cancel hodl invoice id: ", paymentHash);
                    savedSwap.state = FromBtcLnSwapState.CANCELED;
                    await this.storageManager.saveData(paymentHash, savedSwap);
                }
            }
        }

        return true;
    }

    startRestServer() {
        this.restServer = express();
        this.restServer.use(cors());
        this.restServer.use(express.json());

        this.restServer.post("/createInvoice", async (req, res) => {
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
                if(!PublicKey.isOnCurve(req.body.address)) {
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

            const tokenAccount: any = await SwapProgram.account.userAccount.fetch(SwapUserVault(AnchorSigner.publicKey));
            const balance = new BN(tokenAccount.amount.toString(10));

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
            const createdSwap = new FromBtcLnSwap(hodlInvoice.request, swapFee);
            await this.storageManager.saveData(paymentHash, createdSwap);

            res.status(200).json({
                msg: "Success",
                data: {
                    pr: hodlInvoice.request,
                    swapFee: swapFee.toString(10)
                }
            });

        });


        this.restServer.post("/getInvoiceStatus", async (req, res) => {
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
                if(!PublicKey.isOnCurve(invoice.description)) {
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

        this.restServer.post("/getInvoicePaymentAuth", async (req, res) => {
            /**
             * paymentHash: string          payment hash of the invoice
             */
            if(
                req.body==null ||

                req.body.paymentHash==null ||
                typeof(req.body.paymentHash)!=="string" ||
                req.body.paymentHash.length!==64
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
                if(!PublicKey.isOnCurve(invoice.description)) {
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

            if(!invoice.is_held) {
                if(invoice.is_canceled) {
                    res.status(200).json({
                        code: 10001,
                        msg: "Invoice expired/canceled"
                    });
                } else if(invoice.is_confirmed) {
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
            const invoiceData = this.storageManager.data[req.body.paymentHash];

            if(invoiceData==null) {
                res.status(200).json({
                    code: 10001,
                    msg: "Invoice expired/canceled"
                });
                return;
            }

            if(invoiceData.state===FromBtcLnSwapState.CREATED) {
                console.log("[From BTC-LN: REST.GetInvoicePaymentAuth] held ln invoice: ", invoice);

                const tokenAccount: any = await SwapProgram.account.userAccount.fetch(SwapUserVault(AnchorSigner.publicKey));
                const balance = new BN(tokenAccount.amount.toString(10));

                const invoiceAmount = new BN(invoice.received);
                const fee = invoiceData.swapFee;
                const sendAmount = invoiceAmount.sub(fee);

                const cancelAndRemove = async() => {
                    await lncli.cancelHodlInvoice({
                        id: invoice.id,
                        lnd: LND
                    });
                    await this.storageManager.removeData(paymentHash);
                };

                if(balance.lt(sendAmount)) {
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
                    if(timeout==null || timeout>curr.timeout) timeout = curr.timeout;
                });
                const {current_block_height} = await lncli.getHeight({lnd: LND});

                const blockDelta = new BN(timeout-current_block_height);

                console.log("[From BTC-LN: REST.GetInvoicePaymentAuth] block delta: ", blockDelta.toString(10));

                const expiryTimeout = blockDelta.mul(BITCOIN_BLOCKTIME.div(SAFETY_FACTOR)).sub(GRACE_PERIOD);

                console.log("[From BTC-LN: REST.GetInvoicePaymentAuth] expiry timeout: ", expiryTimeout.toString(10));

                if(expiryTimeout.isNeg()) {
                    await cancelAndRemove();
                    console.error("[From BTC-LN: REST.GetInvoicePaymentAuth] Expire time is lower than 0");
                    res.status(200).json({
                        code: 20002,
                        msg: "Not enough time to reliably process the swap"
                    });
                    return;
                }

                const payInvoiceObject: FromBtcLnData = {
                    intermediary: new PublicKey(invoice.description),
                    token: WBTC_ADDRESS,
                    amount: sendAmount,
                    paymentHash: req.body.paymentHash,
                    expiry: new BN(Math.floor(Date.now()/1000)).add(expiryTimeout)
                };

                invoiceData.data = payInvoiceObject;
                invoiceData.state = FromBtcLnSwapState.RECEIVED;
                await this.storageManager.saveData(paymentHash, invoiceData);
            }

            if(invoiceData.state===FromBtcLnSwapState.COMMITED) {
                res.status(200).json({
                    code: 10004,
                    msg: "Invoice already committed"
                });
                return;
            }

            const sigData = FromBtcLn.getInitSignature(invoiceData.data);

            res.status(200).json({
                code: 10000,
                msg: "Success",
                data: {
                    address: AnchorSigner.wallet.publicKey.toBase58(),
                    data: invoiceData.serialize().data,
                    nonce: sigData.nonce,
                    prefix: sigData.prefix,
                    timeout: sigData.timeout,
                    signature: sigData.signature
                }
            });

        });

        this.restServer.listen(this.restPort);

        console.log("[From BTC-LN: REST] Started on port: ", this.restPort);
    }

    subscribeToEvents() {
        SolEvents.registerListener(this.processEvent.bind(this));

        console.log("[From BTC-LN: Solana.Events] Subscribed to Solana events");
    }

    async init() {
        await this.storageManager.loadData(FromBtcLnSwap);

        let rerun;
        rerun = async () => {
            await this.checkPastSwaps();
            setTimeout(rerun, SWAP_CHECK_INTERVAL);
        };
        await rerun();

        this.subscribeToEvents();
        this.startRestServer();
    }

}

export default FromBtcLn;