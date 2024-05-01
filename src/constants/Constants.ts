import {PublicKey} from "@solana/web3.js";
import * as BN from "bn.js";
import * as bitcoin from "bitcoinjs-lib";
import {IntermediaryConfig} from "../IntermediaryConfig";

//Bitcoin
export const BITCOIN_NETWORK = IntermediaryConfig.BITCOIND.NETWORK==="mainnet" ? bitcoin.networks.bitcoin : bitcoin.networks.testnet;
export const BITCOIN_BLOCKTIME = new BN(process.env.BITCOIN_BLOCKTIME);

//Swap safety
export const GRACE_PERIOD = new BN(process.env.GRACE_PERIOD);
export const SAFETY_FACTOR = new BN(process.env.SAFETY_FACTOR);
export const CHAIN_SEND_SAFETY_FACTOR = new BN(process.env.CHAIN_SEND_SAFETY_FACTOR);

//On-chain fee multiplier PPM
export const NETWORK_FEE_MULTIPLIER_PPM = new BN(1000000).add(IntermediaryConfig.ONCHAIN.NETWORK_FEE_ADD_PERCENTAGE);

//Solana
export const MAX_SOL_SKEW = parseInt(process.env.MAX_SOL_SKEW); //How long to wait to refund back the order after its expiry

//Authorizations
export const AUTHORIZATION_TIMEOUT = parseInt(process.env.AUTHORIZATION_TIMEOUT);
