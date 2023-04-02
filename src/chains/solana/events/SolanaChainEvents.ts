import ChainEvents, {EventListener} from "../../../events/ChainEvents";
import SolanaSwapData from "../swaps/SolanaSwapData";
import {Message, PublicKey} from "@solana/web3.js";
import {AnchorProvider, Event} from "@project-serum/anchor";
import {IdlEvent} from "@project-serum/anchor/dist/cjs/idl";
import * as fs from "fs/promises";
import SwapEvent from "../../../events/types/SwapEvent";
import ClaimEvent from "../../../events/types/ClaimEvent";
import RefundEvent from "../../../events/types/RefundEvent";
import InitializeEvent from "../../../events/types/InitializeEvent";
import SolanaSwapProgram from "../swaps/SolanaSwapProgram";
import {programIdl} from "../swaps/programIdl";


const BLOCKHEIGHT_FILENAME = "/blockheight.txt";
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

class SolanaChainEvents implements ChainEvents<SolanaSwapData> {

    private decodeInstructions(transactionMessage: Message): IxWithAccounts[] {

        const instructions: IxWithAccounts[] = [];

        for(let ix of transactionMessage.instructions) {
            if(transactionMessage.accountKeys[ix.programIdIndex].equals(this.solanaSwapProgram.program.programId)) {
                const parsedIx: any = this.solanaSwapProgram.coder.instruction.decode(ix.data, 'base58');
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

    private readonly listeners: EventListener<SolanaSwapData>[] = [];
    private readonly directory: string;
    private readonly signer: AnchorProvider;
    private readonly solanaSwapProgram: SolanaSwapProgram;

    constructor(directory: string, signer: AnchorProvider, solanaSwapProgram: SolanaSwapProgram) {
        this.directory = directory;
        this.signer = signer;
        this.solanaSwapProgram = solanaSwapProgram;
    }

    private async getLastSignature() {
        try {
            const txt = await fs.readFile(this.directory+BLOCKHEIGHT_FILENAME);
            return txt.toString();
        } catch (e) {
            return null;
        }
    }

    private saveLastSignature(lastSignture: string): Promise<void> {
        return fs.writeFile(this.directory+BLOCKHEIGHT_FILENAME, lastSignture);
    }

    private async processEvent(eventObject : EventObject) {
        let parsedEvents: SwapEvent<SolanaSwapData>[] = [];

        const initEvents = {};

        for(let event of eventObject.events) {
            if(event==null) continue;
            if(event.name==="ClaimEvent") {
                const secret: Buffer = Buffer.from(event.data.secret);
                const paymentHash: Buffer = Buffer.from(event.data.hash);

                parsedEvents.push(new ClaimEvent<SolanaSwapData>(paymentHash.toString("hex"), secret.toString("hex")));
            }
            if(event.name==="RefundEvent") {
                const paymentHash: Buffer = Buffer.from(event.data.hash);
                parsedEvents.push(new RefundEvent<SolanaSwapData>(paymentHash.toString("hex")));
            }
            if(event.name==="InitializeEvent") {
                const paymentHash: Buffer = Buffer.from(event.data.hash);
                initEvents[paymentHash.toString("hex")] = event;
            }
        }

        for(let ix of eventObject.instructions) {
            if (ix == null) continue;

            if (
                (ix.name === "offererInitializePayIn" || ix.name === "offererInitialize")
            ) {
                const paymentHash: Buffer = Buffer.from(ix.data.hash);

                const associatedEvent = initEvents[paymentHash.toString("hex")];

                if(associatedEvent==null) continue;

                const txoHash: Buffer = Buffer.from(associatedEvent.data.txoHash);

                let offerer: PublicKey;
                let payIn: boolean;
                if(ix.name === "offererInitializePayIn") {
                    offerer = ix.accounts.initializer;
                    payIn = true;
                } else {
                    offerer = ix.accounts.offerer;
                    payIn = false;
                }

                const swapData: SolanaSwapData = new SolanaSwapData(
                    ix.accounts.initializer,
                    offerer,
                    ix.accounts.claimer,
                    ix.accounts.mint,
                    ix.data.initializerAmount,
                    paymentHash.toString("hex"),
                    ix.data.expiry,
                    ix.data.escrowNonce,
                    ix.data.confirmations,
                    ix.data.payOut,
                    ix.data.kind,
                    payIn,
                    ix.accounts.claimerTokenAccount
                );

                const usedNonce = ix.data.nonce.toNumber();

                parsedEvents.push(new InitializeEvent<SolanaSwapData>(
                    paymentHash.toString("hex"),
                    txoHash.toString("hex"),
                    usedNonce,
                    swapData
                ));
            }
        }

        for(let listener of this.listeners) {
            await listener(parsedEvents);
        }
    }

    private async checkEvents() {
        const lastSignature = await this.getLastSignature();

        let signatures = null;

        if(lastSignature==null) {
            signatures = await this.signer.connection.getSignaturesForAddress(this.solanaSwapProgram.program.programId, {
                limit: 1
            }, "confirmed");
            if(signatures.length>0) {
                await this.saveLastSignature(signatures[0].signature);
            }
            return;
        }

        let fetched = null;
        while(fetched==null || fetched.length===LOG_FETCH_LIMIT) {
            if(signatures==null) {
                fetched = await this.signer.connection.getSignaturesForAddress(this.solanaSwapProgram.program.programId, {
                    until: lastSignature,
                    limit: LOG_FETCH_LIMIT
                }, "confirmed");
            } else {
                fetched = await this.signer.connection.getSignaturesForAddress(this.solanaSwapProgram.program.programId, {
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
            const transaction = await this.signer.connection.getTransaction(signatures[i].signature, {
                commitment: "confirmed"
            });
            if(transaction.meta.err==null) {
                //console.log("Process tx: ", transaction.transaction);
                //console.log("Decoded ix: ", decodeInstructions(transaction.transaction.message));
                const instructions = this.decodeInstructions(transaction.transaction.message);
                const parsedEvents = this.solanaSwapProgram.eventParser.parseLogs(transaction.meta.logMessages);

                const events = [];
                for(let event of parsedEvents) {
                    events.push(event);
                }

                console.log("Instructions: ", instructions);
                console.log("Events: ", events);

                await this.processEvent({
                    events,
                    instructions
                });
            }
        }

        if(signatures.length>0) {
            await this.saveLastSignature(signatures[0].signature);
        }
    }

    async init(): Promise<void> {
        try {
            await fs.mkdir(this.directory);
        } catch (e) {}

        let func;
        func = async () => {
            await this.checkEvents().catch(e => {
                console.error("Failed to fetch Sol log");
                console.error(e);
            });
            setTimeout(func, LOG_FETCH_INTERVAL);
        };
        await func();
    }

    registerListener(cbk: EventListener<SolanaSwapData>) {
        this.listeners.push(cbk);
    }

    unregisterListener(cbk: EventListener<SolanaSwapData>): boolean {
        const index = this.listeners.indexOf(cbk);
        if(index>=0) {
            this.listeners.splice(index, 1);
            return true;
        }
        return false;
    }
}

export default SolanaChainEvents;