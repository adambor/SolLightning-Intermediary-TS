import * as dotenv from "dotenv";
dotenv.config();

import {WBTC_ADDRESS} from "../Constants";
import AnchorSigner from "../sol/AnchorSigner";
import {getAssociatedTokenAddress, TOKEN_PROGRAM_ID} from "@solana/spl-token";
import SwapProgram, {SwapUserVault, SwapVault, SwapVaultAuthority} from "../sol/program/SwapProgram";
import {BN} from "@project-serum/anchor";
import {SystemProgram, SYSVAR_RENT_PUBKEY} from "@solana/web3.js";

async function deposit(amount: number) {
    const ata = await getAssociatedTokenAddress(WBTC_ADDRESS, AnchorSigner.publicKey);

    let result = await SwapProgram.methods
        .deposit(new BN(amount))
        .accounts({
            initializer: AnchorSigner.publicKey,
            userData: SwapUserVault(AnchorSigner.publicKey),
            mint: WBTC_ADDRESS,
            vault: SwapVault,
            vaultAuthority: SwapVaultAuthority,
            initializerDepositTokenAccount: ata,
            systemProgram: SystemProgram.programId,
            rent: SYSVAR_RENT_PUBKEY,
            tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([AnchorSigner.signer])
        .transaction();

    const signature = await AnchorSigner.sendAndConfirm(result, [AnchorSigner.signer]);

    console.log("Deposit sent: ", signature);
}

async function main() {
    if(process.argv.length<3) {
        console.error("Needs at least 1 argument");
        console.error("Usage: node deposit.js <amount>");
        return;
    }

    const amount = parseInt(process.argv[2]);

    if(isNaN(amount)) {
        console.error("Invalid amount argument (not a number)");
        return;
    }

    await deposit(amount);
}

main();