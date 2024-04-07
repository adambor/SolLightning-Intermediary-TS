import {SolanaSwapProgram} from "crosslightning-solana";
import {SystemProgram, PublicKey, ComputeBudgetProgram, TransactionInstruction, SendOptions, Transaction, SystemInstruction} from "@solana/web3.js";

const jitoPubkey = new PublicKey(
    "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL"
);

const jitoEndpoint = "https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/transactions";

export class Jito {

    static applyJito(swapProgram: SolanaSwapProgram) {

        swapProgram.onBeforeTxSigned((tx) => {
            if(tx.tx.signatures.length===0) {
                const unitLimitIxIndex = tx.tx.instructions.findIndex(ix => ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0]===0x02);
                const unitLimitIx: TransactionInstruction = unitLimitIxIndex==-1 ? null : tx.tx.instructions[unitLimitIxIndex];
                // console.log("Unit limit IX: ", unitLimitIx?.data);
                const unitLimit: number = unitLimitIx==null ? 200000 : unitLimitIx.data.readUint32LE(1);

                const unitPriceIxIndex = tx.tx.instructions.findIndex(ix => ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0]===0x03);
                const unitPriceIx: TransactionInstruction = unitPriceIxIndex==-1 ? null : tx.tx.instructions[unitPriceIxIndex];
                // console.log("Unit price IX: ", unitPriceIx?.data);
                const unitPrice: bigint = unitPriceIx==null ? BigInt(8000) : unitPriceIx.data.readBigUint64LE(1);
                if(unitPriceIxIndex!=-1) tx.tx.instructions.splice(unitPriceIxIndex, 1);

                //Apply Jito to it
                tx.tx.add(SystemProgram.transfer({
                    fromPubkey: tx.tx.feePayer,
                    toPubkey: jitoPubkey,
                    lamports: (BigInt(unitLimit)*unitPrice)/BigInt(1000000), // Enter your tip amount here
                }));
            }
            return Promise.resolve();
        });

        swapProgram.onSendTransaction(async (tx: Buffer, options?: SendOptions) => {

            const parsedTx = Transaction.from(tx);
            const lastIx = parsedTx.instructions[parsedTx.instructions.length-1];
            if(!lastIx.programId.equals(SystemProgram.programId)) {
                return null;
            }

            if(SystemInstruction.decodeInstructionType(lastIx)!=="Transfer") {
                return null;
            }

            const decodedIxData = SystemInstruction.decodeTransfer(lastIx);
            if(!decodedIxData.toPubkey.equals(jitoPubkey)) {
                return null;
            }

            console.log("Send Jito tx, fee: ", decodedIxData.lamports);

            if(options==null) options = {};

            //Is Jito tx
            const request = await fetch(jitoEndpoint, {
                method: "POST",
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    id: 1,
                    method: "sendTransaction",
                    params: [tx.toString("base64"), {
                        ...options,
                        encoding: "base64"
                    }],
                }),
                headers: {
                    "Content-Type": "application/json"
                }
            });

            if(request.ok) {
                const parsedResponse = await request.json();
                // console.log(parsedResponse);
                return parsedResponse.result;
            }

            throw new Error(await request.text());

        });

    }

}