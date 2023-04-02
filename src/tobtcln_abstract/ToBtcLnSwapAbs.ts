import * as BN from "bn.js";
import * as bolt11 from "bolt11";
import SwapData from "../swaps/SwapData";
import Lockable from "../Lockable";

export enum ToBtcLnSwapState {
    NON_PAYABLE = -1,
    SAVED = 0,
    COMMITED = 1
}

export class ToBtcLnSwapAbs<T extends SwapData> extends Lockable implements StorageObject {

    state: ToBtcLnSwapState;
    readonly pr: string;
    readonly swapFee: BN;

    data: T;

    constructor(pr: string, swapFee: BN);
    constructor(obj: any);

    constructor(prOrObj: string | any, swapFee?: BN) {
        super();
        if(typeof(prOrObj)==="string") {
            this.state = ToBtcLnSwapState.SAVED;
            this.pr = prOrObj;
            this.swapFee = swapFee;
        } else {
            this.state = prOrObj.state;
            this.pr = prOrObj.pr;
            this.swapFee = new BN(prOrObj.swapFee);

            if(prOrObj.data!=null) {
                this.data = SwapData.deserialize(prOrObj.data);
            }
        }
    }

    serialize(): any {
        return {
            state: this.state,
            pr: this.pr,
            swapFee: this.swapFee.toString(10),
            data: this.data==null ? null : this.data.serialize(),
        }
    }

    getHash(): string {
        return bolt11.decode(this.pr).tagsObject.payment_hash;
    }

}