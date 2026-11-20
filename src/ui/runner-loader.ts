let runnerModule: Promise<typeof import("../core/runner-ui")> | null = null;

/** 主界面与对照台共享的 runner 按需加载缓存；Worker 仍直接使用 core/runner。 */
export function loadRunner(): Promise<typeof import("../core/runner-ui")> {
  if (!runnerModule) runnerModule = import("../core/runner-ui");
  return runnerModule;
}
