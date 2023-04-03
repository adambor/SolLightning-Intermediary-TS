import SwapContract from "../../../swaps/SwapContract";
import SolanaSwapData from "./SolanaSwapData";
import {AnchorProvider, BorshCoder, EventParser, Program} from "@project-serum/anchor";
import SwapType from "../../../swaps/SwapType";
import {TokenAddress} from "../../../swaps/TokenAddress";
import * as BN from "bn.js";
import SwapNonce from "../../../swaps/SwapNonce";
import {Keypair, PublicKey, Signer, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, Transaction} from "@solana/web3.js";
import {
    AUTHORIZATION_TIMEOUT
} from "../../../Constants";
import {createHash} from "crypto";
import {sign} from "tweetnacl";
import {getAssociatedTokenAddressSync} from "@solana/spl-token";
import BtcRPC from "../../../btc/BtcRPC";
import BTCMerkleTree from "../../../btcrelay/BTCMerkleTree";
import * as bitcoin from "bitcoinjs-lib";
import SolanaBtcRelay from "../btcrelay/SolanaBtcRelay";
import {programIdl} from "./programIdl";
import * as fs from "fs/promises";

const STATE_SEED = "state";
const VAULT_SEED = "vault";
const USER_VAULT_SEED = "uservault";
const AUTHORITY_SEED = "authority";
const TX_DATA_SEED = "data";

class SolanaSwapProgram implements SwapContract<SolanaSwapData> {

    claimWithSecretTimeout: number = 45;
    claimWithTxDataTimeout: number = 120;
    refundTimeout: number = 45;

    readonly storageDirectory: string;

    private readonly signer: AnchorProvider & {signer: Signer};
    readonly program: Program;
    readonly coder: BorshCoder;
    readonly eventParser: EventParser;

    readonly btcRelay: SolanaBtcRelay;

    readonly SwapVaultAuthority: PublicKey;
    readonly SwapVault: (tokenAddress: PublicKey) => PublicKey = (tokenAddress: PublicKey) => PublicKey.findProgramAddressSync(
        [Buffer.from(VAULT_SEED), tokenAddress.toBuffer()],
        this.program.programId
    )[0];

    readonly SwapUserVault: (publicKey: PublicKey, tokenAddress: PublicKey) => PublicKey = (publicKey: PublicKey, tokenAddress: PublicKey) => PublicKey.findProgramAddressSync(
        [Buffer.from(USER_VAULT_SEED), publicKey.toBuffer(), tokenAddress.toBuffer()],
        this.program.programId
    )[0];

    readonly SwapEscrowState: (hash: Buffer) => PublicKey = (hash: Buffer) => PublicKey.findProgramAddressSync(
        [Buffer.from(STATE_SEED), hash],
        this.program.programId
    )[0];

    readonly SwapTxData: (reversedTxId: Buffer, pubkey: PublicKey) => PublicKey = (reversedTxId: Buffer, pubkey: PublicKey) => PublicKey.findProgramAddressSync(
        [Buffer.from(TX_DATA_SEED), reversedTxId, pubkey.toBuffer()],
        this.program.programId
    )[0];

    readonly SwapTxDataAlt: (reversedTxId: Buffer, signer: Signer) => Signer = (reversedTxId: Buffer, signer: Signer) => {
        const buff = createHash("sha256").update(Buffer.concat([signer.secretKey, reversedTxId])).digest();
        return Keypair.fromSeed(buff);
    };

    constructor(signer: AnchorProvider & {signer: Signer}, btcRelay: SolanaBtcRelay, storageDirectory: string) {
        this.signer = signer;
        this.program = new Program(programIdl as any, programIdl.metadata.address, signer);
        this.coder = new BorshCoder(programIdl as any);
        this.eventParser = new EventParser(this.program.programId, this.coder);

        this.btcRelay = btcRelay;

        this.storageDirectory = storageDirectory;

        this.SwapVaultAuthority = PublicKey.findProgramAddressSync(
            [Buffer.from(AUTHORITY_SEED)],
            this.program.programId
        )[0];
    }

    async init(): Promise<void> {
        try {
            await fs.mkdir(this.storageDirectory);
        } catch (e) {}

        let files;
        try {
            files = await fs.readdir(this.storageDirectory);
        } catch (e) {
            console.error(e);
        }

        console.log("[To BTC: Solana.GC] Running GC on previously initialized data account");

        for(let file of files) {
            const result = await fs.readFile(this.storageDirectory+"/"+file);
            const obj = JSON.parse(result.toString());

            const publicKey = new PublicKey(obj.publicKey);

            try {
                const fetchedDataAccount: any = await this.signer.connection.getAccountInfo(publicKey);
                if(fetchedDataAccount!=null) {
                    console.log("[To BTC: Solana.GC] Will erase previous data account");
                    const eraseTx = await this.program.methods
                        .closeData()
                        .accounts({
                            signer: this.signer.publicKey,
                            data: publicKey
                        })
                        .signers([this.signer.signer])
                        .transaction();

                    const signature = await this.signer.sendAndConfirm(eraseTx, [this.signer.signer]);
                    console.log("[To BTC: Solana.GC] Previous data account erased: ", signature);
                }
                await this.removeDataAccount(publicKey);
            } catch (e) {}
        }
    }

    async saveDataAccount(publicKey: PublicKey) {
        await fs.writeFile(this.storageDirectory+"/"+publicKey.toBase58()+".json", JSON.stringify({
            publicKey: publicKey.toBase58()
        }));
    }

    async removeDataAccount(publicKey: PublicKey) {
        try {
            await fs.rm(this.storageDirectory+"/"+publicKey.toBase58()+".json");
        } catch (e) {}
    }

    areWeClaimer(swapData: SolanaSwapData): boolean {
        if(swapData.isPayOut()) {
            const ourAta = getAssociatedTokenAddressSync(swapData.token, swapData.intermediary);

            if(!swapData.claimerTokenAccount.equals(ourAta)) {
                //Invalid ATA specified as our ATA
                return false;
            }
        }
        return swapData.intermediary.equals(this.signer.publicKey);
    }

    areWeOfferer(swapData: SolanaSwapData): boolean {
        return swapData.offerer.equals(this.signer.publicKey);
    }

    async getBalance(token: TokenAddress): Promise<BN> {
        const tokenAccount: any = await this.program.account.userAccount.fetch(this.SwapUserVault(this.signer.publicKey, token));
        return new BN(tokenAccount.amount.toString(10));
    }

    getClaimInitSignature(swapData: SolanaSwapData, nonce: SwapNonce): Promise<{ nonce: number; prefix: string; timeout: string; signature: string }> {
        const authPrefix = "claim_initialize";
        const authTimeout = Math.floor(Date.now()/1000)+AUTHORIZATION_TIMEOUT;
        const useNonce = nonce.getClaimNonce()+1;

        const messageBuffers = [
            null,
            Buffer.alloc(8),
            null,
            Buffer.alloc(8),
            Buffer.alloc(8),
            null,
            Buffer.alloc(1),
            Buffer.alloc(2),
            Buffer.alloc(8)
        ];

        messageBuffers[0] = Buffer.from(authPrefix, "ascii");
        messageBuffers[1].writeBigUInt64LE(BigInt(useNonce));
        messageBuffers[2] = swapData.token.toBuffer();
        messageBuffers[3].writeBigUInt64LE(BigInt(swapData.amount.toString(10)));
        messageBuffers[4].writeBigUInt64LE(BigInt(swapData.expiry.toString(10)));
        messageBuffers[5] = Buffer.from(swapData.paymentHash, "hex");
        messageBuffers[6].writeUint8(swapData.kind || 0);
        messageBuffers[7].writeUint16LE(swapData.confirmations || 0);
        messageBuffers[8].writeBigUInt64LE(BigInt(authTimeout));

        if(swapData.payOut===true) {
            const ata = getAssociatedTokenAddressSync(swapData.token, swapData.intermediary);
            messageBuffers.push(Buffer.alloc(1, 1));
            messageBuffers.push(ata.toBuffer());
        } else {
            messageBuffers.push(Buffer.alloc(1, 0));
        }

        const messageBuffer = Buffer.concat(messageBuffers);
        const signature = sign.detached(messageBuffer, this.signer.signer.secretKey);

        return Promise.resolve({
            nonce: useNonce,
            prefix: authPrefix,
            timeout: authTimeout.toString(10),
            signature: Buffer.from(signature).toString("hex")
        });
    }

    getInitSignature(swapData: SolanaSwapData, nonce: SwapNonce): Promise<{ nonce: number; prefix: string; timeout: string; signature: string }> {
        const authPrefix = "initialize";
        const authTimeout = Math.floor(Date.now()/1000)+AUTHORIZATION_TIMEOUT;
        const useNonce = nonce.getNonce()+1;

        const messageBuffers = [
            null,
            Buffer.alloc(8),
            null,
            null,
            Buffer.alloc(8),
            Buffer.alloc(8),
            null,
            Buffer.alloc(1),
            Buffer.alloc(2),
            Buffer.alloc(8)
        ];

        messageBuffers[0] = Buffer.from(authPrefix, "ascii");
        messageBuffers[1].writeBigUInt64LE(BigInt(useNonce));
        messageBuffers[2] = swapData.token.toBuffer();
        messageBuffers[3] = swapData.intermediary.toBuffer();
        messageBuffers[4].writeBigUInt64LE(BigInt(swapData.amount.toString(10)));
        messageBuffers[5].writeBigUInt64LE(BigInt(swapData.expiry.toString(10)));
        messageBuffers[6] = Buffer.from(swapData.paymentHash, "hex");
        messageBuffers[7].writeUint8(swapData.kind || 0);
        messageBuffers[8].writeUint16LE(swapData.confirmations || 0);
        messageBuffers[9].writeBigUInt64LE(BigInt(authTimeout));

        const messageBuffer = Buffer.concat(messageBuffers);
        const signature = sign.detached(messageBuffer, this.signer.signer.secretKey);

        return Promise.resolve({
            nonce: useNonce,
            prefix: authPrefix,
            timeout: authTimeout.toString(10),
            signature: Buffer.from(signature).toString("hex")
        });
    }

    getRefundSignature(swapData: SolanaSwapData): Promise<{ prefix: string; timeout: string; signature: string }> {
        const authPrefix = "refund";
        const authTimeout = Math.floor(Date.now()/1000)+AUTHORIZATION_TIMEOUT;

        const messageBuffers = [
            null,
            Buffer.alloc(8),
            Buffer.alloc(8),
            null,
            Buffer.alloc(8)
        ];

        messageBuffers[0] = Buffer.from(authPrefix, "ascii");
        messageBuffers[1].writeBigUInt64LE(BigInt(swapData.amount.toString(10)));
        messageBuffers[2].writeBigUInt64LE(BigInt(swapData.expiry.toString(10)));
        messageBuffers[3] = Buffer.from(swapData.paymentHash, "hex");
        messageBuffers[4].writeBigUInt64LE(BigInt(authTimeout));

        const messageBuffer = Buffer.concat(messageBuffers);

        const signature = sign.detached(messageBuffer, this.signer.signer.secretKey);

        return Promise.resolve({
            prefix: authPrefix,
            timeout: authTimeout.toString(10),
            signature: Buffer.from(signature).toString("hex")
        });
    }

    async isCommited(swapData: SolanaSwapData): Promise<boolean> {
        const paymentHash = Buffer.from(swapData.paymentHash, "hex");

        try {
            const account: any = await this.program.account.escrowState.fetch(this.SwapEscrowState(paymentHash));
            if(account!=null) {
                if(
                    account.kind===swapData.kind &&
                    account.confirmations===swapData.confirmations &&
                    swapData.nonce.eq(account.nonce) &&
                    Buffer.from(account.hash).equals(paymentHash) &&
                    account.payIn===swapData.payIn &&
                    account.payOut===swapData.payOut &&
                    account.offerer.equals(swapData.offerer) &&
                    account.claimer.equals(swapData.intermediary) &&
                    new BN(account.expiry.toString(10)).eq(swapData.expiry) &&
                    new BN(account.initializerAmount.toString(10)).eq(swapData.amount) &&
                    account.mint.equals(swapData.token)
                ) {
                    return true;
                }
            }
        } catch (e) {
            console.error(e);
        }
        return false;
    }


    async getCommitedData(paymentHashHex: string): Promise<SolanaSwapData> {
        const paymentHash = Buffer.from(paymentHashHex, "hex");

        try {
            const account: any = await this.program.account.escrowState.fetch(this.SwapEscrowState(paymentHash));
            if(account!=null) {
                return new SolanaSwapData(
                    account.initializerKey,
                    account.offerer,
                    account.claimer,
                    account.mint,
                    account.initializerAmount,
                    Buffer.from(account.hash).toString("hex"),
                    account.expiry,
                    account.nonce,
                    account.confirmations,
                    account.payOut,
                    account.kind,
                    account.payIn,
                    account.claimerTokenAccount
                );
            }
        } catch (e) {
            console.error(e);
        }
        return null;
    }

    static typeToKind(type: SwapType): number {
        switch (type) {
            case SwapType.HTLC:
                return 0;
            case SwapType.CHAIN:
                return 1;
            case SwapType.CHAIN_NONCED:
                return 2;
        }

        return null;
    }

    createSwapData(type: SwapType, offerer: string, claimer: string, token: TokenAddress, amount: BN, paymentHash: string, expiry: BN, escrowNonce: BN, confirmations: number, payOut: boolean): SolanaSwapData {
        return new SolanaSwapData(
            null,
            offerer==null ? null : new PublicKey(offerer),
            claimer==null ? null : new PublicKey(claimer),
            token,
            amount,
            paymentHash,
            expiry,
            escrowNonce,
            confirmations,
            payOut,
            SolanaSwapProgram.typeToKind(type),
            null,
            null
        );
    }

    async claimWithSecret(swapData: SolanaSwapData, secret: string): Promise<boolean> {

        let result = await this.program.methods
            .claimerClaim(Buffer.from(secret, "hex"))
            .accounts({
                signer: this.signer.publicKey,
                claimer: swapData.intermediary,
                offerer: swapData.offerer,
                initializer: swapData.initializer,
                userData: this.SwapUserVault(swapData.intermediary, swapData.token),
                escrowState: this.SwapEscrowState(Buffer.from(swapData.paymentHash, "hex")),
                systemProgram: SystemProgram.programId,
                ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY
            })
            .signers([this.signer.signer])
            .transaction();

        const signature = await this.signer.sendAndConfirm(result, [this.signer.signer]);

        console.log("[To BTCLN: Solana.PaymentResult] Transaction sent: ", signature);
        return true;

    }

    async claimWithTxData(swapData: SolanaSwapData, tx: { blockhash: string; confirmations: number; txid: string; hex: string }, vout: number): Promise<boolean> {

        let blockheader;
        try {
            blockheader = await new Promise((resolve, reject) => {
                BtcRPC.getBlockHeader(tx.blockhash, true, (err, info) => {
                    if(err) {
                        reject(err);
                        return;
                    }
                    resolve(info.result);
                });
            });
        } catch (e) {
            console.error(e);
        }

        console.log("[To BTC: Solana.Claim] Blockheader fetched: ", blockheader);

        if(blockheader==null) return false;

        let commitedHeader;
        try {
            commitedHeader = await this.btcRelay.retrieveBlockLog(blockheader.hash, blockheader.height+tx.confirmations-1);
        } catch (e) {
            console.error(e);
        }

        console.log("[To BTC: Solana.Claim] Commited header retrieved: ", commitedHeader);

        if(commitedHeader==null) return false;

        const merkleProof = await BTCMerkleTree.getTransactionMerkle(tx.txid, tx.blockhash);

        console.log("[To BTC: Solana.Claim] Merkle proof computed: ", merkleProof);

        const witnessRawTxBuffer: Buffer = Buffer.from(tx.hex, "hex");

        const btcTx = bitcoin.Transaction.fromBuffer(witnessRawTxBuffer);

        for(let txIn of btcTx.ins) {
            txIn.witness = [];
        }

        const rawTxBuffer: Buffer = btcTx.toBuffer();

        const writeData: Buffer = Buffer.concat([
            Buffer.from(new BN(vout).toArray("le", 4)),
            rawTxBuffer
        ]);

        console.log("[To BTC: Solana.Claim] Writing transaction data: ", writeData.toString("hex"));

        const txDataKey = this.SwapTxDataAlt(merkleProof.reversedTxId, this.signer.signer);

        const fetchedDataAccount: any = await this.signer.connection.getAccountInfo(txDataKey.publicKey);
        if(fetchedDataAccount!=null) {
            console.log("[To BTC: Solana.Claim] Will erase previous data account");
            const eraseTx = await this.program.methods
                .closeData()
                .accounts({
                    signer: this.signer.publicKey,
                    data: txDataKey.publicKey
                })
                .signers([this.signer.signer])
                .transaction();

            const signature = await this.signer.sendAndConfirm(eraseTx, [this.signer.signer]);
            console.log("[To BTC: Solana.Claim] Previous data account erased: ", signature);
        }

        {
            const dataSize = writeData.length;
            const accountSize = 32+dataSize;
            const lamports = await this.signer.connection.getMinimumBalanceForRentExemption(accountSize);

            const accIx = SystemProgram.createAccount({
                fromPubkey: this.signer.publicKey,
                newAccountPubkey: txDataKey.publicKey,
                lamports,
                space: accountSize,
                programId: this.program.programId
            });

            const initIx = await this.program.methods
                .initData()
                .accounts({
                    signer: this.signer.publicKey,
                    data: txDataKey.publicKey
                })
                .signers([this.signer.signer, txDataKey])
                .instruction();

            const initTx = new Transaction();
            initTx.add(accIx);
            initTx.add(initIx);

            await this.saveDataAccount(txDataKey.publicKey);
            const signature = await this.signer.sendAndConfirm(initTx, [this.signer.signer, txDataKey]);
            console.log("[To BTC: Solana.Claim] New data account initialized: ", signature);
        }

        let pointer = 0;
        const writeTxs: {
            tx: Transaction,
            signers?: Signer[]
        }[] = [];
        while(pointer<writeData.length) {
            const writeLen = Math.min(writeData.length-pointer, 950);

            const writeTx = await this.program.methods
                .writeData(pointer, writeData.slice(pointer, writeLen))
                .accounts({
                    signer: this.signer.publicKey,
                    data: txDataKey.publicKey
                })
                .signers([this.signer.signer])
                .transaction();

            writeTxs.push({
                tx: writeTx,
                signers: [this.signer.signer]
            });

            console.log("[To BTC: Solana.Claim] Write partial tx data ("+pointer+" .. "+(pointer+writeLen)+")/"+writeData.length);

            pointer += writeLen;
        }

        const signatures = await this.signer.sendAll(writeTxs);

        console.log("[To BTC: Solana.Claim] Tx data written");

        const verifyIx = await this.btcRelay.createVerifyIx(this.signer.signer, merkleProof.reversedTxId, swapData.confirmations, merkleProof.pos, merkleProof.merkle, commitedHeader);
        const claimIx = await this.program.methods
            .claimerClaimWithExtData()
            .accounts({
                signer: this.signer.publicKey,
                claimer: swapData.intermediary,
                offerer: swapData.offerer,
                initializer: swapData.initializer,
                data: txDataKey.publicKey,
                userData: this.SwapUserVault(swapData.intermediary, swapData.token),
                escrowState: this.SwapEscrowState(Buffer.from(swapData.paymentHash, "hex")),
                systemProgram: SystemProgram.programId,
                ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY
            })
            .signers([this.signer.signer])
            .instruction();

        const solanaTx = new Transaction();
        solanaTx.add(verifyIx);
        solanaTx.add(claimIx);
        solanaTx.feePayer = this.signer.publicKey;
        solanaTx.recentBlockhash = (await this.signer.connection.getLatestBlockhash()).blockhash;

        const signature = await this.signer.sendAndConfirm(solanaTx, [this.signer.signer]);
        console.log("[To BTC: Solana.Claim] Transaction confirmed: ", signature);

        await this.removeDataAccount(txDataKey.publicKey);

        return true;

    }

    async refund(swapData: SolanaSwapData): Promise<boolean> {

        let builder = this.program.methods
            .offererRefund()
            .accounts({
                offerer: swapData.offerer,
                initializer: swapData.initializer,
                userData: this.SwapUserVault(swapData.offerer, swapData.token),
                escrowState: this.SwapEscrowState(Buffer.from(swapData.paymentHash, "hex"))
            });

        if(!swapData.payOut) {
            builder = builder.remainingAccounts([
                {
                    isSigner: false,
                    isWritable: true,
                    pubkey: this.SwapUserVault(swapData.intermediary, swapData.token)
                }
            ]);
        }

        let result = await builder
            .signers([this.signer.signer])
            .transaction();

        const signature = await this.signer.sendAndConfirm(result, [this.signer.signer]);

        console.log("[From BTC-LN: Solana.Refund] Transaction confirmed! Signature: ", signature);

        return true;
    }

    getAddress(): string {
        return this.signer.publicKey.toBase58();
    }

    isValidAddress(address: string): boolean {
        try {
            return PublicKey.isOnCurve(address);
        } catch (e) {
            return false;
        }
    }

}

export default SolanaSwapProgram;