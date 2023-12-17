import {BitcoindRpc} from "btcrelay-bitcoind";
import {BtcRelay, ChainEvents, SwapContract} from "crosslightning-base";
import {IPlugin, ISwapPrice, SwapNonce} from "crosslightning-intermediary";
import {SolanaSwapData} from "crosslightning-solana";

export function getEnabledPlugins(
    swapPrice: ISwapPrice,
    btcRpc: BitcoindRpc,
    swapNonce: SwapNonce,
    btcRelay: BtcRelay<any, any, any>,
    swapProgram: SwapContract<SolanaSwapData, any>,
    chainEvents: ChainEvents<SolanaSwapData>
): IPlugin<SolanaSwapData>[] {
    return [];
};
