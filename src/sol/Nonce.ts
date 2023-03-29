import * as fs from "fs/promises";

const NONCE_FILENAME = "./storage/nonce.txt";
const CLAIM_NONCE_FILENAME = "./storage/claimNonce.txt";

class Nonce {

    private static nonce: number;
    private static claimNonce: number;

    static async init() {
        try {
            const txt = await fs.readFile(NONCE_FILENAME);
            Nonce.nonce = parseInt(txt.toString());
        } catch (e) {
            Nonce.nonce = 0;
        }

        try {
            const txt = await fs.readFile(CLAIM_NONCE_FILENAME);
            Nonce.claimNonce = parseInt(txt.toString());
        } catch (e) {
            Nonce.claimNonce = 0;
        }
    }

    static async saveNonce(_nonce) {
        Nonce.nonce = _nonce;
        await fs.writeFile(NONCE_FILENAME, ""+_nonce);
    }

    static async saveClaimNonce(_nonce) {
        Nonce.claimNonce = _nonce;
        await fs.writeFile(CLAIM_NONCE_FILENAME, ""+_nonce);
    }

    static getNonce(): number {
        return Nonce.nonce;
    }

    static getClaimNonce(): number {
        return Nonce.claimNonce;
    }

}

export default Nonce;