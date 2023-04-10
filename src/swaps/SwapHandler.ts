
import {Express} from "express";
import SwapData from "./SwapData";
import StorageManager from "../storagemanager/StorageManager";
import {ToBtcSwapAbs} from "./tobtc_abstract/ToBtcSwapAbs";
import SwapContract from "./SwapContract";
import ChainEvents from "../events/ChainEvents";
import SwapNonce from "./SwapNonce";
import ISwapPrice from "./ISwapPrice";
import {TokenAddress} from "./TokenAddress";

export enum SwapHandlerType {
    TO_BTC = "TO_BTC",
    FROM_BTC = "FROM_BTC",
    TO_BTCLN = "TO_BTCLN",
    FROM_BTCLN = "FROM_BTCLN",
}

export type SwapHandlerInfoType = {
    swapFeePPM: number,
    swapBaseFee: number,
    min: number,
    max: number,
    tokens: string[],
    data?: any,
};

abstract class SwapHandler<V extends StorageObject, T extends SwapData> {

    abstract readonly type: SwapHandlerType;

    readonly storageManager: StorageManager<V>;
    readonly path: string;

    readonly swapContract: SwapContract<T>;
    readonly chainEvents: ChainEvents<T>;
    readonly nonce: SwapNonce;
    readonly allowedTokens: Set<string>;
    readonly swapPricing: ISwapPrice;

    protected constructor(storageDirectory: string, path: string, swapContract: SwapContract<T>, chainEvents: ChainEvents<T>, swapNonce: SwapNonce, allowedTokens: TokenAddress[], swapPricing: ISwapPrice) {
        this.storageManager = new StorageManager<V>(storageDirectory);
        this.swapContract = swapContract;
        this.chainEvents = chainEvents;
        this.nonce = swapNonce;
        this.path = path;
        this.allowedTokens = new Set<string>(allowedTokens.map(e => e.toString()));
        this.swapPricing = swapPricing;
    }

    abstract init(): Promise<void>;
    abstract startWatchdog(): Promise<void>;
    abstract startRestServer(restServer: Express): void;
    abstract getInfo(): SwapHandlerInfoType;

}

export default SwapHandler;