import * as dotenv from "dotenv";
dotenv.config();

import {WBTC_ADDRESS} from "../Constants";
import AnchorSigner from "../chains/solana/signer/AnchorSigner";
import {getAssociatedTokenAddress, TOKEN_PROGRAM_ID} from "@solana/spl-token";
import {BN} from "@project-serum/anchor";
import {SystemProgram, SYSVAR_RENT_PUBKEY} from "@solana/web3.js";
import SolanaSwapProgram from "../chains/solana/swaps/SolanaSwapProgram";
import SolanaBtcRelay from "../chains/solana/btcrelay/SolanaBtcRelay";

async function deposit(amount: number) {
    const btcRelay = new SolanaBtcRelay(AnchorSigner);
    const swapContract = new SolanaSwapProgram(AnchorSigner, btcRelay, "");

    const ata = await getAssociatedTokenAddress(WBTC_ADDRESS, AnchorSigner.publicKey);

    let result = await swapContract.program.methods
        .deposit(new BN(amount))
        .accounts({
            initializer: AnchorSigner.publicKey,
            userData: swapContract.SwapUserVault(AnchorSigner.publicKey, WBTC_ADDRESS),
            mint: WBTC_ADDRESS,
            vault: swapContract.SwapVault(WBTC_ADDRESS),
            vaultAuthority: swapContract.SwapVaultAuthority,
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