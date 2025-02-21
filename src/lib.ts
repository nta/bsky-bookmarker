import { DummyCache, Cache } from './cache.js';
import type { ICache } from './cache.js';

import { CredentialManager, simpleFetchHandler, XRPC } from '@atcute/client';
import '@atcute/bluesky/lexicons';

import { DidDoc } from './diddoc.js';

import type { AppBskyFeedPost, AppBskyActorProfile, At } from '@atcute/client/lexicons';
import mime from 'mime';
import sharp from 'sharp';

export { ICache, DummyCache, Cache };

export class Configuration {
    discourseUrl: string;
    discourseTopic: string;
    userApiKey: string;
}

class Media {
    filename: string;
    data: Blob;
    alt?: string;
    type: 'image' | 'video' | 'avatar';
}


export class BskyBookmarker {
    private rpc: XRPC;
    private didPDSCache: Record<string, string> = {};

    constructor(private config: Configuration, private cache: ICache) {
        this.rpc = new XRPC({ handler: simpleFetchHandler({ service: 'https://api.bsky.app' }) });
    }

    async bookmark(input: string) {
        // taken from pdsls: https://github.com/notjuliet/pdsls/blob/6e103cc3c97ef995a8882bc7ee9cf0528e5763d3/src/main.tsx#L46
        const uri = input
            .replace("at://", "")
            .replace("https://bsky.app/profile/", "")
            .replace("https://main.bsky.dev/profile/", "")
            .replace("/post/", "/app.bsky.feed.post/");
        const uriParts = uri.split("/");

        if (uriParts.length < 2) {
            throw new Error('invalid url');
        }

        if (uriParts[1] !== 'app.bsky.feed.post') {
            throw new Error('not a post');
        }

        const actor = uriParts[0];
        const did = actor.startsWith('did:') ? (actor as At.DID) : await this.resolveHandle(actor);
        const rawUrl = `https://bsky.app/profile/${did}/post/${uriParts[2]}`;

        const profile = await this.cache.getOrInit('profile', did, () => this.rpc.get('app.bsky.actor.getProfile', {
            params: {
                actor: did
            }
        }));

        const rawProfileResult = await this.cache.getOrInit('rawProfile', did, () => this.rpc.get('com.atproto.repo.getRecord', {
            params: {
                repo: did,
                collection: 'app.bsky.actor.profile',
                rkey: 'self',
            }
        }));

        const rawProfile = rawProfileResult.data.value as AppBskyActorProfile.Record;

        const { data } = await this.cache.getOrInit('post', uriParts.join('/'), () => this.rpc.get('com.atproto.repo.getRecord', {
            params: {
                repo: did,
                collection: uriParts[1],
                rkey: uriParts[2],
            }
        }));

        const media: Media[] = [];

        const formatBlob = async (atBlob: At.Blob) => {
            const blob = await this.getBlob(atBlob, did);
            const mimeType = atBlob.mimeType;
            return {
                filename: `${atBlob.ref.$link}.${mime.getExtension(mimeType)}`,
                data: new Blob([blob], { type: mimeType }),
            };
        };

        const post = data.value as AppBskyFeedPost.Record;
        if (post.embed) {
            await processEmbed(post.embed);
        }

        async function processEmbed(embed: typeof post.embed) {
            if (embed.$type === 'app.bsky.embed.images') {
                for (const image of embed.images) {
                    media.push({
                        ...await formatBlob(image.image),
                        alt: image.alt,
                        type: 'image',
                    });
                }
            } else if (embed.$type === 'app.bsky.embed.video') {
                media.push({
                    ...await formatBlob(embed.video),
                    alt: embed.alt,
                    type: 'video',
                });
            } else if (embed.$type === 'app.bsky.embed.recordWithMedia') {
                await processEmbed(embed.media);
            }
        }

        if (rawProfile.avatar) {
            const blob = await this.getBlob(rawProfile.avatar, did);
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

            const result = await fetch(`${this.config.discourseUrl}/uploads.json`, {
                headers: {
                    'User-Api-Key': this.config.userApiKey
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
        request.append('topic_id', this.config.discourseTopic);
        request.append('raw', postBody);
        request.append('nested_post', 'true');

        const result = await fetch(`${this.config.discourseUrl}/posts.json`, {
            headers: {
                'User-Api-Key': this.config.userApiKey
            },
            body: request,
            method: 'POST',
        });

        const json = await result.json();
        return {
            url: `${this.config.discourseUrl}/p/${json.post.id}`,
            post: json,
        };
    }

    private async getBlob(blob: At.Blob, did: At.DID) {
        return await this.cache.getOrInit('blob', blob.ref.$link, async () => {
            const pds = await this.getPDS(did);
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
    private async resolveHandle(handle: string) {
        return await this.cache.getOrInit('did', handle, async () => {
            const rpc = new XRPC({
                handler: new CredentialManager({ service: "https://public.api.bsky.app" }),
            });
            const res = await rpc.get("com.atproto.identity.resolveHandle", {
                params: { handle: handle },
            });
            return res.data.did;
        });
    };

    private async getPDS(did: string) {
        if (did in this.didPDSCache) return this.didPDSCache[did];

        // TODO: these ought to expire
        return await this.cache.getOrInit('pds', did, async () => {
            const res = await fetch(
                did.startsWith("did:web") ?
                    `https://${did.split(":")[2]}/.well-known/did.json`
                    : "https://plc.directory/" + did,
            );

            return res.json().then((doc: DidDoc) => {
                for (const service of doc.service) {
                    if (service.id === "#atproto_pds") {
                        this.didPDSCache[did] = service.serviceEndpoint;
                        return service.serviceEndpoint;
                    }
                }
            });
        });
    }
}