import SwapEvent from "./SwapEvent";
import SwapData from "../../swaps/SwapData";

class InitializeEvent<T extends SwapData> extends SwapEvent<T> {

    txoHash: string;
    signatureNonce: number;
    swapData: T;

    constructor(paymentHash: string, txoHash: string, signatureNonce: number, swapData: T) {
        super(paymentHash);
        this.txoHash = txoHash;
        this.signatureNonce = signatureNonce;
        this.swapData = swapData;
    }

}

export default InitializeEvent;