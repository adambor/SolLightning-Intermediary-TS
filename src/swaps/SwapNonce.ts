import * as fs from "fs/promises";

const NONCE_FILENAME = "/nonce.txt";
const CLAIM_NONCE_FILENAME = "/claimNonce.txt";

class SwapNonce {

    private nonce: number;
    private claimNonce: number;

    private readonly directory: string;

    constructor(directory: string) {
        this.directory = directory;
    }

    async init() {
        try {
            await fs.mkdir(this.directory);
        } catch (e) {}

        try {
            const txt = await fs.readFile(this.directory+NONCE_FILENAME);
            this.nonce = parseInt(txt.toString());
        } catch (e) {
            this.nonce = 0;
        }

        try {
            const txt = await fs.readFile(this.directory+CLAIM_NONCE_FILENAME);
            this.claimNonce = parseInt(txt.toString());
        } catch (e) {
            this.claimNonce = 0;
        }
    }

    async saveNonce(_nonce) {
        this.nonce = _nonce;
        await fs.writeFile(this.directory+NONCE_FILENAME, ""+_nonce);
    }

    async saveClaimNonce(_nonce) {
        this.claimNonce = _nonce;
        await fs.writeFile(this.directory+CLAIM_NONCE_FILENAME, ""+_nonce);
    }

    getNonce(): number {
        return this.nonce;
    }

    getClaimNonce(): number {
        return this.claimNonce;
    }

}

export default SwapNonce;