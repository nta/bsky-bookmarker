import { Cache } from './cache.js';

import { CredentialManager, simpleFetchHandler, XRPC } from '@atcute/client';
import '@atcute/bluesky/lexicons';

import { DidDoc } from './types.js';

import type { AppBskyFeedPost, AppBskyActorProfile, At } from '@atcute/client/lexicons';
import mime from 'mime';
import sharp from 'sharp';
import { configDotenv } from 'dotenv';
import envPaths from 'env-paths';
import path from 'node:path';

const paths = envPaths('bsky-bookmarker');

const ENV_PATH = path.join(paths.config, '.env');

configDotenv({
    path: ENV_PATH
});

const input = process.argv[2];
const cache = new Cache(path.join(paths.cache, 'ldb'));
const didPDSCache: Record<string, string> = {};

const USER_API_KEY = process.env.DISCOURSE_USER_KEY;
const DISCOURSE_URL = process.env.DISCOURSE_URL;
const DISCOURSE_TOPIC = process.env.DISCOURSE_TOPIC;

await cache.init();

class Media {
    filename: string;
    data: Blob;
    alt?: string;
    type: 'image' | 'video' | 'avatar';
}

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

    const rpc = new XRPC({ handler: simpleFetchHandler({ service: 'https://api.bsky.app' }) });

    if (!input) {
        console.error('no argument passed!?');
        return;
    }

    // taken from pdsls: https://github.com/notjuliet/pdsls/blob/6e103cc3c97ef995a8882bc7ee9cf0528e5763d3/src/main.tsx#L46
    const uri = input
        .replace("at://", "")
        .replace("https://bsky.app/profile/", "")
        .replace("https://main.bsky.dev/profile/", "")
        .replace("/post/", "/app.bsky.feed.post/");
    const uriParts = uri.split("/");

    if (uriParts.length < 2) {
        console.log('invalid url');
        return;
    }

    if (uriParts[1] !== 'app.bsky.feed.post') {
        console.log('not a post');
        return;
    }

    const actor = uriParts[0];
    const did = actor.startsWith('did:') ? (actor as At.DID) : await resolveHandle(actor);
    const rawUrl = `https://bsky.app/profile/${did}/post/${uriParts[2]}`;

    const profile = await cache.getOrInit('profile', did, () => rpc.get('app.bsky.actor.getProfile', {
        params: {
            actor: did
        }
    }));

    const rawProfileResult = await cache.getOrInit('rawProfile', did, () => rpc.get('com.atproto.repo.getRecord', {
        params: {
            repo: did,
            collection: 'app.bsky.actor.profile',
            rkey: 'self',
        }
    }));

    const rawProfile = rawProfileResult.data.value as AppBskyActorProfile.Record;

    const { data } = await cache.getOrInit('post', uriParts.join('/'), () => rpc.get('com.atproto.repo.getRecord', {
        params: {
            repo: did,
            collection: uriParts[1],
            rkey: uriParts[2],
        }
    }));

    const media: Media[] = [];

    const formatBlob = async (atBlob: At.Blob) => {
        const blob = await getBlob(atBlob, did);
        const mimeType = atBlob.mimeType;
        return {
            filename: `${atBlob.ref.$link}.${mime.getExtension(mimeType)}`,
            data: new Blob([blob], { type: mimeType }),
        };
    };

    const post = data.value as AppBskyFeedPost.Record;
    if (post.embed) {
        if (post.embed.$type === 'app.bsky.embed.images') {
            for (const image of post.embed.images) {
                media.push({
                    ...await formatBlob(image.image),
                    alt: image.alt,
                    type: 'image',
                });
            }
        } else if (post.embed.$type === 'app.bsky.embed.video') {
            media.push({
                ...await formatBlob(post.embed.video),
                alt: post.embed.alt,
                type: 'video',
            });
        }
    }

    if (rawProfile.avatar) {
        const blob = await getBlob(rawProfile.avatar, did);
        // discourse doesn't likeeee >100x100 images when inlineeed
        // https://github.com/discourse/discourse/blob/8be29694ecb8ecb93028ab4869d0f9d8834eb47e/lib/cooked_post_processor.rb#L271

        const smallAvatar = await sharp(blob)
            .resize(96, 96)
            .webp({ lossless: true })
            .toBuffer();

        media.push({
            data: new Blob([smallAvatar], { type: 'image/webp' }),
            filename: 'avatar.webp',
            type: 'avatar',
        });
    }

    const uploads = [];
    let avatar = '';

    for (const file of media) {
        const body = new FormData();
        body.append('upload_type', 'composer');
        body.append('files[]', file.data, file.filename);

        const result = await fetch(`${DISCOURSE_URL}/uploads.json`, {
            headers: {
                'User-Api-Key': USER_API_KEY
            },
            body,
            method: 'POST',
        });

        const json = await result.json();

        if (file.type === 'avatar') {
            avatar = `![${profile.data.handle}|32x32](${json.short_url})`;
        } else {
            const thing = (file.type === 'video') ? 'video' : `${json.thumbnail_width}x${json.thumbnail_height}`;
            uploads.push(`![${file.alt}|${thing}](${json.short_url})`);
        }
    }

    const postBody = `${rawUrl}\n\n${uploads.join('\n')}` +
        ((post.text.length > 0) ? `\n[quote]\n${post.text}\n[/quote]` : ``) + '\n' +
        `-- ${avatar} [${rawProfile.displayName} (@${profile.data.handle})](https://bsky.app/profile/${did})`;

    const request = new FormData();
    request.append('topic_id', DISCOURSE_TOPIC);
    request.append('raw', postBody);
    request.append('nested_post', 'true');

    const result = await fetch(`${DISCOURSE_URL}/posts.json`, {
        headers: {
            'User-Api-Key': USER_API_KEY
        },
        body: request,
        method: 'POST',
    });

    const json = await result.json();
    console.log(`${DISCOURSE_URL}/p/${json.post.id}`);
})();

async function getBlob(blob: At.Blob, did: At.DID) {
    return await cache.getOrInit('blob', blob.ref.$link, async () => {
        const pds = await getPDS(did);
        const rpc = new XRPC({ handler: simpleFetchHandler({ service: pds }) });
        const data = await rpc.get('com.atproto.sync.getBlob', {
            params: {
                cid: blob.ref.$link,
                did: did,
            }
        });

        return data.data;
    }, 'view');
}

// also from pdsls: https://github.com/notjuliet/pdsls/blob/6e103cc3c97ef995a8882bc7ee9cf0528e5763d3/src/utils/api.ts#L27C1-L35C3
async function resolveHandle(handle: string) {
    return await cache.getOrInit('did', handle, async () => {
        const rpc = new XRPC({
            handler: new CredentialManager({ service: "https://public.api.bsky.app" }),
        });
        const res = await rpc.get("com.atproto.identity.resolveHandle", {
            params: { handle: handle },
        });
        return res.data.did;
    });
};

async function getPDS(did: string) {
    if (did in didPDSCache) return didPDSCache[did];

    // TODO: these ought to expire
    return await cache.getOrInit('pds', did, async () => {
        const res = await fetch(
            did.startsWith("did:web") ?
                `https://${did.split(":")[2]}/.well-known/did.json`
                : "https://plc.directory/" + did,
        );

        return res.json().then((doc: DidDoc) => {
            for (const service of doc.service) {
                if (service.id === "#atproto_pds") {
                    didPDSCache[did] = service.serviceEndpoint;
                    return service.serviceEndpoint;
                }
            }
        });
    });
}

await cache.shutdown();