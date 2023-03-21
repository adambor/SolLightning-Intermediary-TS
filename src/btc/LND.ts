import {authenticatedLndGrpc} from "lightning";

const {lnd: LND} = authenticatedLndGrpc({
    cert: process.env.LN_CERT,
    macaroon: process.env.LN_MACAROON,
    socket: process.env.LN_NODE_HOST+':'+process.env.LN_NODE_PORT,
});

export default LND;