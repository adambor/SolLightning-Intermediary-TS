import * as BN from "bn.js";
import {PublicKey} from "@solana/web3.js";

export type ToBtcLnData = {
    initializer: PublicKey,
    intermediary: PublicKey,
    token: PublicKey,
    amount: BN,
    paymentHash: string,
    expiry: BN
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
                    initializer: new PublicKey(prOrObj.data.initializer),
                    intermediary: new PublicKey(prOrObj.data.intermediary),
                    token: new PublicKey(prOrObj.data.token),
                    amount: new BN(prOrObj.data.amount),
                    paymentHash: prOrObj.data.paymentHash,
                    expiry: new BN(prOrObj.data.expiry),
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
                initializer: this.data.initializer.toBase58(),
                intermediary: this.data.intermediary.toBase58(),
                token: this.data.token.toBase58(),
                amount: this.data.amount.toString(10),
                paymentHash: this.data.paymentHash,
                expiry: this.data.expiry.toString(10),
            },
        }
    }

}
