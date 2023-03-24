import * as cors from "cors";
import * as BN from "bn.js";
import * as bitcoin from "bitcoinjs-lib";
import * as lncli from "ln-service";
import LND from "../btc/LND";
import StorageManager from "../StorageManager";
import {FromBtcLnSwap, FromBtcLnSwapState} from "../frombtcln/FromBtcLnSwap";
import {Express} from "express";
import * as express from "express";
import SolEvents, {EventObject} from "../sol/SolEvents";
import {PublicKey} from "@solana/web3.js";
import {
    BITCOIN_BLOCKTIME,
    BITCOIN_NETWORK,
    CHAIN_BASE_FEE,
    CHAIN_FEE_PPM,
    CHAIN_MAX,
    CHAIN_MIN, GRACE_PERIOD, MAX_SOL_SKEW, SAFETY_FACTOR,
    WBTC_ADDRESS
} from "../Constants";
import SwapProgram, {getEscrow, getInitSignature, SwapEscrowState, SwapUserVault} from "../sol/program/SwapProgram";
import AnchorSigner from "../sol/AnchorSigner";
import BtcAtomicSwap from "../btc/BtcAtomicSwap";
import {pay} from "lightning";
import BtcRPC from "../btc/BtcRPC";
import {FromBtcData, FromBtcSwap, FromBtcSwapState} from "./FromBtcSwap";
import Nonce from "../sol/Nonce";
import {createHash} from "crypto";
import * as bolt11 from "bolt11";

const HEX_REGEX = /[0-9a-fA-F]+/;

const CONFIRMATIONS = 1;
const SWAP_CSV_DELTA = 144; //A day

const REFUND_CHECK_INTERVAL = 15*60*1000;

class FromBtc {

    storageManager: StorageManager<FromBtcSwap>;
    restPort: number;
    restServer: Express;

    constructor(storageDirectory: string, restPort: number) {
        this.storageManager = new StorageManager<FromBtcSwap>(storageDirectory);
        this.restPort = restPort;
    }

    async checkPastSwaps() {

        const removeSwaps: Buffer[] = [];
        const refundSwaps: FromBtcSwap[] = [];

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

            const expiryTime = swap.data.expiry;
            if(swap.state===FromBtcSwapState.COMMITED) {
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
                }
            }
        }

        for(let swapHash of removeSwaps) {
            await this.storageManager.removeData(swapHash);
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

            console.log("[From BTC: Solana.Refund] Transaction confirmed! Signature: ", signature);

        }
    }

    async processEvent(eventData: EventObject): Promise<boolean> {
        const {events, instructions} = eventData;

        for(let event of events) {
            if(event.name==="ClaimEvent") {
                //Claim
                const paymentHash: Buffer = Buffer.from(event.data.hash);

                const paymentHashHex = paymentHash.toString("hex");

                const savedSwap = this.storageManager.data[paymentHashHex];

                if (savedSwap == null) {
                    continue;
                }

                console.log("[From BTC: Solana.ClaimEvent] Swap claimed by claimer: ", paymentHashHex);
                await this.storageManager.removeData(paymentHash);
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
                    savedSwap.state = FromBtcSwapState.COMMITED;
                }

                const usedNonce = ix.data.nonce.toNumber();
                if (usedNonce > Nonce.getNonce()) {
                    await Nonce.saveNonce(usedNonce);
                }

                if (savedSwap != null) {
                    await this.storageManager.saveData(paymentHashBuffer, savedSwap);
                }

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

            const tokenAccount: any = await SwapProgram.account.userAccount.fetch(SwapUserVault(AnchorSigner.wallet.publicKey));
            const balance = new BN(tokenAccount.amount.toString(10));

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

            const createdSwap = new FromBtcSwap(receiveAddress, amountBD, swapFee);

            const paymentHash = createdSwap.getHash();

            const currentTimestamp = new BN(Math.floor(Date.now()/1000));
            const expiryTimeout = new BN(SWAP_CSV_DELTA).mul(BITCOIN_BLOCKTIME.div(SAFETY_FACTOR));

            const data: FromBtcData = {
                intermediary: new PublicKey(req.body.address),
                token: WBTC_ADDRESS,
                amount: amountBD.sub(swapFee),
                paymentHash: paymentHash.toString("hex"),
                expiry: currentTimestamp.add(expiryTimeout),
                kind: 1,
                confirmations: CONFIRMATIONS
            };

            createdSwap.data = data;

            const sigData = await getInitSignature(data);

            createdSwap.authorizationExpiry = new BN(sigData.timeout);

            await this.storageManager.saveData(createdSwap.getHash(), createdSwap);

            res.status(200).json({
                code: 10000,
                msg: "Success",
                data: {
                    btcAddress: receiveAddress,
                    address: AnchorSigner.wallet.publicKey.toBase58(),
                    data: createdSwap.serialize().data,
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
        SolEvents.registerListener(this.processEvent.bind(this));

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
        await this.storageManager.loadData(FromBtcSwap);
        this.subscribeToEvents();
    }
}

export default FromBtc;