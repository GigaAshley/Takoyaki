import { json, type RequestEvent, type RequestHandler } from '@sveltejs/kit';
import { z } from 'zod';

// One door for everyone: the app's own pages, the user's other agents and
// scripts all call the same /api routes. Each route is declared with
// `endpoint()` — zod schemas for what it takes and what it returns, plus a
// one-line summary. The same schemas validate every request, check every
// response, and generate /api/openapi.json, so the published contract can't
// drift from what the code does.

export class ApiError extends Error {
    constructor(
        public status: number,
        message: string
    ) {
        super(message);
    }
}

type Obj = z.ZodObject;
type In<S> = S extends z.ZodType ? z.output<S> : undefined;

export interface EndpointSpec<P extends Obj | undefined, Q extends Obj | undefined, B extends z.ZodType | undefined, R extends z.ZodType> {
    summary: string;
    description?: string;
    params?: P;
    query?: Q;
    body?: B;
    response: R;
    status?: number;
}

export type Endpoint = RequestHandler & { spec: EndpointSpec<Obj | undefined, Obj | undefined, z.ZodType | undefined, z.ZodType> };

export function endpoint<
    R extends z.ZodType,
    P extends Obj | undefined = undefined,
    Q extends Obj | undefined = undefined,
    B extends z.ZodType | undefined = undefined
>(
    spec: EndpointSpec<P, Q, B, R>,
    impl: (input: { params: In<P>; query: In<Q>; body: In<B>; event: RequestEvent }) => z.input<R> | Promise<z.input<R>>
): Endpoint {
    const handler: RequestHandler = async (event) => {
        try {
            const params = spec.params ? parse(spec.params, event.params, 'path') : undefined;
            const query = spec.query ? parse(spec.query, Object.fromEntries(event.url.searchParams), 'query') : undefined;
            let body: unknown;
            if (spec.body) {
                let raw: unknown;
                try {
                    raw = await event.request.json();
                } catch {
                    throw new ApiError(400, 'request body must be JSON');
                }
                body = parse(spec.body, raw, 'body');
            }
            const result = await impl({ params, query, body, event } as Parameters<typeof impl>[0]);
            return json(spec.response.parse(result), { status: spec.status ?? 200 });
        } catch (err) {
            if (err instanceof ApiError) return json({ error: err.message }, { status: err.status });
            console.error(`[api] ${event.request.method} ${event.url.pathname} failed`, err);
            return json({ error: 'internal error' }, { status: 500 });
        }
    };
    return Object.assign(handler, { spec }) as Endpoint;
}

function parse<S extends z.ZodType>(schema: S, value: unknown, where: string): z.output<S> {
    const result = schema.safeParse(value);
    if (!result.success) throw new ApiError(400, `invalid ${where}: ${z.prettifyError(result.error)}`);
    return result.data;
}
