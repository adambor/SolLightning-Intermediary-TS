import SwapData from "./SwapData";
import {TokenAddress} from "./TokenAddress";
import * as BN from "bn.js";
import SwapType from "./SwapType";
import SwapNonce from "./SwapNonce";

interface SwapContract<T extends SwapData> {

    claimWithSecretTimeout: number;
    claimWithTxDataTimeout: number;
    refundTimeout: number;

    claimWithSecret(swapData: T, secret: string): Promise<boolean>;
    claimWithTxData(swapData: T, tx: {blockhash: string, confirmations: number, txid: string, hex: string}, vout: number): Promise<boolean>;
    refund(swapData: T): Promise<boolean>;

    isCommited(swapData: T): Promise<boolean>;
    getCommitedData(paymentHash: string): Promise<T>;

    getClaimInitSignature(swapData: T, nonce: SwapNonce): Promise<{
        nonce: number,
        prefix: string,
        timeout: string,
        signature: string
    }>;
    getInitSignature(swapData: T, nonce: SwapNonce): Promise<{
        nonce: number,
        prefix: string,
        timeout: string,
        signature: string
    }>;
    getRefundSignature(swapData: T): Promise<{
        prefix: string,
        timeout: string,
        signature: string
    }>;
    getDataSignature(data: Buffer): Promise<string>;

    getBalance(token: TokenAddress): Promise<BN>;

    createSwapData(
        type: SwapType,
        offerer: string,
        claimer: string,
        token: TokenAddress,
        amount: BN,
        paymentHash: string,
        expiry: BN,
        escrowNonce: BN,
        confirmations: number,
        payOut: boolean
    ): T;

    areWeClaimer(swapData: T): boolean;
    areWeOfferer(swapData: T): boolean;

    getAddress(): string;
    isValidAddress(address: string): boolean;

    toTokenAddress(address: string): TokenAddress;

}

export default SwapContract;