# AGENTS.md

- 与用户用中文交流；本项目是教学演示装置（四元数姿态解算），重视直观演示 + 数字对照。
- 改代码后的验证流程（全部通过才算完成）：
  `npx tsc --noEmit` → `npm run check`（selftest + scenecheck，须 0 FAIL）→ `npm run build`；
  UI 改动再用浏览器截图确认，并检查控制台零错误。
- **项目状态、架构与约定见 `docs/PROJECT-STATE.md`**——它是会话压缩后的恢复锚点，
  完成一个里程碑或大改动后请同步更新它。
- 预览：`npm run build && npm run preview`（4173 端口）；改源码后必须重新 build 并强刷。
- 不要提交或删除 `.zcodeignore`（ZCode 本地工具文件，已在 .gitignore 忽略）。
