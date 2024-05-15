import * as BN from "bn.js";
import {
    bnParser,
    booleanParser, decimalToBNParser,
    dictionaryParserWithKeys,
    enumParser,
    numberParser,
    objectParser,
    parseConfig, percentageToPpmParser,
    stringParser,
    dictionaryParser,
    ConfigParser
} from "crosslightning-server-base";
import * as fs from "fs";
import {parse} from "yaml";
import {PublicKey} from "@solana/web3.js";

export const publicKeyParser: (optional?: boolean) => ConfigParser<PublicKey> = (optional?: boolean) => (data: any) => {
    if(data==null) {
        if(optional) {
            return null;
        } else {
            throw new Error("Data is null");
        }
    }
    if(typeof(data)!=="string") throw new Error("Invalid data, must be string");
    return new PublicKey(data);
};

const IntermediaryConfigTemplate = {
    SOLANA: objectParser({
        RPC_URL: stringParser(),
        MAX_FEE_MICRO_LAMPORTS: numberParser(false, 1000),

        MNEMONIC_FILE: stringParser(null, null, true),
        PRIVKEY: stringParser(128, 128, true),
        ADDRESS: publicKeyParser(true),
        SECURITY_DEPOSIT_APY: percentageToPpmParser(0)
    }, (data) => {
        if(data.MNEMONIC_FILE==null && data.PRIVKEY==null) throw new Error("Mnemonic file or explicit private key must be specified!");
    }),

    BITCOIND: objectParser({
        PROTOCOL: enumParser(["http", "https"]),
        PORT: numberParser(false, 0, 65535),
        HOST: stringParser(),
        RPC_USERNAME: stringParser(),
        RPC_PASSWORD: stringParser(),
        NETWORK: enumParser(["mainnet", "testnet"]),
    }),

    JITO: objectParser({
        PUBKEY: publicKeyParser(),
        ENDPOINT: stringParser(),
    }, null, true),

    STATIC_TIP: bnParser(new BN(0), null, true),

    LND: objectParser({
        MNEMONIC_FILE: stringParser(null, null, true),
        WALLET_PASSWORD_FILE: stringParser(null, null, true),
        CERT: stringParser(null, null, true),
        MACAROON: stringParser(null, null, true),
        CERT_FILE: stringParser(null, null, true),
        MACAROON_FILE: stringParser(null, null, true),
        HOST: stringParser(),
        PORT: numberParser(false, 0, 65535),
    }, (data) => {
        if(data.CERT==null && data.CERT_FILE==null) throw new Error("Certificate for LND not provided, provide either CERT or CERT_FILE config!");
        if(data.MACAROON==null && data.MACAROON_FILE==null) throw new Error("Certificate for LND not provided, provide either MACAROON or MACAROON_FILE config!");
    }),

    LN: objectParser({
        BASE_FEE: decimalToBNParser(8, 0),
        FEE_PERCENTAGE: percentageToPpmParser(0),
        MIN: decimalToBNParser(8, 0),
        MAX: decimalToBNParser(8, 0),

        ALLOW_NON_PROBABLE_SWAPS: booleanParser(),
        ALLOW_LN_SHORT_EXPIRY: booleanParser()
    }, null, true),

    ONCHAIN: objectParser({
        BASE_FEE: decimalToBNParser(8, 0),
        FEE_PERCENTAGE: percentageToPpmParser(0),
        MIN: decimalToBNParser(8, 0),
        MAX: decimalToBNParser(8, 0),

        NETWORK_FEE_ADD_PERCENTAGE: percentageToPpmParser(0)
    }, null, true),

    ASSETS: dictionaryParser(
        objectParser({
            address: publicKeyParser(),
            decimals: numberParser(false, 0),
            pricing: stringParser()
        })
    ),

    CLI: objectParser({
        ADDRESS: stringParser(),
        PORT: numberParser(false, 0, 65535)
    }),

    REST: objectParser({
        ADDRESS: stringParser(),
        PORT: numberParser(false, 0, 65535)
    }),

    SSL: objectParser({
        CERT_FILE: stringParser(),
        KEY_FILE: stringParser()
    }, null, true),

    SSL_AUTO: objectParser({
        IP_ADDRESS_FILE: stringParser(null, null, true),
        HTTP_LISTEN_PORT: numberParser(false, 0, 65535),
        DNS_PROXY: stringParser()
    }, null, true),

    PLUGINS: dictionaryParser(
        stringParser(),
        null,
        true
    )
};

export let IntermediaryConfig = parseConfig(parse(fs.readFileSync(process.env.CONFIG_FILE).toString()), IntermediaryConfigTemplate);
