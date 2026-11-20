import type { UiView } from "./mode";

/** 用户主动切视图的统一动作：先应用，再按真实变化记录事件。 */
export function selectViewAction(
  view: UiView,
  before: UiView,
  apply: (next: UiView) => void,
  notify: (before: UiView, after: UiView) => void,
): void {
  apply(view);
  if (before !== view) notify(before, view);
}
