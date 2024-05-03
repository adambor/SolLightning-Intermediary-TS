import {Client, directory, crypto} from "acme-client";
import * as fs from "fs/promises";
import {createServer, Server} from "node:http";

export class LetsEncryptACME {

    readonly hostname: string;
    readonly keyFile: string;
    readonly certFile: string;
    readonly listenPort: number;
    readonly renewInterval: number;

    renewCallback: (key: Buffer, cert: Buffer) => void;
    client: Client;

    constructor(hostname: string, keyFile: string, certFile: string, listenPort: number = 80, renewInterval: number = 7*24*60*60*1000) {
        this.hostname = hostname;
        this.keyFile = keyFile;
        this.certFile = certFile;
        this.listenPort = listenPort;
        this.renewInterval = renewInterval;
    }

    async init(renewCallback: (key: Buffer, cert: Buffer) => void) {
        this.renewCallback = renewCallback;

        this.client = new Client({
            directoryUrl: directory.letsencrypt.staging,
            accountKey: await crypto.createPrivateKey()
        });

        const existingKey = await fs.readFile(this.keyFile).catch(e => null);
        const existingCert = await fs.readFile(this.certFile).catch(e => null);

        const promise = this.renewOrCreate();

        if(existingKey==null || existingCert==null) {
            await promise;
        } else {
            promise.catch(e => {
                console.log("Certificate renewal error: ", e);
                console.error(e);
            });
            if(this.renewCallback!=null) this.renewCallback(existingKey, existingCert);
        }

        setInterval(() => this.renewOrCreate().catch(e => {
            console.log("Certificate renewal error: ", e);
            console.error(e);
        }), this.renewInterval);
    }

    async renewOrCreate() {
        console.log("[ACME]: Renew or create cert...");
        const existingKey = await fs.readFile(this.keyFile).catch(e => null);
        if(existingKey==null) console.log("[ACME]: Creating new CSR key!");

        const [key, csr] = await crypto.createCsr({
            commonName: this.hostname
        }, existingKey);

        let httpServer: Server;

        if(existingKey==null) console.log("[ACME]: Requesting certificate!");

        const cert = await this.client.auto({
            csr,
            // email: 'test@example.com',
            termsOfServiceAgreed: true,
            challengePriority: ['http-01'],
            challengeCreateFn: (authz, challenge, keyAuthorization) => {
                httpServer = createServer((req, res) => {
                    if (req.url.match(/\/\.well-known\/acme-challenge\/.+/)) {
                        const token = req.url.split('/').pop();
                        console.log(`[ACME]: Received challenge request for token=${token}`);

                        if(token!==challenge.token) {
                            res.writeHead(404);
                            res.end();
                            return;
                        }

                        res.writeHead(200);
                        res.end(keyAuthorization);
                        return;
                    }

                    /* HTTP 302 redirect */
                    res.writeHead(302, { Location: `https://${req.headers.host}${req.url}` });
                    res.end();
                });

                return new Promise<void>((resolve, reject) => {
                    httpServer.listen(this.listenPort, resolve)
                })
            },
            challengeRemoveFn: (authz, challenge) => {
                if(httpServer==null) return Promise.resolve();
                return new Promise<void>((resolve, reject) => httpServer.close(err => err==null ? resolve() : reject(err)));
            }
        });

        console.log("[ACME]: Certificate request success!");

        const certBuffer = Buffer.from(cert);
        await fs.writeFile(this.keyFile, key);
        await fs.writeFile(this.certFile, certBuffer);

        console.log("[ACME]: Key & certificate written to the disk!");

        if(this.renewCallback!=null) this.renewCallback(key, certBuffer);
    }

}