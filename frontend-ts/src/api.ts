// api.ts - the ONLY file that knows how to talk to the FastAPI backend.
// Every screen imports functions from here instead of calling fetch() directly.

// Where the backend lives. Set VITE_API_URL in a .env file to override (Vite only).
// If this page is served BY the backend (port 8000), use "" so requests stay same-origin.
const fromEnv = (import.meta as any).env?.VITE_API_URL as string | undefined;
export const BASE: string = fromEnv ?? (location.port === "8000" ? "" : "http://localhost:8000");

// ---- Types: the shape of what the backend sends back ----
export interface Exercise { name: string; muscle: string }
export interface SetLog { id: number; date: string; exercise: string; reps: number; weight: number; rpe: number | null }
export interface Routine { id: number; name: string; items: { exercise: string; sets: number; reps: number }[] }
export interface Photo { id: number; date: string; path: string; caption: string }
export interface FormRep {
  depth_ok: 0 | 1; torso_ok: 0 | 1; tempo_s: number;          // required by the backend
  flags?: string[]; min_angle?: number; max_angle?: number;
  torso_lean?: number | null; elbow_drift?: number | null; body_line?: number | null;
}
export interface FormResult {
  score: number; summary: string; exercise: string; rep_count: number; depth_pct: number; torso_pct: number; avg_tempo_s: number;
  flags: Record<string, number>;                              // issue text -> number of reps it appeared in
}
export interface Dashboard {
  weekly_volume: number; prs: { exercise: string; weight: number }[];
  weight: { date: string; weight: number }[]; form: { date: string; score: number }[];
  plateau: boolean; bmi: number | null;
}

// ---- Core helpers ----
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}/api/${path}`, init);
  let body: any = null;
  try { body = await res.json(); } catch { /* empty or non-JSON body */ }
  if (!res.ok) {
    const d = body?.detail;                                     // FastAPI puts error text in "detail"
    throw new Error(typeof d === "string" ? d : d ? JSON.stringify(d) : `Request failed (${res.status})`);
  }
  return body as T;
}
const json = (method: string, data?: unknown): RequestInit => ({
  method, headers: { "Content-Type": "application/json" }, body: data === undefined ? undefined : JSON.stringify(data),
});

// ---- Endpoints ----
export const api = {
  exercises: () => request<Exercise[]>("exercises"),
  sets: (exercise?: string) => request<SetLog[]>(exercise ? `sets?exercise=${encodeURIComponent(exercise)}` : "sets"),
  addSet: (s: { exercise: string; reps: number; weight: number; rpe?: number | null }) => request<{ ok: true }>("sets", json("POST", s)),
  addMetrics: (weight: number, height?: number | null) => request<{ ok: true }>("metrics", json("POST", { weight, height })),
  dashboard: () => request<Dashboard>("dashboard"),
  summary: () => request<{ summary: string }>("summary"),
  routines: () => request<Routine[]>("routines"),
  addRoutine: (r: { name: string; items: Routine["items"] }) => request<{ ok: true }>("routines", json("POST", r)),
  deleteRoutine: (id: number) => request<{ ok: true }>(`routines/${id}`, json("DELETE")),
  saveForm: (exercise: string, reps: FormRep[]) => request<FormResult>("form", json("POST", { exercise, reps })),   // exercise is required: never default to squat
  identifyExercise: (frames: string[]) => request<{ exercise: string; raw: string }>("identify", json("POST", { frames })),
  photos: () => request<Photo[]>("photos"),
  uploadPhoto: (file: File, taken: string) => {
    const fd = new FormData(); fd.append("file", file); fd.append("taken", taken);
    return request<{ ok: true; id: number }>("photos", { method: "POST", body: fd }); // no Content-Type: browser adds the multipart boundary
  },
  deletePhoto: (id: number) => request<{ ok: true }>(`photos/${id}`, json("DELETE")),
  deleteAllPhotos: () => request<{ ok: true }>("photos", json("DELETE")),
  analyzePhotos: (before_id: number, after_id: number) => request<{ caption?: string; detail?: string }>("photos/analyze", json("POST", { before_id, after_id })),
  deleteAllData: () => request<{ ok: true }>("data", json("DELETE")),
};

// Photo paths come back as "/uploads/xyz.jpg" - prefix the backend address so <img> works from another origin.
export const photoUrl = (path: string) => BASE + path;

// The coach streams plain text, so it can't go through request<T>() (which waits for JSON).
export async function streamCoach(message: string, onChunk: (text: string) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(`${BASE}/api/coach`, { ...json("POST", { message }), signal });
  if (!res.ok || !res.body) throw new Error(`Coach request failed (${res.status})`);
  const reader = res.body.getReader(), dec = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onChunk(dec.decode(value, { stream: true }));               // stream:true keeps multi-byte characters intact across chunks
  }
}