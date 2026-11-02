const IDS = ["pure", "comp", "mahony", "madg", "kalman"];
const finite = (v) => typeof v === "number" && Number.isFinite(v);
const triple = (v) => Array.isArray(v) && v.length === 3 && v.every(finite);
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** 独立于两侧输出的仿真解算排程；同时验证误差/输入比较所用的时间轴。 */
export function solveSchedule(steps, hz, h = 0.002) {
  const out = [];
  const period = hz > 0 ? 1 / hz : h;
  let acc = 0;
  let since = 0;
  for (let i = 1; i <= steps; i++) {
    acc += h;
    since += h;
    if (acc + 1e-12 >= period) {
      out.push({ t: i * h, dt: since });
      acc = Math.max(0, acc - period);
      since = 0;
    }
  }
  return out;
}

/** 纯判定：坏结构返回失败，不抛TypeError；两侧同时出错也不能靠相等通过。 */
export function compareTrace(aFrames, bFrames, bIds, endSec, expectedFrames, options = {}) {
  const fail = (reason) => ({ ok: false, reason, maxStepDiff: NaN, maxTimeDiff: NaN, worstAt: -1, compared: 0 });
  if (!Array.isArray(aFrames) || !Array.isArray(bFrames)) return fail("trace 必须是数组");
  if (!Array.isArray(bIds) || bIds.join(",") !== IDS.join(",")) return fail("算法身份/顺序不正确");
  if (aFrames.length !== expectedFrames || bFrames.length !== expectedFrames || expectedFrames < 1) return fail("帧数不符合预期排程");
  const schedule = options.schedule ?? solveSchedule(expectedFrames, 500);
  if (!Array.isArray(schedule) || schedule.length !== expectedFrames) return fail("期望排程无效");
  let maxStepDiff = 0;
  let maxTimeDiff = 0;
  let worstAt = -1;
  for (let i = 0; i < expectedFrames; i++) {
    const a = aFrames[i];
    const b = bFrames[i];
    for (const f of [a, b]) {
      if (!object(f) || !finite(f.t) || !finite(f.dt) || f.dt <= 0) return fail(`第${i}帧时间/结构非法`);
      if (Math.abs(f.t - schedule[i].t) > 1e-9 || Math.abs(f.dt - schedule[i].dt) > 1e-12) return fail(`第${i}帧不符合独立排程`);
      if (typeof f.aligned !== "boolean") return fail(`第${i}帧缺 aligned`);
      if (!Array.isArray(f.quats) || f.quats.length !== IDS.length) return fail(`第${i}帧姿态列不完整`);
      for (const q of f.quats) {
        if (!object(q) || ![q.w, q.x, q.y, q.z].every(finite) || Math.abs(Math.hypot(q.w, q.x, q.y, q.z) - 1) > 1e-9) return fail(`第${i}帧非有限单位四元数`);
      }
      if (!object(f.raw) || !object(f.consumed) || ![f.raw.gyro, f.raw.accel, f.raw.mag, f.consumed.accel, f.consumed.mag].every(triple)) return fail(`第${i}帧缺有限IMU输入`);
    }
    maxTimeDiff = Math.max(maxTimeDiff, Math.abs(a.t - b.t));
    if (a.aligned !== b.aligned) return fail(`第${i}帧对准标记不同`);
    for (const key of ["gyro", "accel", "mag"]) {
      if (a.raw[key].some((v, k) => Math.abs(v - b.raw[key][k]) > 1e-9)) return fail(`第${i}帧raw.${key}不同`);
    }
    for (const key of ["accel", "mag"]) {
      if (a.consumed[key].some((v, k) => Math.abs(v - b.consumed[key][k]) > 1e-9)) return fail(`第${i}帧consumed.${key}不同`);
    }
    for (let k = 0; k < IDS.length; k++) {
      const qa = a.quats[k];
      const qb = b.quats[k];
      const d = 2 * Math.acos(Math.min(1, Math.abs(qa.w * qb.w + qa.x * qb.x + qa.y * qb.y + qa.z * qb.z))) * 180 / Math.PI;
      if (d > maxStepDiff) { maxStepDiff = d; worstAt = i; }
    }
  }
  if (!finite(endSec) || Math.abs(schedule.at(-1).t - endSec) > 1e-9) return fail("末解算时刻不符合预期");
  if (maxTimeDiff > 1e-12 || maxStepDiff >= 1e-3) return fail("两侧姿态/时间不一致");
  for (const [frames, events] of [[aFrames, options.leftEvents], [bFrames, options.rightEvents]]) {
    if (events === undefined) continue;
    if (!object(events) || !Array.isArray(events.alignTimes) || !events.alignTimes.every(finite)) return fail("对准事件流缺失");
    const marked = frames.filter((f) => f.aligned).map((f) => f.t);
    if (marked.length !== events.alignTimes.length || marked.some((t, i) => Math.abs(t - events.alignTimes[i]) > 1e-9)) return fail("对准时刻与解算标记不一致");
    if (!object(events.eventCounts) || (events.eventCounts.align ?? 0) !== events.alignTimes.length) return fail("对准计数不一致");
  }
  if (options.leftEvents && options.rightEvents) {
    const keys = new Set([...Object.keys(options.leftEvents.eventCounts), ...Object.keys(options.rightEvents.eventCounts)]);
    for (const k of keys) if ((options.leftEvents.eventCounts[k] ?? 0) !== (options.rightEvents.eventCounts[k] ?? 0)) return fail(`事件计数${k}不同`);
  }
  return { ok: true, reason: "", maxStepDiff, maxTimeDiff, worstAt, compared: expectedFrames };
}
