import {AnchorProvider, BorshCoder, EventParser, Program} from "@coral-xyz/anchor";
import {PublicKey, Signer, TransactionInstruction} from "@solana/web3.js";
import {programIdl} from "./programIdl";

const HEADER_SEED = "header";
const BTC_RELAY_STATE_SEED = "state";

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

class SolanaBtcRelay {

    readonly program: Program;
    readonly coder: BorshCoder;
    readonly eventParser: EventParser;

    readonly signer: AnchorProvider;

    readonly BtcRelayMainState: PublicKey;
    readonly BtcRelayHeader: (hash: Buffer) => PublicKey = (hash: Buffer) => PublicKey.findProgramAddressSync(
        [Buffer.from(HEADER_SEED), hash],
        this.program.programId
    )[0];

    constructor(signer: AnchorProvider) {
        this.signer = signer;
        this.coder = new BorshCoder(programIdl as any);
        this.program = new Program(programIdl as any, programIdl.metadata.address, signer);
        this.eventParser = new EventParser(this.program.programId, this.coder);

        this.BtcRelayMainState = PublicKey.findProgramAddressSync(
            [Buffer.from(BTC_RELAY_STATE_SEED)],
            this.program.programId
        )[0];
    }

    async retrieveBlockLog(blockhash: string, requiredBlockheight: number): Promise<StoredHeader> {
        //Retrieve the log
        let storedHeader: any = null;

        let lastSignature = null;

        const mainState: any = await this.program.account.mainState.fetch(this.BtcRelayMainState);

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
        const topicKey = this.BtcRelayHeader(blockHashBuffer);

        while(storedHeader==null) {
            let fetched;
            if(lastSignature==null) {
                fetched = await this.signer.connection.getSignaturesForAddress(topicKey, {
                    limit: LOG_FETCH_LIMIT
                }, "confirmed");
            } else {
                fetched = await this.signer.connection.getSignaturesForAddress(topicKey, {
                    before: lastSignature,
                    limit: LOG_FETCH_LIMIT
                }, "confirmed");
            }
            if(fetched.length===0) throw new Error("Block cannot be fetched");
            lastSignature = fetched[fetched.length-1].signature;
            for(let data of fetched) {
                const tx = await this.signer.connection.getTransaction(data.signature, {
                    commitment: "confirmed"
                });
                if(tx.meta.err) continue;

                const events = this.eventParser.parseLogs(tx.meta.logMessages);

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

    createVerifyIx(signer: Signer, reversedTxId: Buffer, confirmations: number, position: number, reversedMerkleProof: Buffer[], committedHeader: StoredHeader): Promise<TransactionInstruction> {
        return this.program.methods
            .verifyTransaction(
                reversedTxId,
                confirmations,
                position,
                reversedMerkleProof,
                committedHeader
            )
            .accounts({
                signer: signer.publicKey,
                mainState: this.BtcRelayMainState
            })
            .signers([signer])
            .instruction();
    }

}

export default SolanaBtcRelay;
