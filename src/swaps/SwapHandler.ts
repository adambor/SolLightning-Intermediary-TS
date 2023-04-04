
import {Express} from "express";

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
    data?: any
};

interface SwapHandler {

    readonly type: SwapHandlerType;

    init(): Promise<void>;
    startWatchdog(): Promise<void>;
    startRestServer(restServer: Express): void;
    getInfo(): SwapHandlerInfoType;

}

export default SwapHandler;