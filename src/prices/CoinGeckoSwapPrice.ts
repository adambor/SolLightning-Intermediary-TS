import ISwapPrice from "../swaps/ISwapPrice";
import * as BN from "bn.js";
import {TokenAddress} from "../swaps/TokenAddress";
import {PublicKey} from "@solana/web3.js";
import fetch, {Response} from "cross-fetch";

const COINS_MAP: {
    [address: string]: {
        coinId: string,
        decimals: number
    }
} = {
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": {
        coinId: "usd-coin",
        decimals: 6
    },
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": {
        coinId: "tether",
        decimals: 6
    },
    "So11111111111111111111111111111111111111112": {
        coinId: "solana",
        decimals: 9
    },
    "Ag6gw668H9PLQFyP482whvGDoAseBWfgs5AfXCAK3aMj": {
        coinId: "wrapped-bitcoin",
        decimals: 8
    }
};

class CoinGeckoSwapPrice extends ISwapPrice {

    url: string;

    constructor(maxAllowedFeeDiffPPM: BN, url?: string) {
        super(maxAllowedFeeDiffPPM);
        this.url = url || "https://api.coingecko.com/api/v3";
    }

    /**
     * Returns coin price in mSat
     *
     * @param coinId
     */
    async getPrice(coinId: string): Promise<BN> {

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

        return new BN(amt*1000);

    }

    async getFromBtcSwapAmount(fromAmount: BN, toToken: TokenAddress): Promise<BN> {
        let tokenAddress: string;
        if(toToken instanceof PublicKey) {
            tokenAddress = toToken.toBase58();
        } else {
            tokenAddress = toToken.toString();
        }

        const coin = COINS_MAP[tokenAddress];

        if(coin==null) throw new Error("Token not found");

        const price = await this.getPrice(coin.coinId);

        console.log("Swap price: ", price.toString(10));

        return fromAmount
            .mul(new BN(10).pow(new BN(coin.decimals)))
            .mul(new BN(1000)) //To msat
            .div(price)
    }

    async getToBtcSwapAmount(fromAmount: BN, fromToken: TokenAddress): Promise<BN> {
        let tokenAddress: string;
        if(fromToken instanceof PublicKey) {
            tokenAddress = fromToken.toBase58();
        } else {
            tokenAddress = fromToken.toString();
        }

        const coin = COINS_MAP[tokenAddress];

        if(coin==null) throw new Error("Token not found");

        const price = await this.getPrice(coin.coinId);

        return fromAmount
            .mul(price)
            .div(new BN(1000))
            .div(new BN(10).pow(new BN(coin.decimals)));
    }

}

export default CoinGeckoSwapPrice;