// repCounter.ts - exercise-agnostic rep counting from pose landmarks.
// The pose model (MediaPipe) only reports WHERE body joints are. Deciding what counts as a rep is
// our job, and it depends on the exercise: a squat bends the knee, a deadlift/RDL bends the hip,
// a push-up or curl bends the elbow. Each exercise below says which joint angle to watch.
// MediaPipe indices: 11/12 shoulders, 13/14 elbows, 15/16 wrists, 23/24 hips, 25/26 knees, 27/28 ankles.
// All thresholds are starting estimates, NOT validated - tune them on real videos.
export const EXERCISES = {
    squat: { key: "squat", label: "Squat", joints: { left: [23, 25, 27], right: [24, 26, 28] }, home: "extended", extendedAbove: 160, flexedBelow: 125, target: 100 },
    hinge: { key: "hinge", label: "Deadlift / RDL", joints: { left: [11, 23, 25], right: [12, 24, 26] }, home: "extended", extendedAbove: 160, flexedBelow: 125, target: 110 },
    pushup: { key: "pushup", label: "Push-up", joints: { left: [11, 13, 15], right: [12, 14, 16] }, home: "extended", extendedAbove: 150, flexedBelow: 110, target: 95 },
    curl: { key: "curl", label: "Biceps curl", joints: { left: [11, 13, 15], right: [12, 14, 16] }, home: "extended", extendedAbove: 145, flexedBelow: 75, target: 60 },
    raise: { key: "raise", label: "Dumbbell raise", joints: { left: [23, 11, 13], right: [24, 12, 14] }, home: "flexed", extendedAbove: 70, flexedBelow: 35, target: 80 }, // shoulder angle: arm down ~20, shoulder height ~90
    chestpress: { key: "chestpress", label: "Chest press", joints: { left: [11, 13, 15], right: [12, 14, 16] }, home: "flexed", extendedAbove: 150, flexedBelow: 105, target: 160 }, // pressing away from the chest: rest = elbows bent, rep = arms pushed out
    press: { key: "press", label: "Overhead press", joints: { left: [11, 13, 15], right: [12, 14, 16] }, home: "flexed", extendedAbove: 160, flexedBelow: 100, target: 165 },
};
// Angle at vertex b between rays b->a and b->c. x is multiplied by `aspect` (video width/height)
// because x and y are fractions of DIFFERENT pixel lengths; without it, angles are skewed.
export function angleAt(a, b, c, aspect = 1) {
    const v1 = { x: (a.x - b.x) * aspect, y: a.y - b.y }, v2 = { x: (c.x - b.x) * aspect, y: c.y - b.y };
    const cos = (v1.x * v2.x + v1.y * v2.y) / ((Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y)) || 1);
    return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}
// Same angle from MediaPipe WORLD landmarks: real 3D metres, so camera angle and foreshortening do not matter.
export function angle3(a, b, c) {
    const v1 = [a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0)], v2 = [c.x - b.x, c.y - b.y, (c.z ?? 0) - (b.z ?? 0)];
    const dot = v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2];
    const cos = dot / ((Math.hypot(v1[0], v1[1], v1[2]) * Math.hypot(v2[0], v2[1], v2[2])) || 1);
    return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}
const jointAngle = (lm, world, j, aspect) => world && world[j[0]] && world[j[1]] && world[j[2]] ? angle3(world[j[0]], world[j[1]], world[j[2]]) : angleAt(lm[j[0]], lm[j[1]], lm[j[2]], aspect);
// Posture numbers measured over one rep. Only side-on frames count, because lean and elbow drift
// cannot be measured from the front. Angles: lean = shoulder-hip line from vertical; drift = how far the
// elbow sits from the shoulder (as a fraction of torso length); bodyLine = shoulder-hip-ankle angle.
class Posture {
    constructor() {
        this.torso = 0;
        this.drift = 0;
        this.line = 180;
        this.seen = false;
    }
    reset() { this.torso = 0; this.drift = 0; this.line = 180; this.seen = false; }
    add(lm, left, aspect) {
        const S = lm[left ? 11 : 12], S2 = lm[left ? 12 : 11], H = lm[left ? 23 : 24], E = lm[left ? 13 : 14], A = lm[left ? 27 : 28];
        if ((S.visibility ?? 1) < 0.4 || (H.visibility ?? 1) < 0.4)
            return;
        const len = Math.hypot((S.x - H.x) * aspect, S.y - H.y);
        if (len < 0.05 || Math.abs(S.x - S2.x) * aspect > 0.5 * len)
            return; // too small or not side-on: skip
        this.seen = true;
        this.torso = Math.max(this.torso, (Math.atan2(Math.abs(S.x - H.x) * aspect, Math.abs(S.y - H.y)) * 180) / Math.PI);
        if ((E.visibility ?? 1) >= 0.4)
            this.drift = Math.max(this.drift, (Math.abs(E.x - S.x) * aspect) / len);
        if ((A.visibility ?? 1) >= 0.4)
            this.line = Math.min(this.line, angleAt(S, H, A, aspect));
    }
    result() {
        return this.seen ? { torsoLean: Math.round(this.torso), elbowDrift: +this.drift.toFixed(2), bodyLine: Math.round(this.line) }
            : { torsoLean: null, elbowDrift: null, bodyLine: null };
    }
}
// Exercise-specific form rules. Thresholds are starting estimates, not validated: tune on real videos.
export function rateRep(key, fullRange, m) {
    const flags = [];
    let postureOk = true;
    const range = (t) => { if (!fullRange)
        flags.push(t); };
    const posture = (bad, t) => { if (bad) {
        flags.push(t);
        postureOk = false;
    } };
    switch (key) {
        case "squat":
            range("Shallow depth");
            posture((m.torsoLean ?? 0) > 60, "Leaning too far forward");
            break;
        case "hinge":
            range("Limited hip hinge");
            break;
        case "pushup":
            range("Not reaching full depth");
            posture(m.bodyLine !== null && m.bodyLine < 160, "Hips sagging or piking");
            break;
        case "curl":
            range("Incomplete range of motion");
            posture((m.elbowDrift ?? 0) > 0.25, "Elbows drifting forward");
            posture((m.torsoLean ?? 0) > 25, "Swinging the torso");
            break;
        case "raise":
            range("Not reaching shoulder height");
            posture((m.torsoLean ?? 0) > 20, "Using momentum (leaning back)");
            break;
        case "chestpress":
            range("No full lockout");
            break;
        case "press":
            range("No full lockout");
            posture((m.torsoLean ?? 0) > 25, "Leaning back");
            break;
        default: range("Range dropped vs your best");
    }
    return { flags, postureOk };
}
export class RepCounter {
    constructor(cfg) {
        this.reps = [];
        this.angle = null; // latest smoothed angle, for the live UI
        this.phase = "home";
        this.side = "left";
        this.t0 = null;
        this.min = 180;
        this.max = 0;
        this.smoothed = null;
        this.homeExt = null; // most extreme angle seen while resting at home
        this.post = new Posture();
        this.cfg = cfg;
    }
    get label() { return this.cfg.label; }
    get exercise() { return this.cfg.label; }
    get exerciseKey() { return this.cfg.key; }
    get vertex() { return this.cfg.joints[this.side][1]; }
    reset() { this.reps = []; this.angle = null; this.phase = "home"; this.t0 = null; this.smoothed = null; this.homeExt = null; this.min = 180; this.max = 0; this.post.reset(); }
    isHome(a) { return this.cfg.home === "extended" ? a > this.cfg.extendedAbove : a < this.cfg.flexedBelow; }
    isAway(a) { return this.cfg.home === "extended" ? a < this.cfg.flexedBelow : a > this.cfg.extendedAbove; }
    // Call once per video frame. Returns the rep if this frame completed one, otherwise null.
    update(lm, nowMs, aspect = 1, world) {
        const vis = (j) => Math.min(...j.map(i => lm[i].visibility ?? 1));
        const L = vis(this.cfg.joints.left), R = vis(this.cfg.joints.right);
        // Sticky side choice: only switch if the other side is clearly better, so the angle does not jump mid-rep.
        if (this.side === "left" && R > L + 0.3)
            this.side = "right";
        else if (this.side === "right" && L > R + 0.3)
            this.side = "left";
        const j = this.cfg.joints[this.side];
        if (vis(j) < 0.4)
            return null; // joint not visible: skip, do not guess
        const raw = jointAngle(lm, world, j, aspect);
        this.smoothed = this.smoothed === null ? raw : 0.6 * this.smoothed + 0.4 * raw; // damp pose jitter
        const a = this.angle = this.smoothed;
        if (this.phase === "home") {
            if (this.isHome(a)) { // resting: remember the home extreme, not the zone edge
                this.t0 = null;
                const e = this.homeExt;
                this.homeExt = e === null ? a : this.cfg.home === "extended" ? Math.max(e, a) : Math.min(e, a);
                this.min = this.max = this.homeExt;
                this.post.reset();
            }
            else {
                if (this.t0 === null)
                    this.t0 = nowMs;
                this.min = Math.min(this.min, a);
                this.max = Math.max(this.max, a);
                this.post.add(lm, this.side === "left", aspect);
            }
            if (this.isAway(a))
                this.phase = "away"; // reached the far end of the movement
            return null;
        }
        this.min = Math.min(this.min, a);
        this.max = Math.max(this.max, a);
        this.post.add(lm, this.side === "left", aspect);
        if (this.isHome(a)) { // back to rest: one full cycle done
            this.phase = "home";
            const fullRange = this.cfg.home === "extended" ? this.min <= this.cfg.target : this.max >= this.cfg.target;
            const metrics = this.post.result(), { flags, postureOk } = rateRep(this.cfg.key, fullRange, metrics);
            const rep = { index: this.reps.length + 1, minAngle: Math.round(this.min), maxAngle: Math.round(this.max),
                durationS: +(((nowMs - (this.t0 ?? nowMs)) / 1000).toFixed(1)), fullRange, postureOk, flags, metrics };
            this.t0 = null;
            this.homeExt = null;
            this.post.reset();
            this.reps.push(rep);
            return rep;
        }
        return null;
    }
}
// Shape the backend expects at POST /api/form (depth_ok, torso_ok and tempo_s are required there).
export function toFormRep(r) {
    return { depth_ok: (r.fullRange ? 1 : 0), torso_ok: (r.postureOk ? 1 : 0), tempo_s: r.durationS,
        min_angle: r.minAngle, max_angle: r.maxAngle, flags: r.flags,
        torso_lean: r.metrics.torsoLean, elbow_drift: r.metrics.elbowDrift, body_line: r.metrics.bodyLine };
}
// ---- Workout name -> counter -------------------------------------------------------------
// Order matters: "bench press" must hit push-up before the generic "press" rule.
const ALIASES = [
    [/squat|lunge|step.?up|leg press/i, "squat"],
    [/deadlift|rdl|good.?morning|hip thrust|hinge/i, "hinge"],
    [/push.?up|dip/i, "pushup"],
    [/chest press|bench|pec|fly/i, "chestpress"],
    [/raise|lateral/i, "raise"],
    [/curl/i, "curl"],
    [/overhead|shoulder press|military|ohp|press/i, "press"],
];
export function resolveExercise(name) {
    const hit = ALIASES.find(([re]) => re.test(name));
    return hit ? EXERCISES[hit[1]] : null;
}
// Unknown or blank workout: learn the movement from the person's own body instead of fixed angles.
// 1) watch knee, hip, elbow and shoulder angles; 2) lock onto the joint that swings the most (>= 40 degrees);
// 3) set thresholds as fractions of THIS person's observed range; 4) count swing-and-return cycles.
const JOINT_TYPES = {
    knee: { left: [23, 25, 27], right: [24, 26, 28] },
    hip: { left: [11, 23, 25], right: [12, 24, 26] },
    elbow: { left: [11, 13, 15], right: [12, 14, 16] },
    shoulder: { left: [23, 11, 13], right: [24, 12, 14] }, // arm swing: front/lateral raises
};
export class AutoCounter {
    constructor(minRange = 40) {
        this.reps = [];
        this.angle = null;
        this.chosen = null;
        this.sm = {};
        this.first = {};
        this.lo = {};
        this.hi = {};
        this.side = { knee: "left", hip: "left", elbow: "left", shoulder: "left" };
        this.phase = "home";
        this.t0 = null;
        this.min = 180;
        this.max = 0;
        this.best = 0;
        this.homeExt = null;
        this.n = 0;
        this.forward = 0;
        this.horiz = 0;
        this.wristUp = 0;
        this.bent = 0; // posture stats used to name the exercise
        this.post = new Posture();
        // How far the hips and shoulders travelled. Squats and deadlifts move the whole torso; seated or bench work and
        // arm exercises do not, so knee/hip are only allowed to win auto-detection when the torso actually moved.
        this.hipBox = null;
        this.shBox = null;
        this.torsoLen = 0;
        this.minRange = minRange;
    } // degrees of swing needed before locking on
    track(box, x, y) { return box ? [Math.min(box[0], x), Math.max(box[1], x), Math.min(box[2], y), Math.max(box[3], y)] : [x, x, y, y]; }
    travel(box) { return box ? Math.hypot(box[1] - box[0], box[3] - box[2]) : 0; }
    get torsoMoved() { return this.torsoLen > 0 && (this.travel(this.hipBox) >= 0.25 * this.torsoLen || this.travel(this.shBox) >= 0.3 * this.torsoLen); }
    // Posture cues from the arm/leg side that is being tracked (aspect-corrected like the angles).
    observe(lm, type, aspect) {
        const left = this.side[type] === "left", S = lm[left ? 11 : 12], H = lm[left ? 23 : 24], W = lm[left ? 15 : 16], A = lm[left ? 27 : 28];
        this.n++;
        if (Math.abs(S.x - A.x) * aspect > Math.abs(S.y - A.y))
            this.horiz++; // body lying horizontal
        if (S.y - W.y > 0.4 * (Math.hypot((S.x - H.x) * aspect, S.y - H.y) || 1))
            this.wristUp++; // wrist clearly overhead (curls only reach shoulder height)
        if (Math.atan2(Math.abs(S.x - H.x) * aspect, Math.abs(S.y - H.y)) > 0.61)
            this.bent++;
        const torso = Math.hypot((S.x - H.x) * aspect, S.y - H.y) || 1;
        if (Math.abs(S.y - W.y) < 0.3 * torso && Math.abs(S.x - W.x) * aspect > 0.6 * torso)
            this.forward++; // hand level with shoulder and far in front: pressing forward          // torso > ~35 deg from vertical
    }
    // Exercise name inferred from WHICH joint moves plus posture. Heuristic: a best guess, not a certainty.
    get exercise() {
        if (!this.chosen)
            return null;
        const f = (c) => (this.n ? c / this.n : 0);
        switch (this.chosen) {
            case "knee": return "Squat / lunge";
            case "hip": return "Deadlift / hip hinge";
            case "shoulder": return "Dumbbell raise";
            default: return f(this.horiz) > 0.5 ? "Push-up" : f(this.wristUp) > 0.2 ? "Overhead press" : f(this.forward) > 0.15 ? "Chest press" : f(this.bent) > 0.5 ? "Row" : "Biceps curl";
        }
    }
    get exerciseKey() {
        const names = { "Chest press": "chestpress", "Squat / lunge": "squat", "Deadlift / hip hinge": "hinge", "Dumbbell raise": "raise", "Push-up": "pushup", "Overhead press": "press", "Row": "row", "Biceps curl": "curl" };
        const e = this.exercise;
        return e ? names[e] ?? null : null;
    }
    get vertex() { return this.chosen ? JOINT_TYPES[this.chosen][this.side[this.chosen]][1] : null; }
    // Live per-joint angle and range, so the UI can show WHY nothing has locked on yet.
    get debug() {
        return Object.fromEntries(Object.keys(this.sm).map(t => [t, { angle: Math.round(this.sm[t]), range: Math.round(this.hi[t] - this.lo[t]) }]));
    }
    get label() { return this.chosen ? `${this.exercise} · auto (${Math.round(this.best)}° range)` : "Detecting movement…"; }
    reset() { Object.assign(this, { hipBox: null, shBox: null, torsoLen: 0, reps: [], angle: null, chosen: null, sm: {}, first: {}, lo: {}, hi: {}, phase: "home", t0: null, min: 180, max: 0, best: 0, homeExt: null, n: 0, forward: 0, horiz: 0, wristUp: 0, bent: 0 }); this.post.reset(); }
    update(lm, nowMs, aspect = 1, world) {
        var _a;
        for (const [type, sides] of Object.entries(JOINT_TYPES)) { // 1) track every candidate joint
            const vis = (j) => Math.min(...j.map(i => lm[i].visibility ?? 1));
            const cur = this.side[type], other = cur === "left" ? "right" : "left";
            if (vis(sides[other]) > vis(sides[cur]) + 0.3)
                this.side[type] = other;
            const j = sides[this.side[type]];
            if (vis(j) < 0.4)
                continue;
            const raw = jointAngle(lm, world, j, aspect);
            const a = (this.sm[type] = type in this.sm ? 0.6 * this.sm[type] + 0.4 * raw : raw);
            (_a = this.first)[type] ?? (_a[type] = a);
            this.lo[type] = Math.min(this.lo[type] ?? a, a);
            this.hi[type] = Math.max(this.hi[type] ?? a, a);
        }
        const ok = (i) => (lm[i]?.visibility ?? 1) >= 0.4;
        if (ok(11) && ok(12) && ok(23) && ok(24)) {
            const hx = (lm[23].x + lm[24].x) / 2 * aspect, hy = (lm[23].y + lm[24].y) / 2, sx = (lm[11].x + lm[12].x) / 2 * aspect, sy = (lm[11].y + lm[12].y) / 2;
            this.hipBox = this.track(this.hipBox, hx, hy);
            this.shBox = this.track(this.shBox, sx, sy);
            this.torsoLen = Math.max(this.torsoLen, Math.hypot(sx - hx, sy - hy));
        }
        // 2) lock onto the joint that moves most, but only when it clearly beats the others (jitter on a hidden
        //    joint can swing 40+ degrees). Until the first rep finishes we may still switch to a clearly bigger mover.
        const legsAllowed = this.torsoMoved;
        const ranges = Object.keys(this.sm).filter(t => legsAllowed || (t !== "knee" && t !== "hip")).map(t => [t, this.hi[t] - this.lo[t]]).sort((x, y) => y[1] - x[1]);
        const top = ranges[0], runnerUp = ranges[1]?.[1] ?? 0;
        const dominant = !!top && top[1] >= this.minRange && (top[1] >= 1.3 * runnerUp || top[1] >= 80);
        if (!this.chosen) {
            if (!dominant)
                return null;
            this.chosen = top[0];
        }
        else if (this.reps.length === 0 && this.phase === "home" && dominant && top[0] !== this.chosen && top[1] > 1.3 * (this.hi[this.chosen] - this.lo[this.chosen])) {
            this.chosen = top[0];
            this.homeExt = null;
            this.t0 = null;
            this.n = 0;
            this.horiz = 0;
            this.wristUp = 0;
            this.bent = 0;
            this.post.reset();
        }
        const t = this.chosen;
        if (!(t in this.sm))
            return null;
        this.observe(lm, t, aspect);
        const a = (this.angle = this.sm[t]), range = this.hi[t] - this.lo[t];
        const lowZone = this.lo[t] + 0.3 * range, highZone = this.hi[t] - 0.3 * range; // 3) thresholds from YOUR range
        const homeHigh = this.first[t] > (this.lo[t] + this.hi[t]) / 2; // rest = where the set started
        const isHome = homeHigh ? a >= highZone : a <= lowZone, isAway = homeHigh ? a <= lowZone : a >= highZone;
        if (this.phase === "home") {
            if (isHome) {
                this.t0 = null;
                const e = this.homeExt;
                this.homeExt = e === null ? a : homeHigh ? Math.max(e, a) : Math.min(e, a);
                this.min = this.max = this.homeExt;
                this.post.reset();
            }
            else {
                if (this.t0 === null)
                    this.t0 = nowMs;
                this.min = Math.min(this.min, a);
                this.max = Math.max(this.max, a);
                this.post.add(lm, this.side[t] === "left", aspect);
            }
            if (isAway)
                this.phase = "away";
            return null;
        }
        this.min = Math.min(this.min, a);
        this.max = Math.max(this.max, a);
        this.post.add(lm, this.side[t] === "left", aspect);
        if (!isHome)
            return null;
        this.phase = "home"; // 4) one full cycle completed
        const rom = this.max - this.min;
        this.best = Math.max(this.best, rom);
        const fullRange = rom >= 0.8 * this.best; // vs your own best
        const metrics = this.post.result(), { flags, postureOk } = rateRep(this.exerciseKey, fullRange, metrics);
        const rep = { index: this.reps.length + 1, minAngle: Math.round(this.min), maxAngle: Math.round(this.max),
            durationS: +(((nowMs - (this.t0 ?? nowMs)) / 1000).toFixed(1)), fullRange, postureOk, flags, metrics };
        this.t0 = null;
        this.homeExt = null;
        this.post.reset();
        this.reps.push(rep);
        return rep;
    }
}
// One call for the UI: typed/selected workout name in, ready counter out.
export function createCounter(workoutName = "", minRange = 40) {
    const cfg = resolveExercise(workoutName.trim());
    return cfg ? new RepCounter(cfg) : new AutoCounter(minRange);
}
