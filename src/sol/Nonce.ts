import * as fs from "fs/promises";

const NONCE_FILENAME = "./storage/nonce.txt";

class Nonce {

    private static nonce: number;

    static async init() {
        try {
            const txt = await fs.readFile(NONCE_FILENAME);
            Nonce.nonce = parseInt(txt.toString());
        } catch (e) {
            Nonce.nonce = 0;
        }
    }

    static async saveNonce(_nonce) {
        Nonce.nonce = _nonce;
        await fs.writeFile(NONCE_FILENAME, ""+_nonce);
    }

    static getNonce(): number {
        return Nonce.nonce;
    }

}

export default Nonce;