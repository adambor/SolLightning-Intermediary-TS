import {createHash} from "crypto";
import BtcRPC from "../btc/BtcRPC";

export default class BTCMerkleTree {

    static dblSha256(buffer: Buffer): Buffer {
        return createHash("sha256").update(
            createHash("sha256").update(buffer).digest()
        ).digest()
    }

    static calcTreeWidth(height: number, nTxs: number): number {
        return (nTxs+(1 << height)-1) >> height;
    }

    static computePartialHash(height: number, pos: number, txIds: Buffer[]): Buffer {

        if(height===0) {
            return txIds[pos];
        } else {
            const left = BTCMerkleTree.computePartialHash(height-1, pos*2, txIds);
            let right;
            if(pos*2+1 < BTCMerkleTree.calcTreeWidth(height-1, txIds.length)) {
                right = BTCMerkleTree.computePartialHash(height-1, pos*2+1, txIds);
            } else {
                right = left;
            }

            return BTCMerkleTree.dblSha256(Buffer.concat([
                left, right
            ]));
        }

    }

    static async getTransactionMerkle(txId: string, blockhash: string): Promise<{
        reversedTxId: Buffer,
        pos: number,
        merkle: Buffer[],
        blockheight: number
    }> {
        const block = await new Promise<any>((resolve, reject) => {
            BtcRPC.getBlock(blockhash, 1, (err, res) => {
                if(err || res.error) {
                    reject(err || res.error);
                    return;
                }
                resolve(res.result);
            })
        });

        console.log(block);

        const position = block.tx.indexOf(txId);
        const txIds = block.tx.map(e => Buffer.from(e, "hex").reverse());

        const reversedMerkleRoot = Buffer.from(block.merkleroot, "hex").reverse();

        const proof = [];
        let n = position;
        while(true) {
            if(n%2===0) {
                //Left
                const treeWidth = BTCMerkleTree.calcTreeWidth(proof.length, txIds.length);
                if(treeWidth===1) {
                    break;
                } else if(treeWidth<=n+1) {
                    proof.push(BTCMerkleTree.computePartialHash(proof.length, n, txIds));
                } else {
                    proof.push(BTCMerkleTree.computePartialHash(proof.length, n+1, txIds));
                }
            } else {
                //Right
                proof.push(BTCMerkleTree.computePartialHash(proof.length, n-1, txIds));
            }
            n = Math.floor(n/2);
        }

        const blockHeight = block.height;

        return {
            reversedTxId: Buffer.from(txId, "hex").reverse(),
            pos: position,
            merkle: proof,
            blockheight: blockHeight
        }

    }
}