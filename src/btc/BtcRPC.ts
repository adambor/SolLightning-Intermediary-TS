import * as RpcClient from "bitcoind-rpc";
import {IntermediaryConfig} from "../IntermediaryConfig";

export const BtcRPCConfig = {
    protocol: IntermediaryConfig.BITCOIND.PROTOCOL,
    user: IntermediaryConfig.BITCOIND.RPC_USERNAME,
    pass: IntermediaryConfig.BITCOIND.RPC_PASSWORD,
    host:  IntermediaryConfig.BITCOIND.HOST,
    port: IntermediaryConfig.BITCOIND.PORT
};

const BtcRPC = new RpcClient(BtcRPCConfig);

export default BtcRPC;

