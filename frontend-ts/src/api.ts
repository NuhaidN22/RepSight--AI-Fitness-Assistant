import type { Exercise, FormResult, NewRoutine, NewSet, RepMetrics, Routine, WorkoutSet } from './types';

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/${path}`, init);
  } catch {
    throw new ApiError('Cannot reach the server. Is the backend running?', 0);
  }

  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { detail?: unknown };
      if (typeof body.detail === 'string') message = body.detail;
    } catch {
      // response had no JSON body; keep the generic message
    }
    throw new ApiError(message, res.status);
  }
  return (await res.json()) as T;
}

function jsonInit(method: 'POST' | 'DELETE', body?: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

export const api = {
  exercises: () => request<Exercise[]>('exercises'),
  sets: () => request<WorkoutSet[]>('sets'),
  addSet: (set: NewSet) => request<unknown>('sets', jsonInit('POST', set)),
  routines: () => request<Routine[]>('routines'),
  addRoutine: (routine: NewRoutine) => request<unknown>('routines', jsonInit('POST', routine)),
  deleteRoutine: (id: number) => request<unknown>(`routines/${id}`, jsonInit('DELETE')),
  analyzeForm: (exercise: string, reps: RepMetrics[]) =>
    request<FormResult>('form', jsonInit('POST', { exercise, reps })),
};