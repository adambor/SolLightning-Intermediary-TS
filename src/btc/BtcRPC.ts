import * as RpcClient from "bitcoind-rpc";

const config = {
    protocol: process.env.BTC_PROTOCOL,
    user: process.env.BTC_RPC_USERNAME,
    pass: process.env.BTC_RPC_PASSWORD,
    host: process.env.BTC_NODE_HOST,
    port: process.env.BTC_PORT,
};

const BtcRPC = new RpcClient(config);

export default BtcRPC;

