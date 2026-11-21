import { z } from 'zod';
import { endpoint } from '$lib/server/api';
import { Todo, TodoPatch, updateTodo, deleteTodo } from '$lib/server/todos';

const params = z.object({ id: z.coerce.number().int() });

export const PATCH = endpoint(
    { summary: 'Change a todo’s text or mark it done/undone', params, body: TodoPatch, response: Todo },
    ({ params, body }) => updateTodo(params.id, body)
);

export const DELETE = endpoint(
    { summary: 'Remove a todo; returns what was removed', params, response: Todo },
    ({ params }) => deleteTodo(params.id)
);
