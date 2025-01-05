import { Level } from 'level';

export class Cache {
    private db = new Level('cache');

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