import {BitcoindRpc} from "btcrelay-bitcoind";
import {BtcRelay, ChainEvents, SwapContract} from "crosslightning-base";
import {IPlugin, ISwapPrice} from "crosslightning-intermediary";
import {SolanaSwapData} from "crosslightning-solana";

export function getEnabledPlugins(
    swapPrice: ISwapPrice,
    btcRpc: BitcoindRpc,
    btcRelay: BtcRelay<any, any, any>,
    swapProgram: SwapContract<SolanaSwapData, any, any, any>,
    chainEvents: ChainEvents<SolanaSwapData>
): IPlugin<SolanaSwapData>[] {
    return [];
};
