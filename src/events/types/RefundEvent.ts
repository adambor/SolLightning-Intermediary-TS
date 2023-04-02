import SwapEvent from "./SwapEvent";
import SwapData from "../../swaps/SwapData";

class RefundEvent<T extends SwapData> extends SwapEvent<T> {

    constructor(paymentHash: string) {
        super(paymentHash);
    }

}

export default RefundEvent;