import {AnchorProvider, Wallet} from "@coral-xyz/anchor";
import {Connection, Keypair} from "@solana/web3.js";

const privKey = process.env.SOL_PRIVKEY;
const address = process.env.SOL_ADDRESS;

const _signer = Keypair.fromSecretKey(Buffer.from(privKey, "hex"));

const connection = new Connection(process.env.SOL_RPC_URL, "processed");
const AnchorSigner: (AnchorProvider & {signer: Keypair}) = new AnchorProvider(connection, new Wallet(_signer), {
    preflightCommitment: "processed"
}) as any;

AnchorSigner.signer = _signer;

export default AnchorSigner;