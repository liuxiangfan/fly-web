/** 教学长稳的真实换源量具：三个阶段均保留生产状态，不按动作名称计数。 */
export function replaySwitchProblems(evidence) {
  const problems = [];
  const phases = [evidence?.before, evidence?.during, evidence?.after];
  const active = [false, true, false];
  const kinds = ["simulation", "replay", "simulation"];
  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i];
    if (!phase || phase.active !== active[i] || phase.sourceKind !== kinds[i]) {
      problems.push(`换源阶段 ${i} 未达到 ${kinds[i]}/${active[i]}`);
    }
    if (!Number.isSafeInteger(phase?.runId) || phase.runId < 0) {
      problems.push(`换源阶段 ${i} 缺少真实诊断 runId`);
    }
  }
  if (evidence?.error) problems.push(`换源异常：${evidence.error}`);
  if (typeof evidence?.imported !== "string" || !evidence.imported.startsWith("ok:")) problems.push("回放导入失败");
  if (!(phases[1]?.runId > phases[0]?.runId && phases[2]?.runId > phases[1]?.runId)) problems.push("导入/退出未推进诊断 runId");
  if (!(phases[1]?.idx > 0)) problems.push("回放没有实际消费帧");
  if (phases[1]?.reviewActive !== false || phases[2]?.reviewActive !== false) problems.push("换源仍保留旧回看覆盖");
  return problems;
}

/** 由 page.evaluate 执行；测试使用等价的 window 端口，失败路径也保留观察记录。 */
export async function exerciseReplaySwitch(csv) {
  const api = window.attitudeDemo;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const observe = () => {
    const diagnostics = api.diagnostics.state();
    const replay = api.replay.info;
    return {
      at: Date.now(), active: replay.active, idx: replay.idx,
      sourceKind: api.plumbing().sourceKind, runId: diagnostics?.runId ?? null,
      reviewFrames: diagnostics?.reviewFrames ?? null,
      eventCount: diagnostics?.eventCount ?? null, reviewActive: diagnostics?.reviewActive ?? null,
    };
  };
  const evidence = { before: observe(), imported: null, during: null, after: null, error: null };
  try {
    evidence.imported = api.replay.import(csv, "teaching-switch.csv");
    const deadline = Date.now() + 2000;
    do {
      evidence.during = observe();
      if (evidence.during.active && evidence.during.idx > 0) break;
      if (typeof evidence.imported !== "string" || !evidence.imported.startsWith("ok:")) break;
      await sleep(20);
    } while (Date.now() < deadline);
  } catch (error) {
    evidence.error = String(error);
  } finally {
    try { api.replay.stop(); }
    catch (error) { evidence.error = String(error); }
    evidence.after = observe();
  }
  return evidence;
}
