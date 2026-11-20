/// <reference types="vite/client" />

/**
 * 共享 Worker 入口 URL（由 vite.config.ts 的 quat-shared-worker-urls 插件提供）。
 * build 时是带 hash 的 emitted chunk URL；dev 时指向源码入口，由 Vite dev server 转换。
 */
declare module "virtual:worker-url/batch" {
  const url: string;
  export default url;
}

declare module "virtual:worker-url/comparison" {
  const url: string;
  export default url;
}
