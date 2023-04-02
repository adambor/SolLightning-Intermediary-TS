import SwapEvent from "./types/SwapEvent";
import SwapData from "../swaps/SwapData";

export type EventListener<T extends SwapData> = (obj: SwapEvent<T>[]) => Promise<boolean>;

interface ChainEvents<T extends SwapData> {

    init(): Promise<void>;
    registerListener(cbk: EventListener<T>): void;
    unregisterListener(cbk: EventListener<T>): boolean;

}

export default ChainEvents;