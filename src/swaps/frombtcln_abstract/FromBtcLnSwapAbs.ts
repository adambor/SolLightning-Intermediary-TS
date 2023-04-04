import * as BN from "bn.js";
import SwapData from "../SwapData";
import Lockable from "../../lockable/Lockable";

export enum FromBtcLnSwapState {
    CANCELED = -1,
    CREATED = 0,
    RECEIVED = 1,
    COMMITED = 2,
    CLAIMED = 3
}

export class FromBtcLnSwapAbs<T extends SwapData> extends Lockable implements StorageObject {

    state: FromBtcLnSwapState;
    readonly pr: string;
    readonly swapFee: BN;

    data: T;
    secret: string;

    constructor(pr: string, swapFee: BN);
    constructor(obj: any);

    constructor(prOrObj: string | any, swapFee?: BN) {
        super();
        if(typeof(prOrObj)==="string") {
            this.state = FromBtcLnSwapState.CREATED;
            this.pr = prOrObj;
            this.swapFee = swapFee;
        } else {
            this.state = prOrObj.state;
            this.pr = prOrObj.pr;
            this.swapFee = new BN(prOrObj.swapFee);
            if(prOrObj.data!=null) {
                this.data = SwapData.deserialize(prOrObj.data);
            }
            this.secret = prOrObj.secret;
        }
    }

    serialize(): any {
        return {
            state: this.state,
            pr: this.pr,
            swapFee: this.swapFee.toString(10),
            data: this.data==null ? null : this.data.serialize(),
            secret: this.secret
        }
    }

}
