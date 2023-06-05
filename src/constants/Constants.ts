import {PublicKey} from "@solana/web3.js";
import * as BN from "bn.js";
import * as bitcoin from "bitcoinjs-lib";

//Bitcoin
export const BITCOIN_NETWORK = process.env.BTC_NETWORK==="mainnet" ? bitcoin.networks.bitcoin : bitcoin.networks.testnet;
export const BITCOIN_BLOCKTIME = new BN(10*60);

//Swap safety
export const GRACE_PERIOD = new BN(60*60); //1 hour
export const SAFETY_FACTOR = new BN(2);
export const CHAIN_SEND_SAFETY_FACTOR = new BN(2);

//On-chain fee multiplier PPM
export const NETWORK_FEE_MULTIPLIER_PPM = new BN(1500000);

//Solana
export const MAX_SOL_SKEW = 10*60; //How long to wait to refund back the order after its expiry
export const WBTC_ADDRESS = new PublicKey(process.env.WBTC_ADDRESS);
export const USDC_ADDRESS = process.env.USDC_ADDRESS==null ? null : new PublicKey(process.env.USDC_ADDRESS);
export const USDT_ADDRESS = process.env.USDT_ADDRESS==null ? null : new PublicKey(process.env.USDT_ADDRESS);
export const WSOL_ADDRESS = process.env.USDT_ADDRESS==null ? null : new PublicKey(process.env.WSOL_ADDRESS);

//Authorizations
export const AUTHORIZATION_TIMEOUT = 10*60;

//LN fees
export const LN_BASE_FEE = new BN(10);
export const LN_FEE_PPM = new BN(3000);

export const LN_MIN = new BN(1000);
export const LN_MAX = new BN(1000000);

//On-chain fees
export const CHAIN_BASE_FEE = new BN(50);
export const CHAIN_FEE_PPM = new BN(3000);

export const CHAIN_MIN = new BN(10000);
export const CHAIN_MAX = new BN(1000000);
