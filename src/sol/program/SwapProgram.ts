import {programIdl} from "./programIdl";
import {BN, BorshCoder, EventParser, Program} from "@project-serum/anchor";
import AnchorSigner from "../AnchorSigner";
import {PublicKey} from "@solana/web3.js";
import {AUTHORITY_SEED, STATE_SEED, USER_VAULT_SEED, VAULT_SEED, WBTC_ADDRESS} from "../../Constants";

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