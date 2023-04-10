import * as BN from "bn.js";
import {TokenAddress} from "./TokenAddress";

interface ISwapPrice {

    /**
     * Returns amount of satoshis that are equivalent to {fromAmount} of {fromToken}
     *
     * @param fromAmount        Amount of the token
     * @param fromToken         Token
     */
    getToBtcSwapAmount(fromAmount:BN, fromToken: TokenAddress): Promise<BN>;

    /**
     * Returns amount of {toToken} that are equivalent to {fromAmount} satoshis
     *
     * @param fromAmount        Amount of satoshis
     * @param toToken           Token
     */
    getFromBtcSwapAmount(fromAmount:BN, toToken: TokenAddress): Promise<BN>;

}

export default ISwapPrice;