import { Cache } from './cache.js';
import { configDotenv } from 'dotenv';
import envPaths from 'env-paths';
import path from 'node:path';
import { BskyBookmarker } from './lib.js';

const paths = envPaths('bsky-bookmarker');

const ENV_PATH = path.join(paths.config, '.env');

configDotenv({
    path: ENV_PATH
});

const input = process.argv[2];
const cache = new Cache(path.join(paths.cache, 'ldb'));

const USER_API_KEY = process.env.DISCOURSE_USER_KEY;
const DISCOURSE_URL = process.env.DISCOURSE_URL;
const DISCOURSE_TOPIC = process.env.DISCOURSE_TOPIC;

await cache.init();

await (async () => {
    if (!USER_API_KEY || !DISCOURSE_TOPIC || !DISCOURSE_URL) {
        console.log('this thing is not configured! you should probably set up environment variables');
        console.log(`for example,\n`
            + `  mkdir -p '${path.dirname(ENV_PATH)}'\n`
            + `  cp '${path.normalize(path.join(import.meta.dirname, '../.env.sample'))}' '${ENV_PATH}'\n\n`
            + `and then edit the .env file as needed~`);

        return;
    }

    // reaaalllyyyy
    if (USER_API_KEY === '00000000000000000000000000000000') {
        console.log(`USER_API_KEY is still not configured!! edit ${path.dirname(ENV_PATH)} maybe~`);
        return;
    }

    if (!input) {
        console.error('no argument passed!?');
        return;
    }

    const bookmarker = new BskyBookmarker({
        discourseUrl: DISCOURSE_URL,
        discourseTopic: DISCOURSE_TOPIC,
        userApiKey: USER_API_KEY,
    }, cache);

    const result = await bookmarker.bookmark(input);
    console.log(result.url);
})();

await cache.shutdown();