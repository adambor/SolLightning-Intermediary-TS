import StorageManager from "../StorageManager";
import * as express from "express";
import {Express} from "express";
import {ToBtcData, ToBtcSwap, ToBtcSwapState} from "./ToBtcSwap";
import SolEvents, {EventObject} from "../sol/SolEvents";
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
    GRACE_PERIOD,
    NETWORK_FEE_MULTIPLIER_PPM,
    SAFETY_FACTOR,
    WBTC_ADDRESS
} from "../Constants";
import * as lncli from "ln-service";
import LND from "../btc/LND";
import AnchorSigner from "../sol/AnchorSigner";
import {PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, Transaction} from "@solana/web3.js";
import BtcRPC from "../btc/BtcRPC";
import BtcRelay from "../btcrelay/BtcRelay";
import BTCMerkleTree from "../btcrelay/BTCMerkleTree";
import SwapProgram, {
    getClaimInitSignature,
    getEscrow,
    getRefundSignature,
    SwapEscrowState,
    SwapTxData,
    SwapUserVault
} from "../sol/program/SwapProgram";
import {getAssociatedTokenAddressSync} from "@solana/spl-token";
import {FromBtcLnData} from "../frombtcln/FromBtcLnSwap";
import Nonce from "../sol/Nonce";

const TX_CHECK_INTERVAL = 10*1000;

const MIN_ONCHAIN_END_CTLV = new BN(10);

const MAX_CONFIRMATIONS = 12;
const MIN_CONFIRMATIONS = 2;

const MAX_CONFIRMATION_TARGET = 6;
const MIN_CONFIRMATION_TARGET = 1;

const OUTPUT_SCRIPT_MAX_LENGTH = 200;

const SWAP_CHECK_INTERVAL = 10*1000;

class ToBtc {

    storageManager: StorageManager<ToBtcSwap>;
    restPort: number;
    restServer: Express;

    activeSubscriptions: {[txId: string]: ToBtcSwap} = {};

    constructor(storageDirectory: string, restPort: number) {
        this.storageManager = new StorageManager<ToBtcSwap>(storageDirectory);
        this.restPort = restPort;
    }

    async processPaymentResult(tx: {blockhash: string, confirmations: number, txid: string, hex: string}, payment: ToBtcSwap, vout: number): Promise<boolean> {

        let blockheader;
        try {
            blockheader = await new Promise((resolve, reject) => {
                BtcRPC.getBlockHeader(tx.blockhash, true, (err, info) => {
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

        console.log("[To BTC: Solana.Claim] Blockheader fetched: ", blockheader);

        if(blockheader==null) return false;

        let commitedHeader;
        try {
            commitedHeader = await BtcRelay.retrieveBlockLog(blockheader.hash, blockheader.height+tx.confirmations-1);
        } catch (e) {
            console.error(e);
        }

        console.log("[To BTC: Solana.Claim] Commited header retrieved: ", commitedHeader);

        if(commitedHeader==null) return false;

        const merkleProof = await BTCMerkleTree.getTransactionMerkle(tx.txid, tx.blockhash);

        console.log("[To BTC: Solana.Claim] Merkle proof computed: ", merkleProof);

        const witnessRawTxBuffer: Buffer = Buffer.from(tx.hex, "hex");

        const btcTx = bitcoin.Transaction.fromBuffer(witnessRawTxBuffer);

        for(let txIn of btcTx.ins) {
            txIn.witness = [];
        }

        const rawTxBuffer: Buffer = btcTx.toBuffer();

        const writeData: Buffer = Buffer.concat([
            Buffer.from(new BN(vout).toArray("le", 4)),
            rawTxBuffer
        ]);

        console.log("[To BTC: Solana.Claim] Writing transaction data: ", writeData.toString("hex"));

        const txDataKey = SwapTxData(merkleProof.reversedTxId, AnchorSigner.wallet.publicKey);

        try {
            const fetchedDataAccount = await SwapProgram.account.data.fetch(txDataKey);
            console.log("[To BTC: Solana.Claim] Will erase previous data account");
            const eraseTx = await SwapProgram.methods
                .closeData(merkleProof.reversedTxId)
                .accounts({
                    signer: AnchorSigner.wallet.publicKey,
                    data: txDataKey
                })
                .signers([AnchorSigner.signer])
                .transaction();

            const signature = await AnchorSigner.sendAndConfirm(eraseTx, [AnchorSigner.signer]);
            console.log("[To BTC: Solana.Claim] Previous data account erased: ", signature);
        } catch (e) {}

        let pointer = 0;
        while(pointer<writeData.length) {
            const writeLen = Math.min(writeData.length-pointer, 1000);

            const writeTx = await SwapProgram.methods
                .writeData(merkleProof.reversedTxId, writeData.length, writeData.slice(pointer, writeLen))
                .accounts({
                    signer: AnchorSigner.signer.publicKey,
                    data: txDataKey,
                    systemProgram: SystemProgram.programId
                })
                .signers([AnchorSigner.signer])
                .transaction();

            const signature = await AnchorSigner.sendAndConfirm(writeTx, [AnchorSigner.signer]);

            console.log("[To BTC: Solana.Claim] Write partial tx data ("+pointer+" .. "+(pointer+writeLen)+")/"+writeData.length+": ", signature);

            pointer += writeLen;
        }

        console.log("[To BTC: Solana.Claim] Tx data written");

        const verifyIx = await BtcRelay.createVerifyIx(AnchorSigner.signer, merkleProof.reversedTxId, payment.data.confirmations, merkleProof.pos, merkleProof.merkle, commitedHeader);
        const claimIx = await SwapProgram.methods
            .claimerClaimWithExtData(merkleProof.reversedTxId)
            .accounts({
                signer: AnchorSigner.wallet.publicKey,
                claimer: AnchorSigner.wallet.publicKey,
                offerer: payment.offerer,
                initializer: payment.data.initializer,
                data: txDataKey,
                userData: SwapUserVault(AnchorSigner.wallet.publicKey),
                escrowState: SwapEscrowState(Buffer.from(payment.data.paymentHash, "hex")),
                systemProgram: SystemProgram.programId,
                ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY
            })
            .signers([AnchorSigner.signer])
            .instruction();

        const solanaTx = new Transaction();
        solanaTx.add(verifyIx);
        solanaTx.add(claimIx);
        solanaTx.feePayer = AnchorSigner.wallet.publicKey;
        solanaTx.recentBlockhash = (await AnchorSigner.connection.getRecentBlockhash()).blockhash;

        const signature = await AnchorSigner.sendAndConfirm(solanaTx, [AnchorSigner.signer]);
        console.log("[To BTC: Solana.Claim] Transaction confirmed: ", signature);

        await this.storageManager.removeData(payment.getHash());

        return true;
    }


    async checkPastSwaps() {

        for(let key in this.storageManager.data) {
            const payment = this.storageManager.data[key];

            if(payment.state===ToBtcSwapState.SAVED) {
                //Yet unpaid
                //TODO: Implement some expiry
                continue;
            }

            if(payment.state===ToBtcSwapState.NON_PAYABLE) {
                if(payment.data.expiry.lt(new BN(Math.floor(Date.now()/1000)))) {
                    //Expired
                    await this.storageManager.removeData(payment.getHash());
                    continue;
                }
            }

            if(payment.state===ToBtcSwapState.COMMITED || payment.state===ToBtcSwapState.BTC_SENDING || payment.state===ToBtcSwapState.BTC_SENT) {
                await this.processInitialized(payment, payment.offerer, payment.data);
                continue;
            }

        }

    }

    async checkBtcTxs() {

        for(let txId in this.activeSubscriptions) {
            const payment: ToBtcSwap = this.activeSubscriptions[txId];
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

            if(tx.confirmations<payment.data.confirmations) {
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

    async processInitialized(payment: ToBtcSwap, offerer: PublicKey, data: ToBtcData) {

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
            payment.offerer = offerer;
            payment.data = data;
            await this.storageManager.saveData(payment.getHash(), payment);
        };

        if(payment.state===ToBtcSwapState.SAVED) {
            const tokenAddress = data.token;

            if(!tokenAddress.equals(WBTC_ADDRESS)) {
                console.error("[To BTC: Solana.Initialize] Invalid token used");
                await setNonPayableAndSave();
                return;
            }

            payment.state = ToBtcSwapState.COMMITED;
            payment.offerer = offerer;
            payment.data = data;
            await this.storageManager.saveData(payment.getHash(), payment);
        }

        if(payment.state===ToBtcSwapState.COMMITED) {
            console.log("[To BTC: Solana.Initialize] Struct: ", data);

            const currentTimestamp = new BN(Math.floor(Date.now()/1000));
            const tsDelta = payment.data.expiry.sub(currentTimestamp);

            const minRequiredCLTV = ToBtc.getExpiryFromCLTV(payment.preferedConfirmationTarget, payment.data.confirmations);

            if(tsDelta.lt(minRequiredCLTV)) {
                console.error("[To BTC: Solana.Initialize] TS delta too low, required: "+minRequiredCLTV.toString(10)+" has: "+tsDelta.toString(10));
                await setNonPayableAndSave();
                return;
            }

            const maxNetworkFee = payment.data.amount.sub(payment.amount).sub(payment.swapFee);

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
            const nonceBN = data.nonce;
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
            payment.offerer = offerer;
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

    async processEvent(eventData: EventObject): Promise<boolean> {
        const {events, instructions} = eventData;

        const initializeLogMap = {};

        for(let event of events) {
            if(event.name==="InitializeEvent") {
                const hashBuffer = Buffer.from(event.data.hash);
                initializeLogMap[hashBuffer.toString("hex")] = {
                    nonce: event.data.nonce
                };
            }

            if(event.name==="ClaimEvent") {
                const paymentHashBuffer = Buffer.from(event.data.hash);
                const paymentHash = paymentHashBuffer.toString("hex");

                const savedInvoice = this.storageManager.data[paymentHash];

                if(savedInvoice==null) {
                    console.error("[To BTC: Solana.ClaimEvent] No invoice submitted");
                    continue;
                }

                console.log("[To BTC: Solana.ClaimEvent] Transaction confirmed! Event: ", event);

                await this.storageManager.removeData(paymentHashBuffer);
            }

            if(event.name==="RefundEvent") {
                const paymentHashBuffer = Buffer.from(event.data.hash);
                const paymentHash = paymentHashBuffer.toString("hex");

                const savedInvoice = this.storageManager.data[paymentHash];

                if(savedInvoice==null) {
                    console.error("[To BTC: Solana.RefundEvent] No invoice submitted");
                    continue;
                }

                console.log("[To BTC: Solana.RefundEvent] Transaction refunded! Event: ", event);

                await this.storageManager.removeData(paymentHashBuffer);
            }
        }

        for(let ix of instructions) {
            if (ix == null) continue;

            if (
                (ix.name === "offererInitializePayIn" || ix.name === "offererInitialize") &&
                ix.accounts.claimer.equals(AnchorSigner.wallet.publicKey)
            ) {
                if(ix.data.kind!==2) {
                    //Only process nonced on-chain requests
                    continue;
                }

                if(ix.data.payOut) {
                    //Only process requests that don't payout from the program
                    continue;
                }

                if(ix.name === "offererInitializePayIn") {
                    const usedNonce = ix.data.nonce.toNumber();
                    if (usedNonce > Nonce.getClaimNonce()) {
                        await Nonce.saveClaimNonce(usedNonce);
                    }
                }

                const ourAta = getAssociatedTokenAddressSync(ix.accounts.mint, AnchorSigner.wallet.publicKey);

                if(!ix.accounts.claimerTokenAccount.equals(ourAta)) {
                    //Invalid ATA specified as our ATA
                    continue;
                }

                const paymentHash = Buffer.from(ix.data.hash).toString("hex");

                console.log("[To BTC: Solana.Initialize] Payment hash: ", paymentHash);

                const savedInvoice = this.storageManager.data[paymentHash];

                if(savedInvoice==null) {
                    console.error("[To BTC: Solana.Initialize] No invoice submitted");
                    continue;
                }

                console.log("[To BTC: Solana.Initialize] SOL request submitted");

                let offerer;
                if(ix.name === "offererInitializePayIn") {
                    offerer = ix.accounts.initializer;
                } else {
                    offerer = ix.accounts.offerer;
                }

                const log = initializeLogMap[paymentHash];

                if(log==null) {
                    console.error("[To BTC: Solana.Initialize] Corresponding log not found");
                    continue;
                }

                console.log("[To BTC: Solana.Initialize] Processing swap id: ", paymentHash);

                await this.processInitialized(savedInvoice, offerer, {
                    initializer: ix.accounts.initializer,
                    intermediary: ix.accounts.claimer,
                    token: ix.accounts.mint,
                    confirmations: ix.data.confirmations,
                    amount: new BN(ix.data.initializerAmount.toString(10)),
                    paymentHash: paymentHash,
                    expiry: new BN(ix.data.expiry.toString(10)),
                    nonce: new BN(log.nonce),
                    payOut: ix.data.payOut,
                    kind: ix.data.kind
                });
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

    startRestServer() {
        this.restServer = express();
        this.restServer.use(cors());
        this.restServer.use(express.json());

        this.restServer.post("/payInvoice", async (req, res) => {
            /**
             * address: string                      Bitcoin destination address
             * amount: string                       Amount to send (in satoshis)
             * confirmationTarget: number           Desired confirmation target for the swap, how big of a fee should be assigned to TX
             * confirmations: number                Required number of confirmations for us to claim the swap
             * nonce: string                        Nonce for the swap (used for replay protection)
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
                typeof(req.body.nonce) !== "string"
            ) {
                res.status(400).json({
                    msg: "Invalid request body (address/amount/confirmationTarget/confirmations/nonce)"
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

            const expirySeconds = ToBtc.getExpiryFromCLTV(req.body.confirmationTarget, req.body.confirmations).add(new BN(GRACE_PERIOD)); //Add grace period another time, so the user has 1 hour to commit

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

            const createdSwap = new ToBtcSwap(req.body.address, amountBD, swapFee, nonce, req.body.confirmationTarget);
            const paymentHash = createdSwap.getHash();

            const total = amountBD.add(swapFee).add(networkFeeAdjusted);

            const currentTimestamp = new BN(Math.floor(Date.now()/1000));
            const minRequiredExpiry = currentTimestamp.add(expirySeconds);

            const payObject: ToBtcData = {
                intermediary: AnchorSigner.publicKey,
                token: WBTC_ADDRESS,
                amount: total,
                paymentHash: createdSwap.getHash().toString("hex"),
                expiry: minRequiredExpiry,
                nonce: nonce,
                initializer: null,
                confirmations: req.body.confirmations,
                payOut: false,
                kind: 2
            };

            createdSwap.data = payObject;

            await this.storageManager.saveData(paymentHash, createdSwap);

            const sigData = getClaimInitSignature(payObject);

            res.status(200).json({
                code: 20000,
                msg: "Success",
                data: {
                    address: AnchorSigner.wallet.publicKey,
                    networkFee: networkFeeAdjusted.toString(10),
                    satsPervByte: feeSatsPervByteAdjusted.toString(10),
                    swapFee: swapFee.toString(10),
                    totalFee: swapFee.add(networkFeeAdjusted).toString(10),
                    total: total.toString(10),
                    minRequiredExpiry: minRequiredExpiry.toString(),

                    data: createdSwap.serialize().data,

                    nonce: sigData.nonce,
                    prefix: sigData.prefix,
                    timeout: sigData.timeout,
                    signature: sigData.signature
                }
            });

        });

        this.restServer.post("/getRefundAuthorization", async (req, res) => {
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

                    const escrowState = await getEscrow(hash);

                    if (escrowState == null) {
                        res.status(400).json({
                            code: 20005,
                            msg: "Not committed"
                        });
                        return;
                    }

                    const refundResponse = getRefundSignature(escrowState);

                    res.status(200).json({
                        code: 20000,
                        msg: "Success",
                        data: {
                            address: AnchorSigner.signer.publicKey,
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

        this.restServer.listen(this.restPort);

        console.log("[To BTC: REST] Started on port: ", this.restPort);
    }

    subscribeToEvents() {
        SolEvents.registerListener(this.processEvent.bind(this));

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
        await this.storageManager.loadData(ToBtcSwap);
        this.subscribeToEvents();
    }

}

export default ToBtc;