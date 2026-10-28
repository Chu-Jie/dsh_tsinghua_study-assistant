/**
 * 大学生学习辅助系统 · 客户端半边（**第 1 阶段：空骨架**）
 *
 * 为什么现在是空的：
 *   本插件第一次上线时，客户端半边激活失败（渲染进程报
 *   `web boot: 1 entry did not activate / dsh-study-assistant: failed`），
 *   桌面端反复在正常/安全模式之间切换后自动卸载了插件。
 *
 *   根因已定位并修复：客户端半边读取了未在 `inject` 里声明的服务属性
 *   （`ctx.sidebarRightTabs` / `ctx.sidebarRight`），真 cordis 4 的 ctx 代理
 *   对此**抛错**（`cannot get property "X" without inject`），把 fiber 置为 FAILED。
 *   修法是改用 `ctx.get(name)` 安全读取（见完整实现 client.full.js 里的 safeService）。
 *
 *   为便于**分阶段验证**，第 1 阶段先只上宿主半边：
 *     第 1 阶段（本文件）：不注册任何槽位 → 页面 boot 入口百分百安全，
 *                          用来单独确认「宿主半边 + 工具 + HTTP 接口」不会让应用起不来。
 *     第 2 阶段：把 client.full.js 拷回成 client.js，再验证四个界面落点。
 *               （完整实现已通过 15 项客户端测试，含与 lib/core.js 的逐项算法比对。）
 *
 * 本文件必须保持「合法且加载即成功」：仍要调用 __ModuleLoader__.load，
 * 且 factory 返回带 apply 的对象，否则 boot 会报 import failed。
 */

window.__ModuleLoader__.load({
  id: 'dsh-study-assistant',
  factory(require) {
    // 仍然校验模块表：只允许 require('react')。即便当前没用到，也要保证
    // 与真机一致的模块表约束，避免到第 2 阶段才发现问题。
    const React = require('react');
    void React;

    return {
      inject: ['slots'],
      DESCRIPTORS: { phase: 1, slots: [] },
      apply() {
        // 第 1 阶段刻意不注册任何槽位。
        // 第 2 阶段这里会换成完整实现（见 client.full.js）。
      },
    };
  },
});
