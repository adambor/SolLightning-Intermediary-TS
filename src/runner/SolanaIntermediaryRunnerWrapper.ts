import {BitcoinRpc, BtcRelay, ChainEvents, ChainSwapType, SwapContract, SwapData} from "crosslightning-base";
import {
    FromBtcLnSwapAbs,
    FromBtcLnSwapState,
    FromBtcSwapAbs,
    FromBtcSwapState,
    ISwapPrice,
    PluginManager,
    SwapHandlerType,
    ToBtcLnSwapAbs,
    ToBtcLnSwapState,
    ToBtcSwapAbs,
    ToBtcSwapState
} from "crosslightning-intermediary";
import {SolanaIntermediaryRunner} from "./SolanaIntermediaryRunner";
import * as BN from "bn.js";
import {
    cmdEnumParser,
    cmdNumberParser,
    cmdStringParser,
    CommandHandler,
    createCommand
} from "crosslightning-server-base";
import {AnchorProvider} from "@coral-xyz/anchor";
import {Keypair, PublicKey} from "@solana/web3.js";
import {getP2wpkhPubkey, getUnauthenticatedLndGrpc} from "../btc/LND";
import * as lncli from "ln-service";
import {fromDecimal, toDecimal} from "../Utils";
import * as bitcoin from "bitcoinjs-lib";
import {BITCOIN_NETWORK} from "../constants/Constants";
import {IntermediaryConfig} from "../IntermediaryConfig";
import {Registry} from "../Registry";
import * as bolt11 from "bolt11";

export class SolanaIntermediaryRunnerWrapper<T extends SwapData> extends SolanaIntermediaryRunner<T> {

    cmdHandler: CommandHandler;
    lpRegistry: Registry;
    addressesToTokens: {
        [address: string]: {
            ticker: string,
            decimals: number
        }
    }

    constructor(
        directory: string,
        signer: (AnchorProvider & {signer: Keypair}),
        tokens: {
            [ticker: string]: {
                address: PublicKey,
                decimals: number,
                pricing: string
            }
        },
        prices: ISwapPrice,
        bitcoinRpc: BitcoinRpc<any>,
        btcRelay: BtcRelay<any, any, any>,
        swapContract: SwapContract<T, any, any, any>,
        chainEvents: ChainEvents<T>
    ) {
        super(directory, signer, tokens, prices, bitcoinRpc, btcRelay, swapContract, chainEvents);
        this.lpRegistry = new Registry(directory+"/lpRegistration.txt");
        this.addressesToTokens = {};
        for(let ticker in this.tokens) {
            const tokenData = this.tokens[ticker];
            this.addressesToTokens[tokenData.address.toString()] = {
                decimals: tokenData.decimals,
                ticker
            }
        }
        this.cmdHandler = new CommandHandler([
            createCommand(
                "status",
                "Fetches the current status of the bitcoin RPC, LND gRPC & intermediary application",
                {
                    args: {},
                    parser: async (args) => {
                        const reply: string[] = [];

                        let solRpcOK = true;
                        try {
                            await this.signer.connection.getLatestBlockhash();
                        } catch (e) {
                            solRpcOK = false;
                        }
                        reply.push("Solana RPC status:");
                        reply.push("    Status: "+(solRpcOK ? "ready" : "offline!"));

                        const btcRpcStatus = await this.bitcoinRpc.getSyncInfo().catch(e => null);
                        reply.push("Bitcoin RPC status:");
                        reply.push("    Status: "+(btcRpcStatus==null ? "offline" : btcRpcStatus.ibd ? "verifying blockchain" : "ready"));
                        if(btcRpcStatus!=null) {
                            reply.push("    Verification progress: "+(btcRpcStatus.verificationProgress*100).toFixed(4)+"%");
                            reply.push("    Synced headers: "+btcRpcStatus.headers);
                            reply.push("    Synced blocks: "+btcRpcStatus.blocks);
                        }

                        const lndRpcStatus = await this.getLNDWalletStatus(getUnauthenticatedLndGrpc());
                        reply.push("LND gRPC status:");
                        reply.push("    Wallet status: "+lndRpcStatus);
                        if(lndRpcStatus!="offline") {
                            try {
                                const resp = await lncli.getWalletInfo({
                                    lnd: this.LND
                                });
                                reply.push("    Synced to chain: "+resp.is_synced_to_chain);
                                reply.push("    Blockheight: "+resp.current_block_height);
                                reply.push("    Connected peers: "+resp.peers_count);
                                reply.push("    Channels active: "+resp.active_channels_count);
                                reply.push("    Channels pending: "+resp.pending_channels_count);
                                reply.push("    Node pubkey: "+resp.public_key);
                            } catch (e) {
                                console.error(e);
                            }
                        }

                        const balance = await this.swapContract.getBalance(this.swapContract.getNativeCurrencyAddress(), false);
                        reply.push("Intermediary status:");
                        reply.push("    Status: " + this.initState);
                        reply.push("    Funds: " + (balance.toNumber()/Math.pow(10, 9)).toFixed(9));
                        reply.push("    Has enough funds (>0.1 SOL): " + (balance.gt(new BN(100000000)) ? "yes" : "no"));

                        return reply.join("\n");
                    }
                }
            ),
            createCommand(
                "getaddress",
                "Gets the Solana & Bitcoin address of the node",
                {
                    args: {},
                    parser: async (args) => {
                        const reply: string[] = [];
                        reply.push("Solana address: "+this.swapContract.getAddress());
                        const resp = await lncli.createChainAddress({
                            lnd: this.LND,
                            format: "p2wpkh"
                        }).catch(e => console.error(e));
                        if(resp==null) {
                            const pubkey = getP2wpkhPubkey();
                            if(pubkey!=null) {
                                const address = bitcoin.payments.p2wpkh({
                                    pubkey,
                                    network: BITCOIN_NETWORK
                                }).address;
                                reply.push("Bitcoin address: "+address);
                            } else {
                                reply.push("Bitcoin address: unknown (LND node unresponsive - not initialized?)");
                            }
                        } else {
                            reply.push("Bitcoin address: "+resp.address);
                        }
                        return reply.join("\n");
                    }
                }
            ),
            createCommand(
                "getbalance",
                "Gets the balances of the node",
                {
                    args: {},
                    parser: async (args) => {
                        const reply: string[] = [];
                        reply.push("Solana wallet balances (non-trading):");
                        for(let token in this.tokens) {
                            const tokenData = this.tokens[token];
                            reply.push("   "+token+": "+toDecimal(await this.swapContract.getBalance(tokenData.address, false), tokenData.decimals));
                        }
                        reply.push("LP Vault balances (trading):");
                        for(let token in this.tokens) {
                            const tokenData = this.tokens[token];
                            reply.push("   "+token+": "+toDecimal(await this.swapContract.getBalance(tokenData.address, true) || new BN(0), tokenData.decimals));
                        }

                        reply.push("Bitcoin balances (trading):");
                        const utxoResponse = await lncli.getUtxos({lnd: this.LND, min_confirmations: 0}).catch(e => console.error(e));
                        if(utxoResponse==null) {
                            reply.push("   BTC: unknown"+" (waiting for bitcoin node sync)");
                        } else {
                            let unconfirmed = new BN(0);
                            let confirmed = new BN(0);
                            utxoResponse.utxos.forEach(utxo => {
                                if(utxo.confirmation_count===0) {
                                    unconfirmed = unconfirmed.add(new BN(utxo.tokens));
                                } else {
                                    confirmed = confirmed.add(new BN(utxo.tokens));
                                }
                            });
                            reply.push("   BTC: "+toDecimal(confirmed, 8)+" (+"+toDecimal(unconfirmed, 8)+")");
                        }

                        const channelBalance = await lncli.getChannelBalance({lnd: this.LND}).catch(e => console.error(e));
                        if(channelBalance==null) {
                            reply.push("   BTC-LN: unknown (waiting for bitcoin node sync)");
                        } else {
                            reply.push("   BTC-LN: "+toDecimal(new BN(channelBalance.channel_balance), 8)+" (+"+toDecimal(new BN(channelBalance.pending_balance), 8)+")");
                        }

                        return reply.join("\n");
                    }
                }
            ),
            createCommand(
                "connectlightning",
                "Connect to a lightning node peer",
                {
                    args: {
                        node: {
                            base: true,
                            description: "Remote node identification as <pubkey>@<ip address>",
                            parser: (data: string) => {
                                if(data==null) throw new Error("Data cannot be null");
                                const arr = data.split("@");
                                if(arr.length!==2) throw new Error("Invalid format, should be: <pubkey>@<ip address>");
                                return {
                                    pubkey: arr[0],
                                    address: arr[1]
                                };
                            }
                        }
                    },
                    parser: async (args, sendLine) => {
                        if(this.LND==null) throw new Error("LND node not ready yet! Monitor the status with the 'status' command");
                        sendLine("Connecting to remote peer...");
                        await lncli.addPeer({
                            lnd: this.LND,
                            public_key: args.node.pubkey,
                            socket: args.node.address
                        });
                        return "Connection to the lightning peer established! Public key: "+args.node.pubkey;
                    }
                }
            ),
            createCommand(
                "openchannel",
                "Opens up a lightning network payment channel",
                {
                    args: {
                        amount: {
                            base: true,
                            description: "Amount of BTC to use inside a lightning",
                            parser: cmdNumberParser(true, 0)
                        },
                        node: {
                            base: true,
                            description: "Remote node identification as <pubkey>@<ip address>",
                            parser: (data: string) => {
                                if(data==null) throw new Error("Data cannot be null");
                                const arr = data.split("@");
                                if(arr.length!==2) throw new Error("Invalid format, should be: <pubkey>@<ip address>");
                                return {
                                    pubkey: arr[0],
                                    address: arr[1]
                                };
                            }
                        },
                        feeRate: {
                            base: false,
                            description: "Fee rate for the opening transaction (sats/vB)",
                            parser: cmdNumberParser(false, 1, null, true)
                        }
                    },
                    parser: async (args, sendLine) => {
                        if(this.LND==null) throw new Error("LND node not ready yet! Monitor the status with the 'status' command");
                        const amtBN = args.amount==null ? null : fromDecimal(args.amount.toFixed(8), 8);
                        if(amtBN==null) throw new Error("Amount cannot be parsed");
                        const resp = await lncli.openChannel({
                            lnd: this.LND,
                            local_tokens: amtBN.toNumber(),
                            min_confirmations: 0,
                            partner_public_key: args.node.pubkey,
                            partner_socket: args.node.address,
                            fee_rate: 1000,
                            base_fee_mtokens: "1000",
                            chain_fee_tokens_per_vbyte: args.feeRate
                        });
                        return "Lightning channel funded, wait for TX confirmations! txId: "+resp.transaction_id;
                    }
                }
            ),
            createCommand(
                "closechannel",
                "Attempts to cooperatively close a lightning network channel",
                {
                    args: {
                        channelId: {
                            base: true,
                            description: "Channel ID to close cooperatively",
                            parser: cmdStringParser()
                        },
                        feeRate: {
                            base: false,
                            description: "Fee rate for the opening transaction (sats/vB)",
                            parser: cmdNumberParser(false, 1, null, true)
                        }
                    },
                    parser: async (args, sendLine) => {
                        if(this.LND==null) throw new Error("LND node not ready yet! Monitor the status with the 'status' command");
                        const resp = await lncli.closeChannel({
                            lnd: this.LND,
                            is_force_close: false,
                            id: args.channelId,
                            tokens_per_vbyte: args.feeRate
                        });
                        return "Lightning channel closed, txId: "+resp.transaction_id;
                    }
                }
            ),
            createCommand(
                "forceclosechannel",
                "Force closes a lightning network channel",
                {
                    args: {
                        channelId: {
                            base: true,
                            description: "Channel ID to force close",
                            parser: cmdStringParser()
                        },
                        feeRate: {
                            base: false,
                            description: "Fee rate for the opening transaction (sats/vB)",
                            parser: cmdNumberParser(false, 1, null, true)
                        }
                    },
                    parser: async (args, sendLine) => {
                        if(this.LND==null) throw new Error("LND node not ready yet! Monitor the status with the 'status' command");
                        const resp = await lncli.closeChannel({
                            lnd: this.LND,
                            is_force_close: true,
                            id: args.channelId,
                            tokens_per_vbyte: args.feeRate
                        });
                        return "Lightning channel closed, txId: "+resp.transaction_id;
                    }
                }
            ),
            createCommand(
                "listchannels",
                "Lists existing lightning channels",
                {
                    args: {},
                    parser: async (args, sendLine) => {
                        if(this.LND==null) throw new Error("LND node not ready yet! Monitor the status with the 'status' command");
                        const {channels} = await lncli.getChannels({
                            lnd: this.LND
                        });
                        const reply: string[] = [];
                        reply.push("Opened channels:");
                        for(let channel of channels) {
                            reply.push(" - "+channel.id);
                            reply.push("    Peer: "+channel.partner_public_key);
                            reply.push("    State: "+(channel.is_closing ? "closing" : channel.is_opening ? "opening" : channel.is_active ? "active" : "inactive"));
                            reply.push("    Balance: "+toDecimal(new BN(channel.local_balance), 8)+"/"+toDecimal(new BN(channel.capacity), 8)+" ("+(channel.local_balance/channel.capacity*100).toFixed(2)+"%)");
                            reply.push("    Unsettled balance: "+toDecimal(new BN(channel.unsettled_balance), 8));
                        }
                        const {pending_channels} = await lncli.getPendingChannels({
                            lnd: this.LND
                        });
                        if(pending_channels.length>0) {
                            reply.push("Pending channels:");
                            for(let channel of pending_channels) {
                                reply.push(" - "+channel.transaction_id+":"+channel.transaction_vout);
                                reply.push("    Peer: "+channel.partner_public_key);
                                reply.push("    State: "+(channel.is_closing ? "closing" : channel.is_opening ? "opening" : channel.is_active ? "active" : "inactive"));
                                reply.push("    Balance: "+toDecimal(new BN(channel.local_balance), 8)+"/"+toDecimal(new BN(channel.capacity), 8)+" ("+(channel.local_balance/channel.capacity*100).toFixed(2)+"%)");
                                if(channel.is_opening) reply.push("    Funding txId: "+channel.transaction_id);
                                if(channel.is_closing) {
                                    reply.push("    Is timelocked: "+channel.is_timelocked);
                                    if(channel.is_timelocked) reply.push("    Blocks till claimable: "+channel.timelock_blocks);
                                    reply.push("    Close txId: "+channel.close_transaction_id);
                                }
                            }
                        }
                        return reply.join("\n");
                    }
                }
            ),
            createCommand(
                "transfer",
                "Transfer wallet balance to an external address",
                {
                    args: {
                        asset: {
                            base: true,
                            description: "Asset to transfer: WSOL, USDC, USDT, WBTC, BTC",
                            parser: cmdEnumParser<"WSOL" | "USDC" | "USDT" | "WBTC" | "BTC">(["WSOL", "USDC", "USDT", "WBTC", "BTC"])
                        },
                        address: {
                            base: true,
                            description: "Destination address",
                            parser: cmdStringParser()
                        },
                        amount: {
                            base: true,
                            description: "Amount of the currency to send",
                            parser: cmdNumberParser(true, 0)
                        },
                        feeRate: {
                            base: false,
                            description: "Fee rate: sats/vB for BTC",
                            parser: cmdNumberParser(false, 1, null, true)
                        }
                    },
                    parser: async (args, sendLine) => {
                        if(args.asset==="BTC") {
                            if(this.LND==null) throw new Error("LND node not ready yet! Monitor the status with the 'status' command");
                            const amtBN = fromDecimal(args.amount.toFixed(8), 8);

                            const resp = await lncli.sendToChainAddress({
                                lnd: this.LND,
                                tokens: amtBN.toNumber(),
                                address: args.address,
                                utxo_confirmations: 0,
                                fee_tokens_per_vbyte: args.feeRate
                            });

                            return "Transaction sent, txId: "+resp.id;
                        }

                        const tokenData = this.tokens[args.asset];
                        const amtBN = fromDecimal(args.amount.toFixed(tokenData.decimals), tokenData.decimals);

                        const txns = await this.swapContract.txsTransfer(tokenData.address, amtBN, args.address);
                        await this.swapContract.sendAndConfirm(txns, true, null, null, (txId: string) => {
                            sendLine("Transaction sent, signature: "+txId+" waiting for confirmation...");
                            return Promise.resolve();
                        });
                        return "Transfer transaction confirmed!";
                    }
                }
            ),
            createCommand(
                "transferlightning",
                "Transfer lightning wallet balance, pay lightning network invoice",
                {
                    args: {
                        invoice: {
                            base: true,
                            description: "Lightning network invoice to pay (must specify an amount!)",
                            parser: cmdStringParser()
                        }
                    },
                    parser: async (args, sendLine) => {
                        if(this.LND==null) throw new Error("LND node not ready yet! Monitor the status with the 'status' command");
                        sendLine("Sending lightning tx, waiting for confirmation...");
                        const resp = await lncli.pay({
                            lnd: this.LND,
                            request: args.invoice
                        });
                        if(resp.is_confirmed) {
                            return "Lightning transaction confirmed! Preimage: "+resp.secret;
                        }
                        return "Lightning transaction is taking longer than expected, will be handled in the background!";
                    }
                }
            ),
            createCommand(
                "receivelightning",
                "Creates a lightning network invoice",
                {
                    args: {
                        amount: {
                            base: true,
                            description: "Amount of BTC to receive over lightning",
                            parser: cmdNumberParser(true, 0, null, true)
                        }
                    },
                    parser: async (args, sendLine) => {
                        if(this.LND==null) throw new Error("LND node not ready yet! Monitor the status with the 'status' command");
                        const amtBN = args.amount==null ? null : fromDecimal(args.amount.toFixed(8), 8);
                        const resp = await lncli.createInvoice({
                            lnd: this.LND,
                            mtokens: amtBN==null ? undefined : amtBN.mul(new BN(1000)).toString(10)
                        });
                        return "Lightning network invoice: "+resp.request;
                    }
                }
            ),
            createCommand(
                "deposit",
                "Deposits Solana wallet balance to an LP Vault",
                {
                    args: {
                        asset: {
                            base: true,
                            description: "Asset to transfer: WSOL, USDC, USDT, WBTC",
                            parser: cmdEnumParser<"WSOL" | "USDC" | "USDT" | "WBTC">(["WSOL", "USDC", "USDT", "WBTC"])
                        },
                        amount: {
                            base: true,
                            description: "Amount of the currency to send",
                            parser: cmdNumberParser(true, 0)
                        }
                    },
                    parser: async (args, sendLine) => {
                        const tokenData = this.tokens[args.asset];
                        const amtBN = fromDecimal(args.amount.toFixed(tokenData.decimals), tokenData.decimals);

                        const txns = await this.swapContract.txsDeposit(tokenData.address, amtBN);
                        await this.swapContract.sendAndConfirm(txns, true, null, null, (txId: string) => {
                            sendLine("Transaction sent, signature: "+txId+" waiting for confirmation...");
                            return Promise.resolve();
                        });
                        return "Deposit transaction confirmed!";
                    }
                }
            ),
            createCommand(
                "withdraw",
                "Withdraw LP Vault balance to node's Solana wallet",
                {
                    args: {
                        asset: {
                            base: true,
                            description: "Asset to transfer: WSOL, USDC, USDT, WBTC",
                            parser: cmdEnumParser<"WSOL" | "USDC" | "USDT" | "WBTC">(["WSOL", "USDC", "USDT", "WBTC"])
                        },
                        amount: {
                            base: true,
                            description: "Amount of the currency to send",
                            parser: cmdNumberParser(true, 0)
                        }
                    },
                    parser: async (args, sendLine) => {
                        const tokenData = this.tokens[args.asset];
                        const amtBN = fromDecimal(args.amount.toFixed(tokenData.decimals), tokenData.decimals);

                        const txns = await this.swapContract.txsWithdraw(tokenData.address, amtBN);
                        await this.swapContract.sendAndConfirm(txns, true, null, null, (txId: string) => {
                            sendLine("Transaction sent, signature: "+txId+" waiting for confirmation...");
                            return Promise.resolve();
                        });
                        return "Withdrawal transaction confirmed!";
                    }
                }
            ),
            createCommand(
                "getreputation",
                "Checks the LP node's reputation stats",
                {
                    args: {},
                    parser: async (args, sendLine) => {
                        const reply: string[] = [];
                        reply.push("LP node's reputation:");
                        for(let token in this.tokens) {
                            const tokenData = this.tokens[token];
                            const reputation = await this.swapContract.getIntermediaryReputation(this.swapContract.getAddress(), tokenData.address);
                            if(reputation==null) {
                                reply.push(token+": No reputation");
                                continue;
                            }
                            reply.push(token+":");
                            const lnData = reputation[ChainSwapType.HTLC];
                            reply.push("   LN:");
                            reply.push("       successes: "+toDecimal(lnData.successVolume, tokenData.decimals)+" ("+lnData.successCount.toString(10)+" swaps)");
                            reply.push("       fails: "+toDecimal(lnData.failVolume, tokenData.decimals)+" ("+lnData.failCount.toString(10)+" swaps)");
                            reply.push("       coop closes: "+toDecimal(lnData.coopCloseVolume, tokenData.decimals)+" ("+lnData.coopCloseCount.toString(10)+" swaps)");

                            const onChainData = reputation[ChainSwapType.CHAIN];
                            reply.push("   On-chain:");
                            reply.push("       successes: "+toDecimal(onChainData.successVolume, tokenData.decimals)+" ("+onChainData.successCount.toString(10)+" swaps)");
                            reply.push("       fails: "+toDecimal(onChainData.failVolume, tokenData.decimals)+" ("+onChainData.failCount.toString(10)+" swaps)");
                            reply.push("       coop closes: "+toDecimal(onChainData.coopCloseVolume, tokenData.decimals)+" ("+onChainData.coopCloseCount.toString(10)+" swaps)");
                        }
                        return reply.join("\n");
                    }
                }
            ),
            createCommand(
                "airdrop",
                "Requests an airdrop of SOL tokens (only works on devnet!)",
                {
                    args: {},
                    parser: async (args, sendLine) => {
                        let signature = await this.signer.connection.requestAirdrop(this.signer.publicKey, 1500000000);
                        sendLine("Transaction sent, signature: "+signature+" waiting for confirmation...");
                        const latestBlockhash = await this.signer.connection.getLatestBlockhash();
                        await this.signer.connection.confirmTransaction(
                            {
                                signature,
                                ...latestBlockhash,
                            },
                            "confirmed"
                        );
                        return "Airdrop transaction confirmed!";
                    }
                }
            ),
            createCommand(
                "plugins",
                "Shows the list of loaded plugins",
                {
                    args: {},
                    parser: async (args, sendLine) => {
                        const reply: string[] = [];
                        reply.push("Loaded plugins:");
                        for(let [name, plugin] of PluginManager.plugins.entries()) {
                            reply.push("    - "+name+" : "+(plugin.description || "No description"));
                        }
                        if(reply.length===1) reply.push("   No loaded plugins");
                        return reply.join("\n");
                    }
                }
            ),
            createCommand(
                "geturl",
                "Returns the URL of the node (only works when SSL_AUTO mode is used)",
                {
                    args: {},
                    parser: async (args, sendLine) => {
                        if(IntermediaryConfig.SSL_AUTO==null) throw new Error("Node is not using SSL_AUTO mode for certificate provision!");
                        if(this.sslAutoUrl==null) throw new Error("Url not generated yet (node is still syncing?)");
                        return "Node url: "+this.sslAutoUrl;
                    }
                }
            ),
            createCommand(
                "register",
                "Registers the URL of the node to the public LP node registry (only works when SSL_AUTO mode is used)",
                {
                    args: {
                        mail: {
                            base: true,
                            description: "E-mail to use for the LP registration, if there is something wrong with your node we will contact you here (can be empty - \"\" to opt-out)!",
                            parser: cmdStringParser()
                        }
                    },
                    parser: async (args, sendLine) => {
                        if(IntermediaryConfig.SSL_AUTO==null) throw new Error("Node is not using SSL_AUTO mode for certificate provision!");
                        if(this.sslAutoUrl==null) throw new Error("Url not generated yet (node is still syncing?)");
                        const isRegistering = await this.lpRegistry.isRegistering();
                        if(isRegistering) {
                            const {status, url} = await this.lpRegistry.getRegistrationStatus();
                            return "LP registration status: "+status+"\nGithub PR: "+url;
                        } else {
                            const url = await this.lpRegistry.register(IntermediaryConfig.BITCOIND.NETWORK==="testnet", this.sslAutoUrl, args.mail==="" ? null : args.mail);
                            return "LP registration request created: "+url;
                        }
                    }
                }
            ),
            createCommand(
                "listswaps",
                "Lists all swaps in progress",
                {
                    args: {
                        quotes: {
                            base: false,
                            description: "Whether to also show issued quotes (not yet committed to swaps) - 0/1",
                            parser: cmdNumberParser(false, 0, 1, true)
                        }
                    },
                    parser: async (args, sendLine) => {
                        const swapData: string[] = [];
                        for(let swapHandler of this.swapHandlers) {
                            for(let _swap of await swapHandler.storageManager.query([])) {
                                const tokenData = this.addressesToTokens[_swap.data.getToken().toString()];
                                if(_swap.type===SwapHandlerType.TO_BTC) {
                                    const swap = _swap as ToBtcSwapAbs<T>;
                                    if(args.quotes!==1 && swap.state===ToBtcSwapState.SAVED) continue;
                                    const lines = [
                                        toDecimal(swap.data.getAmount(), tokenData.decimals)+" "+tokenData.ticker+" -> "+toDecimal(swap.amount, 8)+" BTC",
                                        "Payment hash: "+_swap.data.getHash(),
                                        "State: "+ToBtcSwapState[swap.state],
                                        "Swap fee: "+toDecimal(swap.swapFee, 8)+" BTC",
                                        "Network fee: "+toDecimal(swap.networkFee, 8)+" BTC",
                                        "Address: "+swap.address
                                    ];
                                    if(swap.txId!=null) {
                                        lines.push("Tx ID: "+swap.txId);
                                        lines.push("Paid network fee: "+toDecimal(swap.realNetworkFee, 8)+" BTC");
                                    }
                                    swapData.push(lines.join("\n"));
                                }
                                if(_swap.type===SwapHandlerType.TO_BTCLN) {
                                    const swap = _swap as ToBtcLnSwapAbs<T>;
                                    if(args.quotes!==1 && swap.state===ToBtcLnSwapState.SAVED) continue;
                                    const parsedPR = bolt11.decode(swap.pr);
                                    const sats = new BN(parsedPR.millisatoshis).div(new BN(1000));
                                    const lines = [
                                        toDecimal(swap.data.getAmount(), tokenData.decimals)+" "+tokenData.ticker+" -> "+toDecimal(sats, 8)+" BTC-LN",
                                        "Payment hash: "+_swap.data.getHash(),
                                        "State: "+ToBtcLnSwapState[swap.state],
                                        "Swap fee: "+toDecimal(swap.swapFee, 8)+" BTC-LN",
                                        "Network fee: "+toDecimal(swap.maxFee, 8)+" BTC-LN",
                                        "Invoice: "+swap.pr,
                                    ];
                                    if(swap.realRoutingFee!=null) {
                                        lines.push("Paid network fee: "+toDecimal(swap.realRoutingFee, 8)+" BTC-LN");
                                    }
                                    swapData.push(lines.join("\n"));
                                }
                                if(_swap.type===SwapHandlerType.FROM_BTC) {
                                    const swap = _swap as FromBtcSwapAbs<T>;
                                    if(args.quotes!==1 && swap.state===FromBtcSwapState.CREATED) continue;
                                    const lines = [
                                        toDecimal(swap.amount, 8)+" BTC -> "+toDecimal(swap.data.getAmount(), tokenData.decimals)+" "+tokenData.ticker,
                                        "Payment hash: "+_swap.data.getHash(),
                                        "State: "+FromBtcSwapState[swap.state],
                                        "Swap fee: "+toDecimal(swap.swapFee, 8)+" BTC",
                                        "Receiving address: "+swap.address
                                    ];
                                    swapData.push(lines.join("\n"));
                                }
                                if(_swap.type===SwapHandlerType.FROM_BTCLN) {
                                    const swap = _swap as FromBtcLnSwapAbs<T>;
                                    if(args.quotes!==1 && swap.state===FromBtcLnSwapState.CREATED) continue;
                                    const parsedPR = bolt11.decode(swap.pr);
                                    const sats = new BN(parsedPR.millisatoshis).div(new BN(1000));
                                    const lines = [
                                        toDecimal(sats, 8)+" BTC-LN -> "+toDecimal(swap.data.getAmount(), tokenData.decimals)+" "+tokenData.ticker,
                                        "Payment hash: "+_swap.data.getHash(),
                                        "State: "+FromBtcLnSwapState[swap.state],
                                        "Swap fee: "+toDecimal(swap.swapFee, 8)+" BTC-LN",
                                        "Receiving invoice: "+swap.pr
                                    ];
                                    swapData.push(lines.join("\n"));
                                }
                            }
                        }
                        return swapData.join("\n\n");
                    }
                }
            )
        ], IntermediaryConfig.CLI.ADDRESS, IntermediaryConfig.CLI.PORT, "Welcome to atomiq intermediary (LP node) CLI!");
    }

    async init() {
        await this.cmdHandler.init();
        await super.init();
        for(let plugin of PluginManager.plugins.values()) {
            if(plugin.getCommands!=null) {
                plugin.getCommands().forEach(cmd => this.cmdHandler.registerCommand(cmd));
            }
        }
    }

}