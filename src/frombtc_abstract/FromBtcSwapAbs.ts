import * as BN from "bn.js";
import * as bitcoin from "bitcoinjs-lib";
import {BITCOIN_NETWORK} from "../Constants";
import {createHash} from "crypto";
import SwapData from "../swaps/SwapData";
import Lockable from "../Lockable";

export enum FromBtcSwapState {
    CANCELED = -1,
    CREATED = 0,
    COMMITED = 1
}

export class FromBtcSwapAbs<T extends SwapData> extends Lockable implements StorageObject {

    state: FromBtcSwapState;
    readonly address: string;
    readonly amount: BN;
    readonly swapFee: BN;
    authorizationExpiry: BN;

    data: T;

    constructor(address: string, amount: BN, swapFee: BN);
    constructor(obj: any);

    constructor(prOrObj: string | any, amount?: BN, swapFee?: BN) {
        super();
        if(typeof(prOrObj)==="string") {
            this.state = FromBtcSwapState.CREATED;
            this.address = prOrObj;
            this.amount = amount;
            this.swapFee = swapFee;
        } else {
            this.state = prOrObj.state;
            this.address = prOrObj.address;
            this.amount = new BN(prOrObj.amount);
            this.swapFee = new BN(prOrObj.swapFee);
            this.authorizationExpiry = prOrObj.authorizationExpiry==null ? null : new BN(prOrObj.authorizationExpiry);
            if(prOrObj.data!=null) {
                this.data = SwapData.deserialize(prOrObj.data);
            }
        }
    }

    serialize(): any {
        return {
            state: this.state,
            address: this.address,
            amount: this.amount.toString(10),
            swapFee: this.swapFee.toString(10),
            authorizationExpiry: this.authorizationExpiry==null ? null : this.authorizationExpiry.toString(10),
            data: this.data==null ? null : this.data.serialize(),
        }
    }

    getHash(): Buffer {
        const parsedOutputScript = bitcoin.address.toOutputScript(this.address, BITCOIN_NETWORK);

        return createHash("sha256").update(Buffer.concat([
            Buffer.from(new BN(0).toArray("le", 8)),
            Buffer.from(this.amount.toArray("le", 8)),
            parsedOutputScript
        ])).digest();
    }

    getTxoHash(): Buffer {
        const parsedOutputScript = bitcoin.address.toOutputScript(this.address, BITCOIN_NETWORK);

        return createHash("sha256").update(Buffer.concat([
            Buffer.from(this.amount.toArray("le", 8)),
            parsedOutputScript
        ])).digest();
    }

}
