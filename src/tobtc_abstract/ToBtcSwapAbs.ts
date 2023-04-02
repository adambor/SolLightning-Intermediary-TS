import * as BN from "bn.js";
import {PublicKey} from "@solana/web3.js";
import {createHash} from "crypto";
import * as bitcoin from "bitcoinjs-lib";
import {BITCOIN_NETWORK} from "../Constants";
import SwapData from "../swaps/SwapData";
import Lockable from "../Lockable";

export enum ToBtcSwapState {
    NON_PAYABLE = -1,
    SAVED = 0,
    COMMITED = 1,
    BTC_SENDING = 2,
    BTC_SENT = 3
}

export class ToBtcSwapAbs<T extends SwapData> extends Lockable implements StorageObject {

    state: ToBtcSwapState;
    readonly address: string;
    readonly amount: BN;
    readonly swapFee: BN;
    readonly nonce: BN;
    readonly preferedConfirmationTarget: number;

    txId: string;

    data: T;

    constructor(address: string, amount: BN, swapFee: BN, nonce: BN, preferedConfirmationTarget: number);
    constructor(obj: any);

    constructor(prOrObj: string | any, amount?: BN, swapFee?: BN, nonce?: BN, preferedConfirmationTarget?: number) {
        super();
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

            if(prOrObj.data!=null) {
                this.data = SwapData.deserialize<T>(prOrObj.data);
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

            data: this.data==null ? null : this.data.serialize(),
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
