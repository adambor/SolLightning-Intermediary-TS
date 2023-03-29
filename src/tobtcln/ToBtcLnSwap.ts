import * as BN from "bn.js";
import {PublicKey} from "@solana/web3.js";
import * as bolt11 from "bolt11";

export type ToBtcLnData = {
    initializer: PublicKey,
    intermediary: PublicKey,
    token: PublicKey,
    amount: BN,
    paymentHash: string,
    expiry: BN,

    nonce: BN,
    confirmations: number,
    payOut: boolean
};

export enum ToBtcLnSwapState {
    NON_PAYABLE = -1,
    SAVED = 0,
    COMMITED = 1
}

export class ToBtcLnSwap implements StorageObject{

    state: ToBtcLnSwapState;
    readonly pr: string;
    readonly swapFee: BN;

    offerer: PublicKey;
    data: ToBtcLnData;

    constructor(pr: string, swapFee: BN);
    constructor(obj: any);

    constructor(prOrObj: string | any, swapFee?: BN) {
        if(typeof(prOrObj)==="string") {
            this.state = ToBtcLnSwapState.SAVED;
            this.pr = prOrObj;
            this.swapFee = swapFee;
        } else {
            this.state = prOrObj.state;
            this.pr = prOrObj.pr;
            this.swapFee = new BN(prOrObj.swapFee);

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
                };
            }
        }
    }

    serialize(): any {
        return {
            state: this.state,
            pr: this.pr,
            swapFee: this.swapFee.toString(10),
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
            },
        }
    }

    getHash(): string {
        return bolt11.decode(this.pr).tagsObject.payment_hash;
    }

}
