import {programIdl} from "./programIdl";
import {BorshCoder, EventParser, Program} from "@project-serum/anchor";
import {PublicKey} from "@solana/web3.js";
import AnchorSigner from "../../sol/AnchorSigner";

const HEADER_SEED = "header";
const BTC_RELAY_STATE_SEED = "state";

export const btcRelayProgramCoder = new BorshCoder(programIdl as any);
const BTCRelayProgram = new Program(programIdl as any, programIdl.metadata.address, AnchorSigner);
export const btcRelayProgramEventParser = new EventParser(BTCRelayProgram.programId, btcRelayProgramCoder);

export default BTCRelayProgram;

export const BtcRelayMainState: PublicKey = PublicKey.findProgramAddressSync(
    [Buffer.from(BTC_RELAY_STATE_SEED)],
    BTCRelayProgram.programId
)[0];

export const BtcRelayHeader: (hash: Buffer) => PublicKey = (hash: Buffer) => PublicKey.findProgramAddressSync(
    [Buffer.from(HEADER_SEED), hash],
    BTCRelayProgram.programId
)[0];