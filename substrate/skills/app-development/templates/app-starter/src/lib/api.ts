import { PANE_BASE } from '$lib/pane';

// Browser-side caller for the app's own /api routes — the same door agents
// use. Throws with the server's error message on any non-2xx.
export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${PANE_BASE}/api${path}`, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error ?? `${method} ${path} failed (${res.status})`);
    return data as T;
}
