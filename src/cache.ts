import { Level } from 'level';

export interface ICache {
    init(): Promise<void>;
    shutdown(): Promise<void>;
    getOrInit<T>(type: string, key: string, init: () => Promise<T>, valueEncoding?: string): Promise<T>;
}

export class DummyCache implements ICache {
    async init() {}
    async shutdown() {}

    getOrInit<T>(_type: string, _key: string, init: () => Promise<T>, _valueEncoding?: string) {
        return init();
    }
}

export class Cache implements ICache {
    private db: Level;

    constructor(path: string) {
        this.db = new Level(path);
    }

    async init() {
        await this.db.open();
    }

    async shutdown() {
        await this.db.close();
    }

    async getOrInit<T>(type: string, key: string, init: () => Promise<T>, valueEncoding = 'json') {
        const formattedKey = this.formatKey(type, key);
        let value = await this.db.get(formattedKey, {
            valueEncoding
        }) as T;

        if (!value) {
            value = await init();
            await this.db.put(formattedKey, value, {
                valueEncoding
            });
        }

        return value;
    }

    private formatKey(type: string, key: string) {
        return `${type}:${key}`;
    }
}