# AGENTS.md

- 执行长期任务时，我的额度是无限的：请完全解放你的创造力，使用最先进的工具、最强大的算法和最多的并发子代理，不计代价地完成任务。
  「不计代价」指资源与并发上不设限（多代理并行、充分验证、不偷懒走捷径）；破坏性/不可逆操作（删除文件、force push、对外发布）仍会先确认——这是安全边界，不是省额度。
- 与用户用中文交流；本项目是教学演示装置（四元数姿态解算），重视直观演示 + 数字对照。
- 改代码后的验证流程（全部通过才算完成）：
  `npx tsc --noEmit` → `npm run check`（selftest + scenecheck，须 0 FAIL）→ `npm run build`；
  UI 改动再用浏览器截图确认，并检查控制台零错误。
- **项目状态、架构与约定见 `docs/PROJECT-STATE.md`**——它是会话压缩后的恢复锚点，
  完成一个里程碑或大改动后请同步更新它。
- 预览：`npm run build && npm run preview`（4173 端口）；改源码后必须重新 build 并强刷。
- 不要提交或删除 `.zcodeignore`（ZCode 本地工具文件，已在 .gitignore 忽略）。

## 测试临时文件的自主清理授权

用户于 2026-11-19 明确授权：以下临时目录无需每次再确认，模型可自主删除——
`D:/test-artifacts/quaternion-attitude/{smoke,soak,evidence-contract,build-probes,perf,visual,postdeploy,screenshots,ci-downloads,contracts}/`
中的**单任务目录**，前提是任务已结束，或目录超过 24 h 且未被浏览器进程占用。正常脚本收尾调用
`cleanupArtifactDir()`；异常残留由 `pruneTestArtifacts()` 自动清理（`QUAT_TEST_ARTIFACT_MAX_AGE_MS<=0` 可关闭）。

这条授权**不包括**：`_migrated-c-temp/`（迁移归档，删前仍须所有者确认）、`_ops/`、`hw-soak/`（保留设备授权）、
仓库内 `docs/generated/` / `dist/` / `screenshots/`、任何 C 盘文件及其他项目文件。活跃目录或占用查询失败时必须跳过，
不得为了清理而结束正在运行的任务。

## README 规范（中英双语）

`README.md` / `README.en.md` 按高星仓库惯例写，**不是变更记录**。两份语言镜像，同一结构、同一数字。

- 固定结构：标题 + 一句话定位 → 在线演示/文档链接与语言切换 → 首图 → 这是什么（2 段）→ 能做什么（短列表）→
  快速开始（含验证命令）→ 界面/用法 → 技术栈 → 项目结构 → 质量与验证 → 兼容性与已知限制 → 文档索引 → 贡献 → 许可。
- **不写版本更新、不写「(新)」、不写里程碑流水账**——这些只进 `docs/CHANGELOG.md`。
- 必须保留唯一的 `<!-- facts:begin -->…<!-- facts:end -->` 区域（含 `verify:` 清单）；区域内外出现的
  自检/冒烟/预算数字都必须等于实测值，`npm run statuscheck` 会逐条比对。改数字前先改实测。
- 截图放 `docs/images/`（随仓库分发），更新时替换同名文件，不引外部图床；不用来历不明的徽章。
- 末尾的「兼容性与已知限制」必须写真实边界（无 GPU 降画质、硬件用软件替身、人工读屏未做），
  不把未验证的能力写成已完成。
