import {programIdl} from "./program/programIdl";
import SwapProgram, {swapProgramCoder, swapProgramEvetnParser} from "./program/SwapProgram";
import {Message, PublicKey} from "@solana/web3.js";
import {Event, Instruction} from "@project-serum/anchor";
import * as fs from "fs/promises";
import AnchorSigner from "./AnchorSigner";
import {IdlEvent} from "@project-serum/anchor/dist/cjs/idl";

const BLOCKHEIGHT_FILENAME = "./storage/blockheight.txt";
const LOG_FETCH_INTERVAL = 5*1000;
const LOG_FETCH_LIMIT = 500;

const nameMappedInstructions = {};
for(let ix of programIdl.instructions) {
    nameMappedInstructions[ix.name] = ix;
}

export type IxWithAccounts = ({name: string, data: any, accounts: {[key: string]: PublicKey}});
export type EventObject = {
    events: Event<IdlEvent, Record<string, any>>[],
    instructions: IxWithAccounts[]
};
export type EventListener = (obj: EventObject) => Promise<boolean>;

const listeners: EventListener[] = [];

export default class SolEvents {
    private static decodeInstructions(transactionMessage: Message): IxWithAccounts[] {

        const instructions: IxWithAccounts[] = [];

        for(let ix of transactionMessage.instructions) {
            if(transactionMessage.accountKeys[ix.programIdIndex].equals(SwapProgram.programId)) {
                const parsedIx: any = swapProgramCoder.instruction.decode(ix.data, 'base58');
                const accountsData = nameMappedInstructions[parsedIx.name];
                if(accountsData!=null && accountsData.accounts!=null) {
                    parsedIx.accounts = {};
                    for(let i=0;i<accountsData.accounts.length;i++) {
                        parsedIx.accounts[accountsData.accounts[i].name] = transactionMessage.accountKeys[ix.accounts[i]]
                    }
                }
                instructions.push(parsedIx);
            } else {
                instructions.push(null);
            }
        }

        return instructions;

    }

    private static async getLastSignature() {
        try {
            const txt = await fs.readFile(BLOCKHEIGHT_FILENAME);
            return txt.toString();
        } catch (e) {
            return null;
        }
    }

    private static saveLastSignature(lastSignture: string): Promise<void> {
        return fs.writeFile(BLOCKHEIGHT_FILENAME, lastSignture);
    }

    private static async processEvent(event : EventObject) {
        for(let listener of listeners) {
            await listener(event);
        }
    }

    private static async checkEvents() {
        const lastSignature = await SolEvents.getLastSignature();

        let signatures = null;

        if(lastSignature==null) {
            signatures = await AnchorSigner.connection.getSignaturesForAddress(SwapProgram.programId, {
                limit: 1
            }, "confirmed");
            if(signatures.length>0) {
                await SolEvents.saveLastSignature(signatures[0].signature);
            }
            return;
        }

        let fetched = null;
        while(fetched==null || fetched.length===LOG_FETCH_LIMIT) {
            if(signatures==null) {
                fetched = await AnchorSigner.connection.getSignaturesForAddress(SwapProgram.programId, {
                    until: lastSignature,
                    limit: LOG_FETCH_LIMIT
                }, "confirmed");
            } else {
                fetched = await AnchorSigner.connection.getSignaturesForAddress(SwapProgram.programId, {
                    before: signatures[signatures.length-1].signature,
                    until: lastSignature,
                    limit: LOG_FETCH_LIMIT
                }, "confirmed");
            }
            if(signatures==null) {
                signatures = fetched;
            } else {
                fetched.forEach(e => signatures.push(e));
            }
        }

        for(let i=signatures.length-1;i>=0;i--) {
            console.log("Process signature: ", signatures[i].signature);
            const transaction = await AnchorSigner.connection.getTransaction(signatures[i].signature, {
                commitment: "confirmed"
            });
            if(transaction.meta.err==null) {
                //console.log("Process tx: ", transaction.transaction);
                //console.log("Decoded ix: ", decodeInstructions(transaction.transaction.message));
                const instructions = SolEvents.decodeInstructions(transaction.transaction.message);
                const parsedEvents = swapProgramEvetnParser.parseLogs(transaction.meta.logMessages);

                const events = [];
                for(let event of parsedEvents) {
                    events.push(event);
                }

                console.log("Instructions: ", instructions);
                console.log("Events: ", events);

                await SolEvents.processEvent({
                    events,
                    instructions
                });
            }
        }

        if(signatures.length>0) {
            await SolEvents.saveLastSignature(signatures[0].signature);
        }
    }

    static init() {
        return new Promise<void>((resolve, reject) => {
            SolEvents.checkEvents().then(() => {
                resolve();
                setInterval(SolEvents.checkEvents, LOG_FETCH_INTERVAL);
            });
        });
    }

    static registerListener(cbk: EventListener) {
        listeners.push(cbk);
    }

    static unregisterListener(cbk: EventListener): boolean {
        const index = listeners.indexOf(cbk);
        if(index>=0) {
            listeners.splice(index, 1);
            return true;
        }
        return false;
    }

}
