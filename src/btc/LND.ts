import {AuthenticatedLnd, authenticatedLndGrpc, UnauthenticatedLnd, unauthenticatedLndGrpc} from "lightning";
import {IntermediaryConfig} from "../IntermediaryConfig";
import * as fs from "fs";
import * as bip39 from "bip39";
import {CipherSeed} from "aezeed";

import * as ecc from "tiny-secp256k1";
import {BIP32Factory} from "bip32";
import { randomBytes } from "crypto";

const bip32 = BIP32Factory(ecc);

export function getAuthenticatedLndDetails(): {
    cert: string,
    macaroon: string,
    socket: string
} {
    let cert: string = IntermediaryConfig.LND.CERT;
    if(IntermediaryConfig.LND.CERT_FILE!=null) {
        if(!fs.existsSync(IntermediaryConfig.LND.CERT_FILE)) throw new Error("Certificate file not found!");
        cert = fs.readFileSync(IntermediaryConfig.LND.CERT_FILE).toString("base64");
    }

    let macaroon: string = IntermediaryConfig.LND.MACAROON;
    if(IntermediaryConfig.LND.MACAROON_FILE!=null) {
        if(!fs.existsSync(IntermediaryConfig.LND.MACAROON_FILE)) throw new Error("Macaroon file not found!");
        macaroon = fs.readFileSync(IntermediaryConfig.LND.MACAROON_FILE).toString("base64");
    }

    return {
        cert,
        macaroon,
        socket: IntermediaryConfig.LND.HOST+':'+IntermediaryConfig.LND.PORT,
    };
}

export function getAuthenticatedLndGrpc(): AuthenticatedLnd {
    const {lnd: LND} = authenticatedLndGrpc(getAuthenticatedLndDetails());
    return LND;
}

export function getUnauthenticatedLndGrpc(): UnauthenticatedLnd {
    let cert: string = IntermediaryConfig.LND.CERT;
    if(IntermediaryConfig.LND.CERT_FILE!=null) {
        if(!fs.existsSync(IntermediaryConfig.LND.CERT_FILE)) throw new Error("Certificate file not found!");
        cert = fs.readFileSync(IntermediaryConfig.LND.CERT_FILE).toString("base64");
    }

    const {lnd: UnauthenticatedLND} = unauthenticatedLndGrpc({
        cert,
        socket: IntermediaryConfig.LND.HOST+':'+IntermediaryConfig.LND.PORT,
    });

    return UnauthenticatedLND;
}

let entropy: Buffer;
if(IntermediaryConfig.LND.MNEMONIC_FILE!=null) {
    const mnemonic: string = fs.readFileSync(IntermediaryConfig.LND.MNEMONIC_FILE).toString();
    try {
        entropy = Buffer.from(bip39.mnemonicToEntropy(mnemonic), "hex");
    } catch (e) {
        throw new Error("Error parsing mnemonic phrase!");
    }
    const aezeedMnemonicFile = IntermediaryConfig.LND.MNEMONIC_FILE+".lnd";
    if(!fs.existsSync(aezeedMnemonicFile)) {
        const cipherSeed = new CipherSeed(entropy, randomBytes(5));
        fs.writeFileSync(aezeedMnemonicFile, cipherSeed.toMnemonic());
    }
}

export const LND_MNEMONIC_FILE = IntermediaryConfig.LND.MNEMONIC_FILE==null ? null : IntermediaryConfig.LND.MNEMONIC_FILE+".lnd";

export function getP2wpkhPubkey(): Buffer {
    if(entropy==null) return null;
    const node = bip32.fromSeed(entropy);
    return node.derivePath("m/84'/0'/0'/0/0").publicKey;
}
