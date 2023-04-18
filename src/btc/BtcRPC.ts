import * as RpcClient from "bitcoind-rpc";

export const BtcRPCConfig = {
    protocol: process.env.BTC_PROTOCOL,
    user: process.env.BTC_RPC_USERNAME,
    pass: process.env.BTC_RPC_PASSWORD,
    host: process.env.BTC_NODE_HOST,
    port: parseInt(process.env.BTC_PORT),
};

const BtcRPC = new RpcClient(BtcRPCConfig);

export default BtcRPC;

