import * as cors from "cors";
import * as BN from "bn.js";
import * as bitcoin from "bitcoinjs-lib";
import * as lncli from "ln-service";
import LND from "../btc/LND";
import StorageManager from "../StorageManager";
import {FromBtcLnSwap} from "../frombtcln/FromBtcLnSwap";
import {Express} from "express";
import * as express from "express";
import SolEvents, {EventObject} from "../sol/SolEvents";

const HEX_REGEX = /[0-9a-fA-F]+/;

const CONFIRMATIONS = 3;
const SWAP_CSV_DELTA = 72; //Half a day
const HTLC_SWEEP_VBYTES = 140;

const REFUND_CHECK_INTERVAL = 15*60*1000;

class FromBtc {

    storageManager: StorageManager<FromBtcLnSwap>;
    restPort: number;
    restServer: Express;

    constructor(storageDirectory: string, restPort: number) {
        this.storageManager = new StorageManager<FromBtcLnSwap>(storageDirectory);
        this.restPort = restPort;
    }

    async processEvent(eventData: EventObject): Promise<boolean> {
        const {events, instructions} = eventData;

        return true;
    }

    startRestServer() {
        this.restServer = express();
        this.restServer.use(cors());
        this.restServer.use(express.json());

        this.restServer.post("/createInvoice", async (req, res) => {

        });

        this.restServer.listen(this.restPort);

        console.log("[From BTC-LN: REST] Started on port: ", this.restPort);
    }

    subscribeToEvents() {
        SolEvents.registerListener(this.processEvent.bind(this));

        console.log("[From BTC-LN: Solana.Events] Subscribed to Solana events");
    }


}