import SwapEvent from "./SwapEvent";
import SwapData from "../../swaps/SwapData";

class ClaimEvent<T extends SwapData> extends SwapEvent<T> {

    secret: string;

    constructor(paymentHash: string, secret: string) {
        super(paymentHash);
        this.secret = secret;
    }

}

export default ClaimEvent;