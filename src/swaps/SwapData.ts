import SolanaSwapData from "../chains/solana/swaps/SolanaSwapData";
import SwapType from "./SwapType";
import * as BN from "bn.js";
import {TokenAddress} from "./TokenAddress";

abstract class SwapData implements StorageObject {

    static deserialize<T extends SwapData>(data: any): T {
        if(data.type==="sol") {
            return new SolanaSwapData(data) as unknown as T;
        }
    }

    abstract serialize(): any;

    abstract getType(): SwapType;

    abstract getAmount(): BN;

    abstract getToken(): TokenAddress;

    abstract isToken(token: TokenAddress): boolean;

    abstract getExpiry(): BN;

    abstract getConfirmations(): number;

    abstract getEscrowNonce(): BN;

    abstract isPayOut(): boolean;

    abstract isPayIn(): boolean;

    abstract getHash(): string;

}

export default SwapData;