import * as BN from "bn.js";
import {PublicKey} from "@solana/web3.js";

export type FromBtcData = {
    intermediary: PublicKey,
    token: PublicKey,
    amount: BN,
    paymentHash: string,
    expiry: BN
};

export enum FromBtcSwapState {
    CANCELED = -1,
    CREATED = 0,
    RECEIVED = 1,
    COMMITED = 2,
    CLAIMED = 3
}

export class FromBtcSwap implements StorageObject {

    state: FromBtcSwapState;
    readonly address: string;
    readonly paymentHash: Buffer;
    readonly btcPublicKey: Buffer;
    readonly ourKeyIndex: number;
    readonly csvDelta: number;
    readonly swapFee: BN;

    data: FromBtcData;
    secret: string;

    constructor(address: string, swapFee: BN, paymentHash: Buffer, btcPublicKey: Buffer, ourKeyIndex: number, csvDelta:number);
    constructor(obj: any);

    constructor(prOrObj: string | any, swapFee?: BN, paymentHash?: Buffer, btcPublicKey?: Buffer, ourKeyIndex?: number, csvDelta?:number) {
        if(typeof(prOrObj)==="string") {
            this.state = FromBtcSwapState.CREATED;
            this.address = prOrObj;
            this.paymentHash = paymentHash;
            this.btcPublicKey = btcPublicKey;
            this.ourKeyIndex = ourKeyIndex;
            this.csvDelta = csvDelta;
            this.swapFee = swapFee;
        } else {
            this.state = prOrObj.state;
            this.address = prOrObj.address;
            this.paymentHash = Buffer.from(prOrObj.paymentHash, "hex");
            this.btcPublicKey = Buffer.from(prOrObj.btcPublicKey, "hex");
            this.ourKeyIndex = prOrObj.ourKeyIndex;
            this.csvDelta = prOrObj.csvDelta;
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
            address: this.address,
            paymentHash: this.paymentHash.toString("hex"),
            btcPublicKey: this.btcPublicKey.toString("hex"),
            ourKeyIndex: this.ourKeyIndex,
            csvDelta: this.csvDelta,
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
