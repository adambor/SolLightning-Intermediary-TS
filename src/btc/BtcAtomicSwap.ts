import * as bitcoin from "bitcoinjs-lib";
import {createHash} from "crypto";
import {BITCOIN_NETWORK} from "../constants/Constants";
import * as lncli from "ln-service";
import LND from "./LND";

class BtcAtomicSwap {

    static readonly SIGHASH_ALL = 0x01;
    static readonly SIGHASH_NONE = 0x02;
    static readonly SIGHASH_SINGLE = 0x03;

    static readonly ANYONECANPAY = 0x80;

    private static generateLockingScript(csvDelta: number, hash: Buffer, ourKey: Buffer, payeeKey: Buffer): {
        address: string,
        scriptHash: Buffer,
        scriptBuffer: Buffer,
        scriptAsm: string
    } {
        if(csvDelta<0) {
            throw new Error("Invalid csv delta");
        }

        let script = "76"; //OP_DUP

        script += "21"+ourKey; //PUSH_33 <our key>
        script += "6b"; //OP_TOALTSTACK
        script += "21"+payeeKey; //PUSH_33 <payee's key>
        script += "6b"; //OP_TOALTSTACK

        script += "5287"; //PUSH_2 OP_EQUAL

        script += "63"; //OP_IF

        //Cooperative close: 0 <signature1> <signature2> 2
        script += "6c"; //OP_FROMALTSTACK  <payee's key>
        script += "6c"; //OP_FROMALTSTACK  <our key>
        script += "52"; //PUSH_2
        script += "ae"; //OP_CHECKMULTISIG

        script += "68"; //OP_ENDIF

        script += "765387"; //OP_DUP PUSH_3 OP_EQUAL

        script += "63"; //OP_IF

        //Hash condition: <signature1> <secret> 3
        script += "75"; //OP_DROP
        script += "a8"; //OP_SHA256
        script += "20"+hash.toString("hex"); //PUSH_32 <hash>
        script += "88"; //OP_EQUALVERIFY
        script += "6c756c"; //OP_FROMALTSTACK  <our key>
        script += "ac"; //OP_CHECKSIG

        script += "68"; //OP_ENDIF

        script += "765487"; //OP_DUP PUSH_4 OP_EQUAL

        script += "63"; //OP_IF

        //Refund condition <signature2> 4
        script += "75"; //OP_DROP
        if(csvDelta<17) {
            if(csvDelta===0) {
                script += "00";
            } else {
                script += (csvDelta + 0x50).toString(16).padStart(2, "0"); //PUSH_<csv>
            }
        } else {
            let csvDeltaHex = csvDelta.toString(16);
            const csvDeltaLen = Math.ceil(csvDeltaHex.length/2);
            csvDeltaHex = csvDeltaHex.padStart(csvDeltaLen*2, "0");
            script += csvDeltaLen.toString(16).padStart(2, "0")+csvDeltaHex; //PUSH_x <csv>
        }
        script += "b2"; //OP_CSV
        script += "75"; //OP_DROP
        script += "6c"; //OP_FROMALTSTACK  <payee's key>
        script += "ac"; //OP_CHECKSIG

        script += "68"; //OP_ENDIF


        const scriptBuffer = Buffer.from(script, "hex");
        const scriptAsm = bitcoin.script.toASM(scriptBuffer);

        const scriptHash = createHash("sha256").update(scriptBuffer).digest();

        const payment = bitcoin.payments.p2wsh({
            hash: scriptHash,
            network: BITCOIN_NETWORK
        });

        const address = payment.address;

        return {
            address,
            scriptHash,
            scriptBuffer,
            scriptAsm
        };
    }

    static async getLockingScript(csvDelta: number, hash: Buffer, payeeKey: Buffer, keyIndex?: number): Promise<{
        address: string,
        scriptHash: Buffer,
        scriptBuffer: Buffer,
        scriptAsm: string,

        publicKey: Buffer,
        keyIndex: number
    }> {
        const {index, public_key} = await lncli.getPublicKey({
            family: 1,
            index: keyIndex,
            lnd: LND
        });

        const ourKey = Buffer.from(public_key, "hex");

        const resp = this.generateLockingScript(csvDelta, hash, ourKey, payeeKey);

        return {
            address: resp.address,
            scriptHash: resp.scriptHash,
            scriptBuffer: resp.scriptBuffer,
            scriptAsm: resp.scriptAsm,

            publicKey: ourKey,
            keyIndex: index
        }
    }

    static async getSignature(utxo: {txId: string, vout: number, value: number}, keyIndex: number, htlcAddress: string, witnessScript: Buffer, sweepAddress: string, value: number, sighash?: number): Promise<string> {

        let rawTx = "02000000"; //Version 2
        rawTx += "0001"; //Segwit flag
        rawTx += "01"; //Input count
        rawTx += Buffer.from(utxo.txId, "hex").reverse().toString("hex"); //Input hash
        const voutBuffer = Buffer.alloc(4);
        voutBuffer.writeUint32LE(utxo.vout);
        rawTx += voutBuffer.toString("hex"); //Input index
        rawTx += "00"; //Input script len
        rawTx += "ffffffff"; //Input nSequence

        rawTx += "01"; //Output count
        const amountBuffer = Buffer.alloc(8);
        amountBuffer.writeBigUint64LE(BigInt(value));
        rawTx += amountBuffer.toString("hex"); //Output amount
        const outputScriptBuffer = bitcoin.address.toOutputScript(sweepAddress, BITCOIN_NETWORK); //Output script
        rawTx += outputScriptBuffer.length.toString(16).padStart(2, "0"); //Output script len
        rawTx += outputScriptBuffer.toString("hex"); //Output script
        rawTx += "00"; //Witness pushes
        rawTx += "00000000"; //Locktime

        const useSighash = sighash || 0x01;

        const resp = await lncli.signTransaction({
            lnd: LND,
            inputs: [
                {
                    key_family: 1,
                    key_index: keyIndex,
                    output_script: bitcoin.address.toOutputScript(htlcAddress, BITCOIN_NETWORK).toString("hex"),
                    witness_script: witnessScript.toString("hex"),
                    output_tokens: utxo.value,
                    sighash: useSighash, //SIGHASH_ALL
                    vin: 0
                }
            ],
            transaction: rawTx
        });

        const signature = resp.signatures[0]+useSighash.toString(16).padStart(2, "0"); //Append 0x01 for SIGHASH_ALL

        return signature;

    }

    static async getSweepTransaction(
        csvDelta: number, hash: Buffer, secret: Buffer, payeeKey: Buffer, keyIndex: number,
        utxo: {txId: string, vout: number, value: number}, htlcAddress: string,
        sweepAddress: string, value: number
    ) : Promise<bitcoin.Transaction> {

        const lockingScript = await this.getLockingScript(csvDelta, hash, payeeKey, keyIndex);

        if(lockingScript.address!==htlcAddress) throw new Error("HTLC address mismatch");

        const signature = await BtcAtomicSwap.getSignature(utxo, keyIndex, htlcAddress, lockingScript.scriptBuffer, sweepAddress, value);

        let psbt = new bitcoin.Psbt({
            network: BITCOIN_NETWORK
        });

        psbt.addInput({
            hash: utxo.txId,
            index: utxo.vout,
            witnessUtxo: {
                script: bitcoin.address.toOutputScript(htlcAddress, BITCOIN_NETWORK),
                value: utxo.value
            }
        });

        psbt.addOutput({
            address: sweepAddress,
            value: value
        });

        let witnessScript = "04"; //Data pushes

        witnessScript += (signature.length/2).toString(16).padStart(2, "0"); //Signature len
        witnessScript += signature;

        witnessScript += "20"; // Secret len
        witnessScript += secret.toString("hex"); //Secret

        witnessScript += "0103"; // for OP_IF

        witnessScript += lockingScript.scriptBuffer.length.toString(16).padStart(2, "0"); //Script len
        witnessScript += lockingScript.scriptBuffer.toString("hex");

        psbt.finalizeInput(0, () => {
            return {
                finalScriptWitness: Buffer.from(witnessScript, "hex")
            }
        });

        return psbt.extractTransaction();

    }

    static async getCooperativeCloseSignature(
        csvDelta: number, hash: Buffer, payeeKey: Buffer, keyIndex: number,
        utxo: {txId: string, vout: number, value: number}, htlcAddress: string
    ) : Promise<Buffer> {

        const lockingScript = await this.getLockingScript(csvDelta, hash, payeeKey, keyIndex);

        if(lockingScript.address!==htlcAddress) throw new Error("HTLC address mismatch");

        const signature = await BtcAtomicSwap.getSignature(utxo, keyIndex, htlcAddress, lockingScript.scriptBuffer, "tb1q3ckxnlqzyvhm7vft7dddkpu7k7g790as3zg3f8", 10000, BtcAtomicSwap.SIGHASH_NONE | BtcAtomicSwap.ANYONECANPAY);

        return Buffer.from(signature, "hex");

    }

}

export default BtcAtomicSwap;