import * as BN from "bn.js";
import {TokenAddress} from "../swaps/TokenAddress";
import {PublicKey} from "@solana/web3.js";
import fetch, {Response} from "cross-fetch";
import ISwapPrice from "../swaps/ISwapPrice";

const CACHE_DURATION = 5000;

class CoinGeckoSwapPrice implements ISwapPrice {

    COINS_MAP: {
        [address: string]: {
            coinId: string,
            decimals: number
        }
    };

    url: string;
    cache: {
        [coinId: string]: {
            price: BN,
            expiry: number
        }
    } = {};

    constructor(url?: string, usdcAddress?: string, usdtAddress?: string, solAddress?: string, wbtcAddress?: string) {
        this.url = url || "https://api.coingecko.com/api/v3";
        this.COINS_MAP = {
            [usdcAddress]: {
                coinId: "usd-coin",
                decimals: 6
            },
            [usdtAddress]: {
                coinId: "tether",
                decimals: 6
            },
            [solAddress]: {
                coinId: "solana",
                decimals: 9
            },
            [wbtcAddress]: {
                coinId: "wrapped-bitcoin",
                decimals: 8
            }
        };
    }

    /**
     * Returns coin price in mSat
     *
     * @param coinId
     */
    async getPrice(coinId: string): Promise<BN> {

        const cachedValue = this.cache[coinId];
        if(cachedValue!=null && cachedValue.expiry>Date.now()) {
            return cachedValue.price;
        }

        const response: Response = await fetch(this.url+"/simple/price?ids="+coinId+"&vs_currencies=sats&precision=3", {
            method: "GET",
            headers: {'Content-Type': 'application/json'}
        });

        if(response.status!==200) {
            let resp: string;
            try {
                resp = await response.text();
            } catch (e) {
                throw new Error(response.statusText);
            }
            throw new Error(resp);
        }

        let jsonBody: any = await response.json();

        const amt: number = jsonBody[coinId].sats;

        const result = new BN(amt*1000);

        this.cache[coinId] = {
            price: result,
            expiry: Date.now()+CACHE_DURATION
        };

        return result;
    }

    async getFromBtcSwapAmount(fromAmount: BN, toToken: TokenAddress): Promise<BN> {
        let tokenAddress: string = toToken.toString();

        const coin = this.COINS_MAP[tokenAddress];

        if(coin==null) throw new Error("Token not found");

        const price = await this.getPrice(coin.coinId);

        return fromAmount
            .mul(new BN(10).pow(new BN(coin.decimals)))
            .mul(new BN(1000)) //To msat
            .div(price)
    }

    async getToBtcSwapAmount(fromAmount: BN, fromToken: TokenAddress): Promise<BN> {
        let tokenAddress: string = fromToken.toString();

        const coin = this.COINS_MAP[tokenAddress];

        if(coin==null) throw new Error("Token not found");

        const price = await this.getPrice(coin.coinId);

        return fromAmount
            .mul(price)
            .div(new BN(1000))
            .div(new BN(10).pow(new BN(coin.decimals)));
    }

}

export default CoinGeckoSwapPrice;