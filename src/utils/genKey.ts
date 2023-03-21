import {Keypair} from "@solana/web3.js";
import * as fs from "fs";

const keypair = Keypair.generate();

const address = keypair.publicKey.toBase58();

fs.appendFileSync(".env",
    "SOL_PRIVKEY=\""+Buffer.from(keypair.secretKey).toString("hex")+"\"\n"+
    "SOL_ADDRESS=\""+address+"\"\n");

console.log("Generated address: "+address);
