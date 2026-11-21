import { z } from 'zod';
import { desc, eq } from 'drizzle-orm';
import { db } from './db';
import { todos, type Todo as TodoRow } from './db/schema';
import { ApiError } from './api';

// The app's logic lives here, below the routes. API routes call it; page
// load functions may call it for reads. Nothing else touches the database.

export const Todo = z.object({
    id: z.number().int(),
    text: z.string(),
    done: z.boolean(),
    createdAt: z.iso.datetime()
});
export type Todo = z.infer<typeof Todo>;

export const NewTodo = z.object({ text: z.string().trim().min(1, 'text is required') });
export const TodoPatch = z.object({ text: z.string().trim().min(1).optional(), done: z.boolean().optional() });

function toApi(row: TodoRow): Todo {
    return { id: row.id, text: row.text, done: row.done, createdAt: row.createdAt.toISOString() };
}

export function listTodos(): Todo[] {
    return db.select().from(todos).orderBy(desc(todos.createdAt)).all().map(toApi);
}

export function createTodo(input: z.infer<typeof NewTodo>): Todo {
    return toApi(db.insert(todos).values({ text: input.text }).returning().get());
}

export function updateTodo(id: number, patch: z.infer<typeof TodoPatch>): Todo {
    const row = db.update(todos).set(patch).where(eq(todos.id, id)).returning().get();
    if (!row) throw new ApiError(404, `todo ${id} not found`);
    return toApi(row);
}

export function deleteTodo(id: number): Todo {
    const row = db.delete(todos).where(eq(todos.id, id)).returning().get();
    if (!row) throw new ApiError(404, `todo ${id} not found`);
    return toApi(row);
}
