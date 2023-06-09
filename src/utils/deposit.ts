import * as dotenv from "dotenv";
dotenv.config();

import {USDC_ADDRESS, USDT_ADDRESS, WBTC_ADDRESS, WSOL_ADDRESS} from "../constants/Constants";
import AnchorSigner from "../chains/solana/signer/AnchorSigner";
import {getAssociatedTokenAddress, TOKEN_PROGRAM_ID} from "@solana/spl-token";
import {BN} from "@coral-xyz/anchor";
import {SystemProgram, SYSVAR_RENT_PUBKEY} from "@solana/web3.js";
import {SolanaBtcRelay, SolanaSwapProgram, StoredDataAccount} from "crosslightning-solana";
import BtcRPC, {BtcRPCConfig} from "../btc/BtcRPC";
import {StorageManager} from "crosslightning-intermediary";
import {BitcoindRpc} from "btcrelay-bitcoind";

async function deposit(amount: number, token: string) {

    let useToken;
    switch (token) {
        case "WBTC":
            useToken = WBTC_ADDRESS;
            break;
        case "USDC":
            useToken = USDC_ADDRESS;
            break;
        case "USDT":
            useToken = USDT_ADDRESS;
            break;
        case "WSOL":
            useToken = WSOL_ADDRESS;
            break;
        default:
            return false;
    }

    const bitcoinRpc = new BitcoindRpc(
        BtcRPCConfig.protocol,
        BtcRPCConfig.user,
        BtcRPCConfig.pass,
        BtcRPCConfig.host,
        BtcRPCConfig.port
    );
    const btcRelay = new SolanaBtcRelay(AnchorSigner, bitcoinRpc);
    const swapContract = new SolanaSwapProgram(AnchorSigner, btcRelay, new StorageManager<StoredDataAccount>(""));

    const ata = await getAssociatedTokenAddress(useToken, AnchorSigner.publicKey);

    let result = await swapContract.program.methods
        .deposit(new BN(amount))
        .accounts({
            initializer: AnchorSigner.publicKey,
            userData: swapContract.SwapUserVault(AnchorSigner.publicKey, useToken),
            mint: useToken,
            vault: swapContract.SwapVault(useToken),
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

    return true;

}

async function main() {
    if(process.argv.length<4) {
        console.error("Needs at least 2 arguments");
        console.error("Usage: node deposit.js <token:WBTC,USDC,USDT> <amount>");
        return;
    }

    const token = process.argv[2];
    const amount = parseInt(process.argv[3]);

    if(isNaN(amount)) {
        console.error("Invalid amount argument (not a number)");
        return;
    }

    if(!(await deposit(amount, token))) {
        console.error("Invalid token argument (must be one of WBTC, USDC, USDT)");
    }
}

main();