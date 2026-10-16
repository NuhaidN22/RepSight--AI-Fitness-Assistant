import type {
  DashboardData,
  Exercise,
  FormResult,
  NewRoutine,
  NewSet,
  Photo,
  PhotoAnalysis,
  PhotoUploadResult,
  RepMetrics,
  Routine,
  SummaryResult,
  WorkoutSet,
} from './types';

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

const OFFLINE = 'Cannot reach the server. Is the backend running?';

/** FastAPI puts a human-readable message in `detail` when it rejects a request. */
async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: unknown };
    if (typeof body.detail === 'string') return body.detail;
  } catch {
    // response had no JSON body; fall through to the generic message
  }
  return `Request failed (${res.status})`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/${path}`, init);
  } catch {
    throw new ApiError(OFFLINE, 0);
  }
  if (!res.ok) throw new ApiError(await errorMessage(res), res.status);
  return (await res.json()) as T;
}

function jsonInit(method: 'POST' | 'DELETE', body?: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

/**
 * The coach replies as a plain-text stream. We read it chunk by chunk and hand
 * every piece to `onChunk` so the UI can show the answer as it is written.
 * Aborting through `signal` rejects with a DOMException named "AbortError".
 */
export async function streamCoach(message: string, onChunk: (chunk: string) => void, signal: AbortSignal): Promise<void> {
  let res: Response;
  try {
    res = await fetch('/api/coach', { ...jsonInit('POST', { message }), signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(OFFLINE, 0);
  }
  if (!res.ok || !res.body) throw new ApiError(await errorMessage(res), res.status);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onChunk(decoder.decode(value, { stream: true })); // stream:true keeps multi-byte characters intact across chunks
  }
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

  dashboard: () => request<DashboardData>('dashboard'),
  addMetrics: (weight: number, height: number | null) => request<unknown>('metrics', jsonInit('POST', { weight, height })),
  summary: () => request<SummaryResult>('summary'),
  deleteAllData: () => request<unknown>('data', jsonInit('DELETE')),

  photos: () => request<Photo[]>('photos'),
  uploadPhoto: (file: File, taken: string) => {
    const form = new FormData();
    form.append('file', file);
    form.append('taken', taken);
    return request<PhotoUploadResult>('photos', { method: 'POST', body: form }); // no JSON header: the browser sets the multipart boundary
  },
  deletePhoto: (id: number) => request<unknown>(`photos/${id}`, jsonInit('DELETE')),
  deleteAllPhotos: () => request<unknown>('photos', jsonInit('DELETE')),
  analyzePhotos: (beforeId: number, afterId: number) =>
    request<PhotoAnalysis>('photos/analyze', jsonInit('POST', { before_id: beforeId, after_id: afterId })),
};
