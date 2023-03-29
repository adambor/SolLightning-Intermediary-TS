import * as BN from "bn.js";
import {PublicKey} from "@solana/web3.js";
import * as bitcoin from "bitcoinjs-lib";
import {BITCOIN_NETWORK} from "../Constants";
import {createHash} from "crypto";

export type FromBtcData = {
    intermediary: PublicKey,
    token: PublicKey,
    amount: BN,
    paymentHash: string,
    expiry: BN,
    kind: number,
    confirmations: number,
    payOut?: boolean
};

export enum FromBtcSwapState {
    CANCELED = -1,
    CREATED = 0,
    COMMITED = 1
}

export class FromBtcSwap implements StorageObject {

    state: FromBtcSwapState;
    readonly address: string;
    readonly amount: BN;
    readonly swapFee: BN;
    authorizationExpiry: BN;

    data: FromBtcData;
    secret: string;

    constructor(address: string, amount: BN, swapFee: BN);
    constructor(obj: any);

    constructor(prOrObj: string | any, amount?: BN, swapFee?: BN) {
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
                this.data = {
                    intermediary: new PublicKey(prOrObj.data.intermediary),
                    token: new PublicKey(prOrObj.data.token),
                    amount: new BN(prOrObj.data.amount),
                    paymentHash: prOrObj.data.paymentHash,
                    expiry: new BN(prOrObj.data.expiry),
                    kind: prOrObj.data.kind,
                    confirmations: prOrObj.data.confirmations,
                    payOut: prOrObj.data.payOut
                };
            }
            this.secret = prOrObj.secret;
        }
    }

    serialize(): any {
        return {
            state: this.state,
            address: this.address,
            amount: this.amount.toString(10),
            swapFee: this.swapFee.toString(10),
            authorizationExpiry: this.authorizationExpiry==null ? null : this.authorizationExpiry.toString(10),
            data: this.data==null ? null : {
                intermediary: this.data.intermediary.toBase58(),
                token: this.data.token.toBase58(),
                amount: this.data.amount.toString(10),
                paymentHash: this.data.paymentHash,
                expiry: this.data.expiry.toString(10),
                kind: this.data.kind,
                confirmations: this.data.confirmations,
                payOut: this.data.payOut
            },
            secret: this.secret
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
