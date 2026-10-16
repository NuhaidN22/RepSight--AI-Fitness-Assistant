export interface Exercise {
  name: string;
}

export interface WorkoutSet {
  date: string;
  exercise: string;
  reps: number;
  weight: number;
}

export interface NewSet {
  exercise: string;
  reps: number;
  weight: number;
  rpe: number | null;
}

export interface RoutineItem {
  exercise: string;
  sets: number;
  reps: number;
}

export interface Routine {
  id: number;
  name: string;
  items: RoutineItem[];
}

export interface NewRoutine {
  name: string;
  items: RoutineItem[];
}

export interface RepMetrics {
  min_knee_angle: number;
  depth_ok: 0 | 1;
  torso_ok: 0 | 1;
  max_torso_lean: number;
  tempo_s: number;
}

export interface FormResult {
  score: number;
  rep_count: number;
  summary: string;
}

export interface PrEntry {
  exercise: string;
  weight: number;
}

export interface DashboardData {
  weekly_volume: number;
  prs: PrEntry[];
  bmi?: number | null;
  plateau?: boolean;
  weight: { date: string; weight: number }[];
  form: { date: string; score: number }[];
}

export interface SummaryResult {
  summary: string;
}

export interface Photo {
  id: number;
  date: string;
  path: string;
}

export interface PhotoUploadResult {
  id?: number;
}

export interface PhotoAnalysis {
  caption?: string;
  detail?: string;
}
