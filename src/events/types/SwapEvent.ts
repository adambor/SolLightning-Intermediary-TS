import SwapData from "../../swaps/SwapData";


class SwapEvent<T extends SwapData> {

    paymentHash: string;

    constructor(paymentHash: string) {
        this.paymentHash = paymentHash;
    }

}

export default SwapEvent;