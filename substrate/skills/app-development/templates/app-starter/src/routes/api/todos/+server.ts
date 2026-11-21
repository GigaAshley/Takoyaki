import { z } from 'zod';
import { endpoint } from '$lib/server/api';
import { Todo, NewTodo, listTodos, createTodo } from '$lib/server/todos';

export const GET = endpoint({ summary: 'List todos, newest first', response: z.array(Todo) }, () => listTodos());

export const POST = endpoint(
    { summary: 'Add a todo', body: NewTodo, response: Todo, status: 201 },
    ({ body }) => createTodo(body)
);
