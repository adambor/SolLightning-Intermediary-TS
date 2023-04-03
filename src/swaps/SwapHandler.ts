

interface SwapHandler {

    init(): Promise<void>;
    startWatchdog(): Promise<void>;
    startRestServer(): void;

}

export default SwapHandler;