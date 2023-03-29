import * as dotenv from "dotenv";
dotenv.config();

import SwapProgram, {SwapUserVault} from "../sol/program/SwapProgram";
import AnchorSigner from "../sol/AnchorSigner";



async function main() {

    const data: any = await SwapProgram.account.userAccount.fetch(SwapUserVault(AnchorSigner.publicKey));

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