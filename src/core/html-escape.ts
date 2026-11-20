/**
 * HTML 转义（全站唯一实现）。
 *
 * 为什么单独成文件：搜索框、公式、对照报告、回看与 ESKF 面板都需要同一份转义契约；
 * 各处复制会漂移，而让按需教学 chunk 去 import 主包的 `ui/doc-search` 又会把
 * 主包模块与懒加载 chunk 绑成环，导致首屏被迫预加载教学 chunk。这里保持零依赖，
 * 只被真正需要它的模块引用。
 */
export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 统一的错误摘要；不读 DOM，不改变各调用方原有文案。 */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
