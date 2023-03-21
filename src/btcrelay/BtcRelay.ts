import BTCRelayProgram, {
    BtcRelayHeader,
    BtcRelayMainState,
    btcRelayProgramEventParser
} from "./program/BTCRelayProgram";
import AnchorSigner from "../sol/AnchorSigner";
import {Store} from "tough-cookie";
import {Signer, TransactionInstruction} from "@solana/web3.js";
import {Instruction} from "@project-serum/anchor";

const LOG_FETCH_LIMIT = 500;

type Header = {
    version: number,
    reversedPrevBlockhash: number[],
    merkleRoot: number[],
    timestamp: number,
    nbits: number,
    nonce: number
}

type StoredHeader = {
    chainWork: number[],
    header: Header,
    lastDiffAdjustment: number,
    blockheight: number,
    prevBlockTimestamps: number[]
}

class BtcRelay {

    static async retrieveBlockLog(blockhash: string, requiredBlockheight: number): Promise<StoredHeader> {
        //Retrieve the log
        let storedHeader: any = null;

        let lastSignature = null;

        const mainState: any = await BTCRelayProgram.account.mainState.fetch(BtcRelayMainState);

        if(mainState.blockHeight < requiredBlockheight) {
            //Btc relay not synchronized to required blockheight
            console.log("not synchronized to required blockheight");
            return null;
        }

        const storedCommitments = new Set();
        mainState.blockCommitments.forEach(e => {
            storedCommitments.add(Buffer.from(e).toString("hex"));
        });

        const blockHashBuffer = Buffer.from(blockhash, 'hex').reverse();
        const topicKey = BtcRelayHeader(blockHashBuffer);

        while(storedHeader==null) {
            let fetched;
            if(lastSignature==null) {
                fetched = await AnchorSigner.connection.getSignaturesForAddress(topicKey, {
                    limit: LOG_FETCH_LIMIT
                }, "confirmed");
            } else {
                fetched = await AnchorSigner.connection.getSignaturesForAddress(topicKey, {
                    before: lastSignature,
                    limit: LOG_FETCH_LIMIT
                }, "confirmed");
            }
            if(fetched.length===0) throw new Error("Block cannot be fetched");
            lastSignature = fetched[fetched.length-1].signature;
            for(let data of fetched) {
                const tx = await AnchorSigner.connection.getTransaction(data.signature, {
                    commitment: "confirmed"
                });
                if(tx.meta.err) continue;

                const events = btcRelayProgramEventParser.parseLogs(tx.meta.logMessages);

                for(let log of events) {
                    if(log.name==="StoreFork" || log.name==="StoreHeader") {
                        const logData: any = log.data;
                        if(blockHashBuffer.equals(Buffer.from(logData.blockHash))) {
                            const commitHash = Buffer.from(logData.commitHash).toString("hex");
                            if(storedCommitments.has(commitHash)) {
                                storedHeader = log.data.header;
                                break;
                            }
                        }
                    }
                }

                if(storedHeader!=null) break;
            }
        }

        return storedHeader;
    }

    static createVerifyIx(signer: Signer, reversedTxId: Buffer, confirmations: number, position: number, reversedMerkleProof: Buffer[], committedHeader: StoredHeader): Promise<TransactionInstruction> {
        return BTCRelayProgram.methods
            .verifyTransaction(
                reversedTxId,
                confirmations,
                position,
                reversedMerkleProof,
                committedHeader
            )
            .accounts({
                signer: signer.publicKey,
                mainState: BtcRelayMainState
            })
            .signers([signer])
            .instruction();
    }

}

export default BtcRelay;