import {programIdl} from "./programIdl";
import {BN, BorshCoder, EventParser, Program} from "@project-serum/anchor";
import AnchorSigner from "../AnchorSigner";
import {Keypair, PublicKey, Signer} from "@solana/web3.js";
import {
    AUTHORITY_SEED,
    AUTHORIZATION_TIMEOUT,
    STATE_SEED,
    USER_VAULT_SEED,
    VAULT_SEED,
    WBTC_ADDRESS
} from "../../Constants";
import {sign} from "tweetnacl";
import Nonce from "../Nonce";
import {getAssociatedTokenAddressSync} from "@solana/spl-token";
import {createHash} from "crypto";

const TX_DATA_SEED = "data";

export const swapProgramCoder = new BorshCoder(programIdl as any);
const SwapProgram = new Program(programIdl as any, programIdl.metadata.address, AnchorSigner);
export const swapProgramEvetnParser = new EventParser(SwapProgram.programId, swapProgramCoder);

export default SwapProgram;

export const SwapVaultAuthority: PublicKey = PublicKey.findProgramAddressSync(
    [Buffer.from(AUTHORITY_SEED)],
    SwapProgram.programId
)[0];

export const SwapVault: PublicKey = PublicKey.findProgramAddressSync(
    [Buffer.from(VAULT_SEED), WBTC_ADDRESS.toBuffer()],
    SwapProgram.programId
)[0];

export const SwapUserVault: (publicKey: PublicKey) => PublicKey = (publicKey: PublicKey) => PublicKey.findProgramAddressSync(
    [Buffer.from(USER_VAULT_SEED), publicKey.toBuffer(), WBTC_ADDRESS.toBuffer()],
    SwapProgram.programId
)[0];

export const SwapEscrowState: (hash: Buffer) => PublicKey = (hash: Buffer) => PublicKey.findProgramAddressSync(
    [Buffer.from(STATE_SEED), hash],
    SwapProgram.programId
)[0];

export const SwapTxData: (reversedTxId: Buffer, pubkey: PublicKey) => PublicKey = (reversedTxId: Buffer, pubkey: PublicKey) => PublicKey.findProgramAddressSync(
    [Buffer.from(TX_DATA_SEED), reversedTxId, pubkey.toBuffer()],
    SwapProgram.programId
)[0];

export const SwapTxDataAlt: (reversedTxId: Buffer, signer: Signer) => Signer = (reversedTxId: Buffer, signer: Signer) => {
    const buff = createHash("sha256").update(Buffer.concat([signer.secretKey, reversedTxId])).digest();
    return Keypair.fromSeed(buff);
};

export type EscrowStateType = {
    kind: number,
    confirmations: number,
    nonce: BN,
    hash: number[],
    initializerKey: PublicKey,
    payIn: boolean,
    offerer: PublicKey,
    claimer: PublicKey,
    initializerDepositTokenAccount: PublicKey,
    initializerAmount: BN,
    mint: PublicKey,
    expiry: BN
}

export const getEscrow: (paymentHash: Buffer) => Promise<EscrowStateType> = async (paymentHash: Buffer): Promise<EscrowStateType> => {
    let escrowState;
    try {
        escrowState = await SwapProgram.account.escrowState.fetch(SwapEscrowState(paymentHash));
    } catch (e) {
        return;
    }
    return escrowState;
};

export type RefundSignatureResponse = {
    prefix: string,
    timeout: string,
    signature: string
};

export const getRefundSignature: (escrow: EscrowStateType) => RefundSignatureResponse = (escrow: EscrowStateType): RefundSignatureResponse => {
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
    messageBuffers[1].writeBigUInt64LE(BigInt(escrow.initializerAmount.toString(10)));
    messageBuffers[2].writeBigUInt64LE(BigInt(escrow.expiry.toString(10)));
    messageBuffers[3] = Buffer.from(escrow.hash);
    messageBuffers[4].writeBigUInt64LE(BigInt(authTimeout));

    const messageBuffer = Buffer.concat(messageBuffers);

    const signature = sign.detached(messageBuffer, AnchorSigner.signer.secretKey);

    return {
        prefix: authPrefix,
        timeout: authTimeout.toString(10),
        signature: Buffer.from(signature).toString("hex")
    }
};

export type InitSignatureData = {
    intermediary: PublicKey,
    token: PublicKey,
    amount: BN,
    paymentHash: string,
    expiry: BN,
    kind?: number,
    confirmations?: number
};

export type InitSignatureResponse = {
    nonce: number,
    prefix: string,
    timeout: string,
    signature: string
};

export const getInitSignature: (data: InitSignatureData) => InitSignatureResponse = (data: InitSignatureData): InitSignatureResponse => {
    const authPrefix = "initialize";
    const authTimeout = Math.floor(Date.now()/1000)+AUTHORIZATION_TIMEOUT;
    const useNonce = Nonce.getNonce()+1;

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
    messageBuffers[2] = data.token.toBuffer();
    messageBuffers[3] = data.intermediary.toBuffer();
    messageBuffers[4].writeBigUInt64LE(BigInt(data.amount.toString(10)));
    messageBuffers[5].writeBigUInt64LE(BigInt(data.expiry.toString(10)));
    messageBuffers[6] = Buffer.from(data.paymentHash, "hex");
    messageBuffers[7].writeUint8(data.kind || 0);
    messageBuffers[8].writeUint16LE(data.confirmations || 0);
    messageBuffers[9].writeBigUInt64LE(BigInt(authTimeout));

    const messageBuffer = Buffer.concat(messageBuffers);
    const signature = sign.detached(messageBuffer, AnchorSigner.signer.secretKey);

    return {
        nonce: useNonce,
        prefix: authPrefix,
        timeout: authTimeout.toString(10),
        signature: Buffer.from(signature).toString("hex")
    }
};

export type ClaimInitSignatureData = {
    intermediary: PublicKey,
    token: PublicKey,
    amount: BN,
    paymentHash: string,
    expiry: BN,
    kind?: number,
    confirmations?: number,
    payOut?: boolean
};

export type ClaimInitSignatureResponse = {
    nonce: number,
    prefix: string,
    timeout: string,
    signature: string
};

export const getClaimInitSignature: (data: ClaimInitSignatureData) => ClaimInitSignatureResponse = (data: ClaimInitSignatureData): ClaimInitSignatureResponse => {
    const authPrefix = "claim_initialize";
    const authTimeout = Math.floor(Date.now()/1000)+AUTHORIZATION_TIMEOUT;
    const useNonce = Nonce.getClaimNonce()+1;

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
    messageBuffers[2] = data.token.toBuffer();
    messageBuffers[3].writeBigUInt64LE(BigInt(data.amount.toString(10)));
    messageBuffers[4].writeBigUInt64LE(BigInt(data.expiry.toString(10)));
    messageBuffers[5] = Buffer.from(data.paymentHash, "hex");
    messageBuffers[6].writeUint8(data.kind || 0);
    messageBuffers[7].writeUint16LE(data.confirmations || 0);
    messageBuffers[8].writeBigUInt64LE(BigInt(authTimeout));

    if(data.payOut===true) {
        const ata = getAssociatedTokenAddressSync(WBTC_ADDRESS, data.intermediary);
        messageBuffers.push(Buffer.alloc(1, 1));
        messageBuffers.push(ata.toBuffer());
    } else {
        messageBuffers.push(Buffer.alloc(1, 0));
    }

    const messageBuffer = Buffer.concat(messageBuffers);
    const signature = sign.detached(messageBuffer, AnchorSigner.signer.secretKey);

    return {
        nonce: useNonce,
        prefix: authPrefix,
        timeout: authTimeout.toString(10),
        signature: Buffer.from(signature).toString("hex")
    }
};