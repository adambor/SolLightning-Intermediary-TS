
import {createServer, Server, Socket} from "net";
import * as minimist from "minimist";
import {createInterface} from "readline";
import * as BN from "bn.js";

export type ParamParser<T> = (data: string) => T;

export type ArgsTemplate<T extends { [key: string]: any }> = {
    [key in keyof T]: {
        base?: boolean,
        description: string,
        parser: ParamParser<T[key]>
    }
};

export type ParsedArgs<V, T extends ArgsTemplate<V>> = {
    [key in keyof T]: ReturnType<T[key]["parser"]>
};

export type CommandRuntime<T extends { [key: string]: any }> = {
    args: ArgsTemplate<T>,
    parser: (args: ParsedArgs<T, ArgsTemplate<T>>, sendLine: (line: string) => void) => Promise<string>
}

export type Command<T extends { [key: string]: any }> = {
    cmd: string,
    description: string,
    runtime: CommandRuntime<T>
};

export const cmdNumberParser: (decimal: boolean, min?: number, max?: number, optional?: boolean) => ParamParser<number>  = (decimal: boolean, min?: number, max?: number, optional?: boolean) => (data: string) => {
    if(data==null) {
        if(optional) {
            return null;
        } else {
            throw new Error("Data is null");
        }
    }
    let num: number = decimal ? parseFloat(data) : parseInt(data);
    if(num==null || isNaN(num)) throw new Error("Number is NaN or null");
    if(min!=null && num<min) throw new Error("Number must be greater than "+min);
    if(max!=null && num>max) throw new Error("Number must be less than "+max);
    return num;
};

export const cmdBNParser: (min?: BN, max?: BN, optional?: boolean) => ParamParser<BN>  = (min?: BN, max?: BN, optional?: boolean) => (data: string) => {
    if(data==null) {
        if(optional) {
            return null;
        } else {
            throw new Error("Data is null");
        }
    }
    let num: BN = new BN(data);
    if(num==null) throw new Error("Number is NaN or null");
    if(min!=null && num.lt(min)) throw new Error("Number must be greater than "+min.toString(10));
    if(max!=null && num.gt(max)) throw new Error("Number must be less than "+max.toString(10));
    return num;
};

export function cmdEnumParser<T extends string>(possibleValues: T[], optional?: boolean): ParamParser<T> {
    const set = new Set(possibleValues);
    return (data: string) => {
        if(data==null) {
            if(optional) {
                return null;
            } else {
                throw new Error("Data is null");
            }
        }
        if(!set.has(data as T)) throw new Error("Invalid enum value, possible values: "+possibleValues.join(", "));
        return data as T;
    };
};

export const cmdStringParser: (minLength?: number, maxLength?: number, optional?: boolean) => ParamParser<string> = (minLength?: number, maxLength?: number, optional?: boolean) => (data: string) => {
    if(data==null) {
        if(optional) {
            return null;
        } else {
            throw new Error("Data is null");
        }
    }
    if(minLength!=null && data.length<minLength) throw new Error("Invalid string length, min length: "+minLength);
    if(maxLength!=null && data.length>maxLength) throw new Error("Invalid string length, max length: "+maxLength);
    return data;
};

export function createCommand<T extends { [key: string]: any }>(cmd: string, description: string, runtime: CommandRuntime<T>): Command<T> {
    return { cmd, description, runtime };
}

export class CommandHandler {

    server: Server;

    readonly commands: {
        [key: string]: Command<any>
    };
    readonly listeningPort: number;
    readonly listeningAddress: string;

    constructor(
        commands: Command<any>[],
        listenAddress: string,
        listenPort: number
    ) {
        this.commands = {};
        commands.forEach(cmd => {
            this.commands[cmd.cmd] = cmd;
        });
        this.listeningAddress = listenAddress;
        this.listeningPort = listenPort;
    }


    async init() {
        this.server = createServer((socket) => {
            socket.write("Welcome to atomiq intermediary node interface...\n");
            socket.write("Type 'help' to get a summary of existing commands!\n> ");

            const rl = createInterface({input: socket});
            rl.on("line", (line) => {
                this.parseLine(line, socket).then(result => {
                    socket.write(result+"\n> ");
                }).catch(err => {
                    console.error(err);
                    socket.write("Error: "+(err.message!=null ? err.message : JSON.stringify(err))+"\n> ");
                });
            })
        });
        await new Promise<void>(resolve => this.server.listen(this.listeningPort, this.listeningAddress, () => {
            resolve();
        }));
    }

    getUsageString(cmd: Command<any>): string {
        const args = [];
        for(let key in cmd.runtime.args) {
            if (cmd.runtime.args[key].base) {
                args.push("<"+key+">");
            }
        }
        return cmd.cmd+" "+args.join(" ");
    }

    getParamsDescription(cmd: Command<any>): string[] {
        const params = [];
        for(let key in cmd.runtime.args) {
            params.push("--"+key+" : "+cmd.runtime.args[key].description);
        }
        return params;
    }

    getCommandHelp(cmd: Command<any>): string {
        const lines = [
            "Command: "+cmd.cmd,
            "Description: "+cmd.description,
            "Usage: "+this.getUsageString(cmd)
        ];

        const paramLines = this.getParamsDescription(cmd);
        if(paramLines.length!==0) lines.push("Params:");
        paramLines.forEach(param => {
            lines.push("    "+param);
        });

        return lines.join("\n");
    }

    getHelp(): string {
        const lines = ["Available commands:"];
        for(let key in this.commands) {
            lines.push("    "+key+" : "+this.commands[key].description);
        }
        lines.push("Use 'help <command name>' for usage examples, description & help around a specific command!");
        return lines.join("\n");
    }

    parseLine(line: string, socket: Socket): Promise<string> {
        if(line==="") return Promise.resolve("");
        const regex = new RegExp('"[^"]+"|[\\S]+', 'g');
        const args = [];
        line.match(regex).forEach(element => {
            if (!element) return;
            return args.push(element.replace(/"/g, ''));
        });
        const result = minimist(args);

        const commandText = result._[0];

        if(commandText==="help") {
            if(result._[1]!=null && this.commands[result._[1]]!=null) {
                return Promise.resolve(this.getCommandHelp(this.commands[result._[1]]));
            }
            return Promise.resolve(this.getHelp());
        }

        const cmd = this.commands[commandText];

        if(cmd==null) {
            return Promise.resolve("Error: Unknown command, please type 'help' to get a list of all commands!");
        }

        const paramsObj: any = {};

        let index = 1;
        for(let key in cmd.runtime.args) {
            if(cmd.runtime.args[key].base) {
                if(result[key]==null && result._[index]!=null) result[key] = result._[index];
                index++;
            }
            try {
                paramsObj[key] = cmd.runtime.args[key].parser(result[key]);
            } catch (e) {
                return Promise.resolve("Error: Parsing parameter '"+key+"': "+e.message+"\n\n"+this.getCommandHelp(cmd));
            }
        }

        return cmd.runtime.parser(paramsObj, (line: string) => socket.write(line+"\n"));
    }

}