import * as BN from "bn.js";
import {PublicKey} from "@solana/web3.js";
import {fromDecimal} from "../Utils";

export type ConfigParser<T> = (data: any) => T;

export type ConfigTemplate<T extends {[key: string]: any}> = {
    [key in keyof T]: ConfigParser<T[key]>
};

export type ParsedConfig<V, T extends ConfigTemplate<V>> = {
    [key in keyof T]: ReturnType<T[key]>
};

export const numberParser: (decimal: boolean, min?: number, max?: number, optional?: boolean) => ConfigParser<number>  = (decimal: boolean, min?: number, max?: number, optional?: boolean) => (data: any) => {
    if(data==null) {
        if(optional) {
            return null;
        } else {
            throw new Error("Data is null");
        }
    }
    if(typeof(data)!=="number") throw new Error("Invalid data, must be a number");
    if(!decimal && !Number.isInteger(data)) throw new Error("Invalid data, must be a whole number - integer");
    if(isNaN(data)) throw new Error("Number is NaN or null");
    if(min!=null && data<min) throw new Error("Number must be greater than "+min);
    if(max!=null && data>max) throw new Error("Number must be less than "+max);
    return data;
};

export const decimalToBNParser: (decimals: number, min?: number, max?: number, optional?: boolean) => ConfigParser<BN>  = (decimals: number, min?: number, max?: number, optional?: boolean) => (data: any) => {
    if(data==null) {
        if(optional) {
            return null;
        } else {
            throw new Error("Data is null");
        }
    }
    if(typeof(data)!=="number") throw new Error("Invalid data, must be a number");
    if(min!=null && data<min) throw new Error("Number must be greater than "+min);
    if(max!=null && data>max) throw new Error("Number must be less than "+max);
    if(isNaN(data)) throw new Error("Number is NaN or null");
    if(parseFloat(data.toFixed(decimals))!==data) throw new Error("Must have at most "+decimals+" decimal places!");

    const toPPM = fromDecimal(data.toFixed(decimals), decimals);
    return toPPM;
};

export const percentageToPpmParser: (min?: number, max?: number, optional?: boolean) => ConfigParser<BN>  = (min?: number, max?: number, optional?: boolean) => decimalToBNParser(4, min, max, optional);

export const bnParser: (min?: BN, max?: BN, optional?: boolean) => ConfigParser<BN>  = (min?: BN, max?: BN, optional?: boolean) => (data: any) => {
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

export function enumParser<T extends string>(possibleValues: T[], optional?: boolean): ConfigParser<T> {
    const set = new Set<string>(possibleValues);
    return (data: any) => {
        if(data==null) {
            if(optional) {
                return null;
            } else {
                throw new Error("Data is null");
            }
        }
        if(typeof(data)!=="string") throw new Error("Invalid data, must be string");
        if(!set.has(data)) throw new Error("Invalid enum value, possible values: "+possibleValues.join(", "));
        return data as T;
    };
}

export const stringParser: (minLength?: number, maxLength?: number, optional?: boolean) => ConfigParser<string> = (minLength?: number, maxLength?: number, optional?: boolean) => (data: any) => {
    if(data==null) {
        if(optional) {
            return null;
        } else {
            throw new Error("Data is null");
        }
    }
    if(typeof(data)!=="string") throw new Error("Invalid data, must be string");
    if(minLength!=null && data.length<minLength) throw new Error("Invalid string length, min length: "+minLength);
    if(maxLength!=null && data.length>maxLength) throw new Error("Invalid string length, max length: "+maxLength);
    return data;
};

export const publicKeyParser: (optional?: boolean) => ConfigParser<PublicKey> = (optional?: boolean) => (data: any) => {
    if(data==null) {
        if(optional) {
            return null;
        } else {
            throw new Error("Data is null");
        }
    }
    if(typeof(data)!=="string") throw new Error("Invalid data, must be string");
    return new PublicKey(data);
};

export const booleanParser: (optional?: boolean) => ConfigParser<boolean> = (optional?: boolean) => (data: any) => {
    if(data==null) {
        if(optional) {
            return null;
        } else {
            throw new Error("Data is null");
        }
    }
    if(typeof(data)!=="boolean") throw new Error("Invalid data, must be boolean - true/false");
    return data;
};

export function objectParser<T, V extends ConfigTemplate<T>>(template: V, validator?: (data: ParsedConfig<T, V>) => void, optional?: boolean): ConfigParser<ParsedConfig<T, V>>{
    return (data: any) => {
        if(data==null) {
            if(optional) {
                return null;
            } else {
                throw new Error("Data is null");
            }
        }
        if(typeof(data)!=="object") throw new Error("Data is not an object!");
        let obj: any = {};
        for(let key in template) {
            const value = data[key];
            try {
                const parsed = template[key](value);
                obj[key] = parsed;
            } catch (e) {
                throw new Error("Error parsing config, option: "+key+" error: "+e.message);
            }
        }
        if(validator!=null) validator(obj);
        return obj;
    };
}

export function arrayParser<T>(parser: ConfigParser<T>, optional?: boolean): ConfigParser<T[]>{
    return (data: any) => {
        if(data==null) {
            if(optional) {
                return null;
            } else {
                throw new Error("Data is null");
            }
        }
        if(!Array.isArray(data)) throw new Error("Data is not an array");
        return data.map(parser);
    };
}

export function dictionaryParser<T>(parser: ConfigParser<T>, validator?: (data: {[key: string]: T}) => void, optional?: boolean): ConfigParser<{[key: string]: T}>{
    return (data: any) => {
        if(data==null) {
            if(optional) {
                return null;
            } else {
                throw new Error("Data is null");
            }
        }
        if(typeof(data)!=="object") throw new Error("Data is not an object!");
        let obj: {[key: string]: T} = {};
        for(let key in data) {
            const value = data[key];
            try {
                const parsed = parser(value);
                obj[key] = parsed;
            } catch (e) {
                throw new Error("Error parsing config, option: "+key+" error: "+e.message);
            }
        }
        if(validator!=null) validator(obj);
        return obj;
    };
}

export function dictionaryParserWithKeys<K extends string, T>(parser: ConfigParser<T>, keys: K[], validator?: (data: {[key in K]: T}) => void, optional?: boolean): ConfigParser<{[key in K]: T}>{
    return (data: any) => {
        if(data==null) {
            if(optional) {
                return null;
            } else {
                throw new Error("Data is null");
            }
        }
        if(typeof(data)!=="object") throw new Error("Data is not an object!");
        let obj: any = {};
        for(let key of keys) {
            const value = data[key];
            try {
                const parsed = parser(value);
                obj[key] = parsed;
            } catch (e) {
                throw new Error("Error parsing config, option: "+key+" error: "+e.message);
            }
        }
        if(validator!=null) validator(obj);
        return obj;
    };
}

export function parseConfig<V, T extends ConfigTemplate<V>>(data: any, template: T): ParsedConfig<V, T> {
    let obj: any = {};
    for(let key in template) {
        const value = data[key];
        try {
            const parsed = template[key](value);
            obj[key] = parsed;
        } catch (e) {
            throw new Error("Error parsing config, option: "+key+" error: "+e.message);
        }
    }
    return obj;
}
