import * as dotenv from "dotenv";
dotenv.config();

import AnchorSigner from "../chains/solana/signer/AnchorSigner";
import SolanaBtcRelay from "../chains/solana/btcrelay/SolanaBtcRelay";
import SolanaSwapProgram from "../chains/solana/swaps/SolanaSwapProgram";
import {WBTC_ADDRESS} from "../Constants";

async function main() {

    const btcRelay = new SolanaBtcRelay(AnchorSigner);
    const swapContract = new SolanaSwapProgram(AnchorSigner, btcRelay, "");

    const data: any = await swapContract.program.account.userAccount.fetch(swapContract.SwapUserVault(AnchorSigner.publicKey, WBTC_ADDRESS));

    console.log("LN:");
    console.log("   successes: "+data.successVolume[0].toString(10)+" ("+data.successCount[0].toString(10)+")");
    console.log("   fails: "+data.failVolume[0].toString(10)+" ("+data.failCount[0].toString(10)+")");
    console.log("   coop closes: "+data.coopCloseVolume[0].toString(10)+" ("+data.coopCloseCount[0].toString(10)+")");

    console.log("On-chain:");
    console.log("   successes: "+data.successVolume[2].toString(10)+" ("+data.successCount[2].toString(10)+")");
    console.log("   fails: "+data.failVolume[2].toString(10)+" ("+data.failCount[2].toString(10)+")");
    console.log("   coop closes: "+data.coopCloseVolume[2].toString(10)+" ("+data.coopCloseCount[2].toString(10)+")");

}

main();