import * as fs from "fs/promises";

class StorageManager<T extends StorageObject> {

    private readonly directory: string;
    data: {
        [key: string]: T
    } = {};

    constructor(directory: string) {
        this.directory = directory;
    }

    async saveData(hash: Buffer, object: T): Promise<void> {

        try {
            await fs.mkdir(this.directory)
        } catch (e) {}

        this.data[hash.toString("hex")] = object;

        const cpy = object.serialize();

        await fs.writeFile(this.directory+"/"+hash.toString("hex")+".json", JSON.stringify(cpy));

    }

    async removeData(hash: Buffer): Promise<void> {
        const paymentHash = hash.toString("hex");
        try {
            if(this.data[paymentHash]!=null) delete this.data[paymentHash];
            await fs.rm(this.directory+"/"+paymentHash+".json");
        } catch (e) {
            console.error(e);
        }
    }

    async loadData(type: new(data: any) => T): Promise<T[]> {
        let files;
        try {
            files = await fs.readdir(this.directory);
        } catch (e) {
            console.error(e);
            return [];
        }

        const arr = [];

        for(let file of files) {
            const paymentHash = file.split(".")[0];
            const result = await fs.readFile(this.directory+"/"+file);
            const obj = JSON.parse(result.toString());
            const parsed = new type(obj);
            arr.push(parsed);
            this.data[paymentHash] = parsed;
        }

        return arr;
    }

}

export default StorageManager;