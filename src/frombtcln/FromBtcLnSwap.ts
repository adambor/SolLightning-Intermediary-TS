import * as BN from "bn.js";
import {PublicKey} from "@solana/web3.js";

export type FromBtcLnData = {
    intermediary: PublicKey,
    token: PublicKey,
    amount: BN,
    paymentHash: string,
    expiry: BN
};

export enum FromBtcLnSwapState {
    CANCELED = -1,
    CREATED = 0,
    RECEIVED = 1,
    COMMITED = 2,
    CLAIMED = 3
}

export class FromBtcLnSwap implements StorageObject {

    state: FromBtcLnSwapState;
    readonly pr: string;
    readonly swapFee: BN;

    data: FromBtcLnData;
    secret: string;

    constructor(pr: string, swapFee: BN);
    constructor(obj: any);

    constructor(prOrObj: string | any, swapFee?: BN) {
        if(typeof(prOrObj)==="string") {
            this.state = FromBtcLnSwapState.CREATED;
            this.pr = prOrObj;
            this.swapFee = swapFee;
        } else {
            this.state = prOrObj.state;
            this.pr = prOrObj.pr;
            this.swapFee = new BN(prOrObj.swapFee);
            if(prOrObj.data!=null) {
                this.data = {
                    intermediary: new PublicKey(prOrObj.data.intermediary),
                    token: new PublicKey(prOrObj.data.token),
                    amount: new BN(prOrObj.data.amount),
                    paymentHash: prOrObj.data.paymentHash,
                    expiry: new BN(prOrObj.data.expiry)
                };
            }
            this.secret = prOrObj.secret;
        }
    }

    serialize(): any {
        return {
            state: this.state,
            pr: this.pr,
            swapFee: this.swapFee.toString(10),
            data: this.data==null ? null : {
                intermediary: this.data.intermediary.toBase58(),
                token: this.data.token.toBase58(),
                amount: this.data.amount.toString(10),
                paymentHash: this.data.paymentHash,
                expiry: this.data.expiry.toString(10),
            },
            secret: this.secret
        }
    }

}
