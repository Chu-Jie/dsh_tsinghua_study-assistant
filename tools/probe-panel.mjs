/**
 * 把这段打印到浏览器控制台（F12 → Console → 粘贴 → 回车），再把输出发给开发方。
 *
 * 目的：判定「点击侧栏『学习辅助』之后中间区域空白」到底断在哪一环。
 * 关键判据：
 *   1) `main` 槽的锚点 [data-slot="main"] 存不存在 → 布局是否真的在渲染主面板槽；
 *   2) 锚点里有没有 [data-slot-error]      → 渲染器是否把这一格当成崩溃条目退化了；
 *   3) 锚点里的第一个元素是什么            → 到底渲染了哪一格（conversation 还是别的）；
 *   4) .sa-root 与 #sa-crash-banner       → 本插件面板有没有进 DOM。
 */

console.log(
  '%c[学习辅助探针]',
  'background:#0b5;color:#fff;padding:2px 6px;border-radius:3px',
  (() => {
    const out = {};

    // 1) 槽位锚点
    const anchor = document.querySelector('[data-slot="main"]');
    out['1_主面板槽锚点存在'] = !!anchor;

    // 2) 崩溃格子标记
    const crashed = document.querySelectorAll('[data-slot-error]');
    out['2_崩溃格子'] = [...crashed].map((e) => e.getAttribute('data-slot-error'));

    // 3) 锚点里实际渲染了什么
    out['3_锚点内元素'] = anchor
      ? [...anchor.querySelectorAll('*')]
          .slice(0, 4)
          .map((e) => `${e.tagName}.${e.className || ''}[${e.getAttribute('data-slot') ?? ''}]`)
      : null;

    // 4) 本插件的面板与崩溃横幅
    out['4_sa_root存在'] = !!document.querySelector('.sa-root');
    out['4_崩溃横幅'] = document.getElementById('sa-crash-banner')?.textContent?.slice(0, 400) ?? null;

    // 5) 所有已渲染的槽位锚点 + 每个槽位里前两个子元素（看谁在占位）
    out['5_全部槽位锚点'] = [...document.querySelectorAll('[data-slot]')].map((e) => {
      const kids = [...e.children]
        .slice(0, 2)
        .map((k) => `${k.tagName}.${String(k.className).slice(0, 40)}`)
        .join(' | ');
      return `${e.getAttribute('data-slot')} => ${kids || '(空)'}`;
    });

    // 6) 会话输入框 dock 是否渲染本插件的提醒（证明客户端半边是活的）
    out['6_sa_dock存在'] = !!document.querySelector('.sa-dock');

    return out;
  })(),
);
