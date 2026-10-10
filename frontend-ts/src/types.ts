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