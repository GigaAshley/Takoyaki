import { json } from '@sveltejs/kit';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import type { Endpoint } from '$lib/server/api';

// GET /api/openapi.json — the app's contract, built from every endpoint()
// under src/routes/api/. Agents read this first to learn what the app can do.
// Nothing to maintain here: add a route with endpoint() and it shows up.

const routes = import.meta.glob<Record<string, unknown>>(
    ['/src/routes/api/**/+server.ts', '!/src/routes/api/openapi.json/+server.ts'],
    { eager: true }
);

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

function toPath(file: string): string {
    const p = file
        .replace(/^\/src\/routes/, '')
        .replace(/\/\+server\.ts$/, '')
        .replace(/\/\([^)]+\)/g, '')
        .replace(/\[\[?(?:\.\.\.)?([^\]=]+)(?:=[^\]]+)?\]?\]/g, '{$1}');
    return p || '/';
}

const schema = (s: z.ZodType, io: 'input' | 'output') =>
    tidy(z.toJSONSchema(s, { io, unrepresentable: 'any' }));

// Drop zod's noise so the document reads cleanly: per-node $schema,
// safe-integer bounds on every int, and the long regex behind date-time.
function tidy(node: unknown): any {
    if (Array.isArray(node)) return node.map(tidy);
    if (!node || typeof node !== 'object') return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
        if (k === '$schema') continue;
        if (k === 'pattern' && 'format' in node) continue;
        if ((k === 'minimum' || k === 'maximum') && Math.abs(v as number) === Number.MAX_SAFE_INTEGER) continue;
        out[k] = tidy(v);
    }
    return out;
}

function meta() {
    for (const name of ['app.json', 'app.json.pending']) {
        try {
            return JSON.parse(fs.readFileSync(path.join(process.cwd(), name), 'utf8'));
        } catch {}
    }
    return {};
}

function build() {
    const paths: Record<string, Record<string, unknown>> = {};
    for (const [file, mod] of Object.entries(routes)) {
        for (const method of METHODS) {
            const h = mod[method] as Endpoint | undefined;
            if (!h?.spec) continue;
            const { spec } = h;
            const parameters = [
                ...Object.entries(spec.params?.shape ?? {}).map(([name, s]) => ({
                    name, in: 'path', required: true, schema: schema(s as z.ZodType, 'input')
                })),
                ...Object.entries(spec.query?.shape ?? {}).map(([name, s]) => ({
                    name, in: 'query', required: !(s as z.ZodType).safeParse(undefined).success,
                    schema: schema(s as z.ZodType, 'input')
                }))
            ];
            (paths[toPath(file)] ??= {})[method.toLowerCase()] = {
                summary: spec.summary,
                ...(spec.description && { description: spec.description }),
                ...(parameters.length && { parameters }),
                ...(spec.body && {
                    requestBody: { required: true, content: { 'application/json': { schema: schema(spec.body, 'input') } } }
                }),
                responses: {
                    [String(spec.status ?? 200)]: {
                        description: 'OK',
                        content: { 'application/json': { schema: schema(spec.response, 'output') } }
                    },
                    default: {
                        description: 'Error',
                        content: { 'application/json': { schema: { type: 'object', properties: { error: { type: 'string' } }, required: ['error'] } } }
                    }
                }
            };
        }
    }
    const m = meta();
    return {
        openapi: '3.1.0',
        info: { title: m.title ?? 'App', ...(m.description && { description: m.description }), version: '1' },
        paths
    };
}

export const GET = () => json(build());
