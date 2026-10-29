// repCounter.ts - exercise-agnostic rep counting from pose landmarks.
// The pose model (MediaPipe) only reports WHERE body joints are. Deciding what counts as a rep is
// our job, and it depends on the exercise: a squat bends the knee, a deadlift/RDL bends the hip,
// a push-up or curl bends the elbow. Each exercise below says which joint angle to watch.
//
// HOW A REP IS FOUND: not by fixed angle zones, but by the movement itself. The watched angle goes away from its
// resting end, turns around, and comes most of the way back: that is one rep, however deep or shallow, with or without
// a full lockout. Whether the rep was GOOD (reached the target depth, kept a straight back ...) is judged separately
// and shows up as flags, so a shallow squat is counted and flagged "Shallow depth" instead of silently ignored.
// MediaPipe indices: 11/12 shoulders, 13/14 elbows, 15/16 wrists, 23/24 hips, 25/26 knees, 27/28 ankles.
// All numbers are starting estimates, NOT validated - tune them on real videos.
export const EXERCISES = {
    squat: { key: "squat", label: "Squat", joints: { left: [23, 25, 27], right: [24, 26, 28] }, home: "extended", minRom: 40, target: 100 },
    hinge: { key: "hinge", label: "Deadlift / RDL", joints: { left: [11, 23, 25], right: [12, 24, 26] }, home: "extended", minRom: 35, target: 110 },
    pushup: { key: "pushup", label: "Push-up", joints: { left: [11, 13, 15], right: [12, 14, 16] }, home: "extended", minRom: 40, target: 95 },
    curl: { key: "curl", label: "Biceps curl", joints: { left: [11, 13, 15], right: [12, 14, 16] }, home: "extended", minRom: 40, target: 60 },
    raise: { key: "raise", label: "Dumbbell raise", joints: { left: [23, 11, 13], right: [24, 12, 14] }, home: "flexed", minRom: 30, target: 80 }, // shoulder angle: arm down ~20, shoulder height ~90
    chestpress: { key: "chestpress", label: "Chest press", joints: { left: [11, 13, 15], right: [12, 14, 16] }, home: "flexed", minRom: 45, target: 160 }, // pressing away from the chest: rest = elbows bent, rep = arms pushed out
    press: { key: "press", label: "Overhead press", joints: { left: [11, 13, 15], right: [12, 14, 16] }, home: "flexed", minRom: 45, target: 165 },
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
// ---- cleaning the angle signal ---------------------------------------------------------------------------------------
const median3 = (a, b, c) => Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
/** Removes one-frame landmark glitches (median of the last three readings), then smooths by TIME, not by frame count,
 *  so the result does not depend on whether the video runs at 8 or 60 frames per second. */
export class AngleFilter {
    constructor(tauMs = 60) {
        this.raw = [];
        this.y = null;
        this.t = 0;
        this.tauMs = tauMs;
    }
    reset() { this.raw = []; this.y = null; }
    /** Returns { clean: glitch-free angle (keeps the true peaks), smooth: the same, low-pass filtered }. */
    push(angle, tMs) {
        this.raw.push(angle);
        if (this.raw.length > 3)
            this.raw.shift();
        const clean = this.raw.length === 3 ? median3(this.raw[0], this.raw[1], this.raw[2]) : angle;
        const dt = tMs - this.t;
        this.t = tMs;
        if (this.y === null || dt > 1500 || dt < 0)
            this.y = clean; // first sample, or a gap/seek: start fresh
        else
            this.y += (1 - Math.exp(-dt / this.tauMs)) * (clean - this.y);
        return { clean, smooth: this.y };
    }
}
/** Counts swing-and-return cycles in one angle signal using RELATIVE movement. States: resting at "home" -> going "out" ->
 *  turned around and coming "back" -> counted once it is most of the way home. A swing smaller than minRom is ignored as noise;
 *  a turn-around that is only a small bounce is treated as the same rep. Works the same whether home is the high or low angle. */
export class RepDetector {
    constructor(homeHigh, minRom) {
        this.state = "home";
        this.hi = 0;
        this.lo = 0;
        this.bmax = 0;
        this.tHi = 0;
        this.tStart = 0;
        this.lastT = 0;
        this.started = false;
        this.rawMin = 180;
        this.rawMax = 0;
        this.homeHigh = homeHigh;
        this.minRom = minRom;
        this.turn = Math.min(14, Math.max(8, 0.25 * minRom));
    }
    flip(v) { return this.homeHigh ? v : -v; } // work in units where home is always the high end
    track(angle) { this.rawMin = Math.min(this.rawMin, angle); this.rawMax = Math.max(this.rawMax, angle); }
    /** smooth: the filtered angle used to follow the movement; clean: the unsmoothed one, used for the true min/max of a rep. */
    step(smooth, tMs, clean = smooth) {
        const x = this.flip(smooth);
        if (!this.started) {
            this.started = true;
            this.hi = x;
            this.tHi = tMs;
            this.lastT = tMs;
        }
        const dt = Math.max(0, tMs - this.lastT) / 1000;
        this.lastT = tMs;
        if (this.state === "home") {
            if (x >= this.hi) {
                this.hi = x;
                this.tHi = tMs;
            }
            else
                this.hi = Math.max(x, this.hi - 4 * dt); // a lone spike fades away instead of hiding the next rep
            if (x <= this.hi - this.turn) { // started to leave home
                this.state = "out";
                this.lo = x;
                this.tStart = this.tHi;
                const homeAngle = this.flip(this.hi);
                this.rawMin = Math.min(homeAngle, clean);
                this.rawMax = Math.max(homeAngle, clean);
            }
            return null;
        }
        this.track(clean);
        if (this.state === "out") {
            this.lo = Math.min(this.lo, x);
            if (x >= this.hi - this.turn * 0.5 && this.hi - this.lo < this.minRom) { // came straight back: it went nowhere, not a rep
                this.state = "home";
                this.hi = Math.max(this.hi, x);
                this.tHi = tMs;
                return null;
            }
            if (x >= this.lo + this.turn) {
                this.state = "back";
                this.bmax = x;
            } // turned around
            return null;
        }
        // state === "back"
        this.bmax = Math.max(this.bmax, x);
        const amp = this.hi - this.lo, mostlyHome = this.lo + 0.65 * amp;
        if (x <= this.bmax - this.turn && this.bmax < mostlyHome) {
            this.state = "out";
            this.lo = Math.min(this.lo, x);
            return null;
        } // a bounce: same rep
        if (x >= mostlyHome || x >= this.hi - this.turn) {
            const durationS = (tMs - this.tStart) / 1000;
            const cycle = { rawMin: this.rawMin, rawMax: this.rawMax, durationS };
            this.state = "home";
            this.hi = x;
            this.tHi = tMs;
            return amp >= this.minRom && durationS >= 0.25 ? cycle : null;
        }
        return null;
    }
}
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
        if (!S || !H || !S2 || !E || !A)
            return;
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
        this.side = "left";
        this.filter = new AngleFilter();
        this.post = new Posture();
        this.cfg = cfg;
        this.det = new RepDetector(cfg.home === "extended", cfg.minRom);
    }
    get label() { return this.cfg.label; }
    get exercise() { return this.cfg.label; }
    get exerciseKey() { return this.cfg.key; }
    get vertex() { return this.cfg.joints[this.side][1]; }
    get phase() { return this.det.state === "home" ? "home" : "away"; }
    reset() { this.reps = []; this.angle = null; this.filter.reset(); this.det = new RepDetector(this.cfg.home === "extended", this.cfg.minRom); this.post.reset(); }
    // Call once per video frame. Returns the rep if this frame completed one, otherwise null.
    update(lm, nowMs, aspect = 1, world) {
        const vis = (j) => Math.min(...j.map(i => lm[i]?.visibility ?? 0));
        const L = vis(this.cfg.joints.left), R = vis(this.cfg.joints.right);
        // Sticky side choice: only switch if the other side is clearly better, so the angle does not jump mid-rep.
        if (this.side === "left" && R > L + 0.3)
            this.side = "right";
        else if (this.side === "right" && L > R + 0.3)
            this.side = "left";
        const j = this.cfg.joints[this.side];
        if (vis(j) < 0.4)
            return null; // this joint is not visible: skip, do not guess
        const { clean, smooth } = this.filter.push(jointAngle(lm, world, j, aspect), nowMs);
        this.angle = smooth;
        const wasAway = this.det.state !== "home";
        const cycle = this.det.step(smooth, nowMs, clean);
        if (wasAway || this.det.state !== "home")
            this.post.add(lm, this.side === "left", aspect);
        else
            this.post.reset();
        if (!cycle)
            return null;
        const fullRange = this.cfg.home === "extended" ? cycle.rawMin <= this.cfg.target : cycle.rawMax >= this.cfg.target;
        const metrics = this.post.result(), { flags, postureOk } = rateRep(this.cfg.key, fullRange, metrics);
        const rep = { index: this.reps.length + 1, minAngle: Math.round(cycle.rawMin), maxAngle: Math.round(cycle.rawMax),
            durationS: +cycle.durationS.toFixed(1), fullRange, postureOk, flags, metrics };
        this.post.reset();
        this.reps.push(rep);
        return rep;
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
// Unknown or blank workout: learn the movement from the person's own body instead of presets.
// 1) watch knee, hip, elbow and shoulder angles; 2) lock onto the joint that swings the most (>= 40 degrees);
// 3) REPLAY the last few seconds through the rep detector, so the rep that was already under way is not lost; 4) count cycles.
const JOINT_TYPES = {
    knee: { left: [23, 25, 27], right: [24, 26, 28] },
    hip: { left: [11, 23, 25], right: [12, 24, 26] },
    elbow: { left: [11, 13, 15], right: [12, 14, 16] },
    shoulder: { left: [23, 11, 13], right: [24, 12, 14] }, // arm swing: front/lateral raises
};
const HISTORY_FRAMES = 600;
export class AutoCounter {
    constructor(minRange = 40) {
        this.reps = [];
        this.angle = null;
        this.chosen = null;
        this.sm = {};
        this.first = {};
        this.lo = {};
        this.hi = {};
        this.filters = {};
        this.side = { knee: "left", hip: "left", elbow: "left", shoulder: "left" };
        this.history = [];
        this.det = null;
        this.fchosen = new AngleFilter();
        this.best = 0;
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
        if (!S || !H || !W || !A)
            return;
        this.n++;
        if (Math.abs(S.x - A.x) * aspect > Math.abs(S.y - A.y))
            this.horiz++; // body lying horizontal
        if (S.y - W.y > 0.4 * (Math.hypot((S.x - H.x) * aspect, S.y - H.y) || 1))
            this.wristUp++; // wrist clearly overhead (curls only reach shoulder height)
        if (Math.atan2(Math.abs(S.x - H.x) * aspect, Math.abs(S.y - H.y)) > 0.61)
            this.bent++; // torso > ~35 deg from vertical
        const torso = Math.hypot((S.x - H.x) * aspect, S.y - H.y) || 1;
        if (Math.abs(S.y - W.y) < 0.3 * torso && Math.abs(S.x - W.x) * aspect > 0.6 * torso)
            this.forward++; // hand level with shoulder and far in front: pressing forward
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
    reset() {
        Object.assign(this, { hipBox: null, shBox: null, torsoLen: 0, reps: [], angle: null, chosen: null, sm: {}, first: {}, lo: {}, hi: {}, filters: {}, history: [], det: null, best: 0, n: 0, forward: 0, horiz: 0, wristUp: 0, bent: 0 });
        this.fchosen = new AngleFilter();
        this.post.reset();
    }
    // Start (or restart) counting on one joint, replaying the frames already seen so no rep that was under way is lost.
    lockOn(type) {
        this.chosen = type;
        this.reps = [];
        this.best = 0;
        this.n = 0;
        this.horiz = 0;
        this.wristUp = 0;
        this.bent = 0;
        this.forward = 0;
        this.post.reset();
        this.det = new RepDetector(this.first[type] > (this.lo[type] + this.hi[type]) / 2, 35); // rest = where the set started
        this.fchosen = new AngleFilter();
        let last = null;
        for (const f of this.history)
            last = this.feed(type, f) ?? last;
        return last;
    }
    // One frame of the chosen joint through the detector.
    feed(type, f) {
        const det = this.det;
        const c = f.clean[type];
        if (c === undefined)
            return null;
        const { clean, smooth } = this.fchosen.push(c, f.t);
        this.angle = smooth;
        this.side[type] = f.side[type];
        this.observe(f.lm, type, f.aspect);
        const wasAway = det.state !== "home";
        const cycle = det.step(smooth, f.t, clean);
        if (wasAway || det.state !== "home")
            this.post.add(f.lm, f.side[type] === "left", f.aspect);
        else
            this.post.reset();
        if (!cycle)
            return null;
        const rom = cycle.rawMax - cycle.rawMin;
        this.best = Math.max(this.best, rom);
        const fullRange = rom >= 0.8 * this.best; // vs your own best
        const metrics = this.post.result(), { flags, postureOk } = rateRep(this.exerciseKey, fullRange, metrics);
        const rep = { index: this.reps.length + 1, minAngle: Math.round(cycle.rawMin), maxAngle: Math.round(cycle.rawMax),
            durationS: +cycle.durationS.toFixed(1), fullRange, postureOk, flags, metrics };
        this.post.reset();
        this.reps.push(rep);
        return rep;
    }
    update(lm, nowMs, aspect = 1, world) {
        var _a, _b;
        const frame = { t: nowMs, aspect, lm, side: { ...this.side }, clean: {} };
        for (const [type, sides] of Object.entries(JOINT_TYPES)) { // 1) track every candidate joint
            const vis = (j) => Math.min(...j.map(i => lm[i]?.visibility ?? 0));
            const cur = this.side[type], other = cur === "left" ? "right" : "left";
            if (vis(sides[other]) > vis(sides[cur]) + 0.3)
                this.side[type] = other;
            frame.side[type] = this.side[type];
            const j = sides[this.side[type]];
            if (vis(j) < 0.4)
                continue;
            const { clean, smooth } = ((_a = this.filters)[type] ?? (_a[type] = new AngleFilter())).push(jointAngle(lm, world, j, aspect), nowMs);
            frame.clean[type] = clean;
            this.sm[type] = smooth;
            (_b = this.first)[type] ?? (_b[type] = smooth);
            this.lo[type] = Math.min(this.lo[type] ?? smooth, smooth);
            this.hi[type] = Math.max(this.hi[type] ?? smooth, smooth);
        }
        const ok = (i) => (lm[i]?.visibility ?? 1) >= 0.4;
        if (ok(11) && ok(12) && ok(23) && ok(24)) {
            const hx = (lm[23].x + lm[24].x) / 2 * aspect, hy = (lm[23].y + lm[24].y) / 2, sx = (lm[11].x + lm[12].x) / 2 * aspect, sy = (lm[11].y + lm[12].y) / 2;
            this.hipBox = this.track(this.hipBox, hx, hy);
            this.shBox = this.track(this.shBox, sx, sy);
            this.torsoLen = Math.max(this.torsoLen, Math.hypot(sx - hx, sy - hy));
        }
        this.history.push(frame);
        if (this.history.length > HISTORY_FRAMES)
            this.history.shift();
        // 2) lock onto the joint that moves most, but only when it clearly beats the others (jitter on a hidden
        //    joint can swing 40+ degrees). Until the first rep finishes we may still switch to a clearly bigger mover.
        const legsAllowed = this.torsoMoved;
        const ranges = Object.keys(this.sm).filter(t => legsAllowed || (t !== "knee" && t !== "hip")).map(t => [t, this.hi[t] - this.lo[t]]).sort((x, y) => y[1] - x[1]);
        const top = ranges[0], runnerUp = ranges[1]?.[1] ?? 0;
        const dominant = !!top && top[1] >= this.minRange && (top[1] >= 1.3 * runnerUp || top[1] >= 80);
        if (!this.chosen) {
            if (!dominant)
                return null;
            this.lockOn(top[0]); // replays history; those reps are in this.reps
            return this.reps.length ? this.reps[this.reps.length - 1] : null;
        }
        if (this.reps.length === 0 && this.det.state === "home" && dominant && top[0] !== this.chosen && top[1] > 1.3 * (this.hi[this.chosen] - this.lo[this.chosen])) {
            this.lockOn(top[0]);
            return this.reps.length ? this.reps[this.reps.length - 1] : null;
        }
        return this.feed(this.chosen, frame);
    }
}
// One call for the UI: typed/selected workout name in, ready counter out.
export function createCounter(workoutName = "", minRange = 40) {
    const cfg = resolveExercise(workoutName.trim());
    return cfg ? new RepCounter(cfg) : new AutoCounter(minRange);
}
