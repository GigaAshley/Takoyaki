import { listTodos } from '$lib/server/todos';
import type { PageServerLoad } from './$types';

// Reads for the page may call the app's logic directly — the same function
// GET /api/todos uses. Every change goes through the API (see +page.svelte).
export const load: PageServerLoad = () => ({ items: listTodos() });
