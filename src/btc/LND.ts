import {AuthenticatedLnd, authenticatedLndGrpc, UnauthenticatedLnd, unauthenticatedLndGrpc} from "lightning";
import {IntermediaryConfig} from "../IntermediaryConfig";
import * as fs from "fs";

export function getAuthenticatedLndGrpc(): AuthenticatedLnd {
    let cert: string = IntermediaryConfig.LND.CERT;
    if(IntermediaryConfig.LND.CERT_FILE!=null) {
        if(!fs.existsSync(IntermediaryConfig.LND.CERT_FILE)) throw new Error("Certificate file not found!");
        cert = fs.readFileSync(IntermediaryConfig.LND.CERT_FILE).toString("base64");
    }

    let macaroon: string = IntermediaryConfig.LND.MACAROON;
    if(IntermediaryConfig.LND.MACAROON_FILE!=null) {
        if(!fs.existsSync(IntermediaryConfig.LND.MACAROON_FILE)) throw new Error("Macaroon file not found!");
        macaroon = fs.readFileSync(IntermediaryConfig.LND.MACAROON_FILE).toString("base64");
    }

    const {lnd: LND} = authenticatedLndGrpc({
        cert,
        macaroon,
        socket: IntermediaryConfig.LND.HOST+':'+IntermediaryConfig.LND.PORT,
    });

    return LND;
}

export function getUnauthenticatedLndGrpc(): UnauthenticatedLnd {
    let cert: string = IntermediaryConfig.LND.CERT;
    if(IntermediaryConfig.LND.CERT_FILE!=null) {
        if(!fs.existsSync(IntermediaryConfig.LND.CERT_FILE)) throw new Error("Certificate file not found!");
        cert = fs.readFileSync(IntermediaryConfig.LND.CERT_FILE).toString("base64");
    }

    const {lnd: UnauthenticatedLND} = unauthenticatedLndGrpc({
        cert,
        socket: IntermediaryConfig.LND.HOST+':'+IntermediaryConfig.LND.PORT,
    });

    return UnauthenticatedLND;
}
