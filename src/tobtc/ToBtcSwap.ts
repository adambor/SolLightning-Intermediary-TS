import * as BN from "bn.js";
import {PublicKey} from "@solana/web3.js";
import {createHash} from "crypto";
import * as bitcoin from "bitcoinjs-lib";
import {BITCOIN_NETWORK} from "../Constants";

export type ToBtcData = {
    initializer: PublicKey,
    intermediary: PublicKey,
    token: PublicKey,
    amount: BN,
    paymentHash: string,
    expiry: BN,

    nonce: BN,
    confirmations: number,
    payOut: boolean,
    kind: number
};

export enum ToBtcSwapState {
    NON_PAYABLE = -1,
    SAVED = 0,
    COMMITED = 1,
    BTC_SENDING = 2,
    BTC_SENT = 3
}

export class ToBtcSwap implements StorageObject {

    state: ToBtcSwapState;
    readonly address: string;
    readonly amount: BN;
    readonly swapFee: BN;
    readonly nonce: BN;
    readonly preferedConfirmationTarget: number;

    txId: string;

    offerer: PublicKey;
    data: ToBtcData;

    constructor(address: string, amount: BN, swapFee: BN, nonce: BN, preferedConfirmationTarget: number);
    constructor(obj: any);

    constructor(prOrObj: string | any, amount?: BN, swapFee?: BN, nonce?: BN, preferedConfirmationTarget?: number) {
        if(typeof(prOrObj)==="string") {
            this.state = ToBtcSwapState.SAVED;
            this.address = prOrObj;
            this.amount = amount;
            this.swapFee = swapFee;
            this.nonce = nonce;
            this.preferedConfirmationTarget = preferedConfirmationTarget;
        } else {
            this.state = prOrObj.state;
            this.address = prOrObj.address;
            this.amount = new BN(prOrObj.amount);
            this.swapFee = new BN(prOrObj.swapFee);
            this.nonce = new BN(prOrObj.nonce);
            this.preferedConfirmationTarget = prOrObj.preferedConfirmationTarget;

            if(prOrObj.offerer!=null) this.offerer = new PublicKey(prOrObj.offerer);
            if(prOrObj.data!=null) {
                this.data = {
                    initializer: prOrObj.data.initializer==null ? null : new PublicKey(prOrObj.data.initializer),
                    intermediary: new PublicKey(prOrObj.data.intermediary),
                    token: new PublicKey(prOrObj.data.token),
                    amount: new BN(prOrObj.data.amount),
                    paymentHash: prOrObj.data.paymentHash,
                    expiry: new BN(prOrObj.data.expiry),
                    nonce: new BN(prOrObj.data.nonce),
                    confirmations: prOrObj.data.confirmations,
                    payOut: prOrObj.data.payOut,
                    kind: prOrObj.data.kind,
                };
            }
            this.txId = prOrObj.txId;
        }
    }

    serialize(): any {
        return {
            state: this.state,
            address: this.address,
            amount: this.amount.toString(10),
            swapFee: this.swapFee.toString(10),

            nonce: this.nonce.toString(10),
            preferedConfirmationTarget: this.preferedConfirmationTarget,

            offerer: this.offerer==null ? null : this.offerer.toBase58(),
            data: this.data==null ? null : {
                initializer: this.data.initializer==null ? null : this.data.initializer.toBase58(),
                intermediary: this.data.intermediary.toBase58(),
                token: this.data.token.toBase58(),
                amount: this.data.amount.toString(10),
                paymentHash: this.data.paymentHash,
                expiry: this.data.expiry.toString(10),
                nonce: this.data.nonce.toString(10),
                confirmations: this.data.confirmations,
                payOut: this.data.payOut,
                kind: this.data.kind,
            },
            txId: this.txId
        }
    }

    getHash(): Buffer {
        const parsedOutputScript = bitcoin.address.toOutputScript(this.address, BITCOIN_NETWORK);

        return createHash("sha256").update(Buffer.concat([
            Buffer.from(this.nonce.toArray("le", 8)),
            Buffer.from(this.amount.toArray("le", 8)),
            parsedOutputScript
        ])).digest();
    }

}
