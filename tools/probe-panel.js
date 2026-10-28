/**
 * 浏览器控制台探针（纯脚本，可直接粘贴）。
 *
 * 用法：F12 → Console → 粘贴本文件全部内容 → 回车 → 把输出截图或复制回来。
 *
 * 判据：
 *   1) [data-slot="main"] 存不存在        → 布局是否真的渲染了主面板槽
 *   2) [data-slot-error] 有哪些           → 渲染器是否把某格当崩溃条目退化了
 *   3) 主面板槽里第一个元素是什么          → 实际渲染的是哪一格
 *   4) .sa-root / #sa-crash-banner        → 本插件面板有没有进 DOM、有没有崩
 *   5) 所有槽位锚点及各自子元素            → 谁在占位
 *   6) .sa-dock                            → 客户端半边是否活着
 */
console.log('%c[学习辅助探针]', 'background:#0b5;color:#fff;padding:2px 6px;border-radius:3px', (function () {
  var out = {};
  var anchor = document.querySelector('[data-slot="main"]');
  out['1_主面板槽锚点存在'] = !!anchor;
  out['2_崩溃格子'] = Array.prototype.map.call(
    document.querySelectorAll('[data-slot-error]'),
    function (e) { return e.getAttribute('data-slot-error'); }
  );
  out['3_锚点内元素'] = anchor
    ? Array.prototype.slice.call(anchor.querySelectorAll('*'), 0, 4).map(function (e) {
        return e.tagName + '.' + (e.className || '') + '[data-slot=' + (e.getAttribute('data-slot') || '') + ']';
      })
    : null;
  var root = document.querySelector('.sa-root');
  out['4_sa_root存在'] = !!root;
  out['4_崩溃横幅'] = document.getElementById('sa-crash-banner')
    ? document.getElementById('sa-crash-banner').textContent.slice(0, 400)
    : null;
  out['4_sa_root尺寸'] = root
    ? root.getBoundingClientRect().width + 'x' + root.getBoundingClientRect().height
    : null;
  out['5_全部槽位锚点'] = Array.prototype.map.call(document.querySelectorAll('[data-slot]'), function (e) {
    var kids = Array.prototype.slice.call(e.children, 0, 2).map(function (k) {
      return k.tagName + '.' + String(k.className).slice(0, 40);
    }).join(' | ');
    return e.getAttribute('data-slot') + ' => ' + (kids || '(空)');
  });
  out['6_sa_dock存在'] = !!document.querySelector('.sa-dock');

  // 7) 关键判据：侧栏按钮的 aria-current="page" 表示「这一格已被选中」。
  //    如果『学习辅助』那行是 null，说明点击根本没生效（选择态没变），
  //    中间区域当然是上一个面板 —— 那就不是渲染问题，是选择问题。
  var rows = document.querySelectorAll('button[aria-label]');
  out['7_侧栏按钮选中态'] = Array.prototype.filter.call(rows, function (b) {
    return b.getAttribute('aria-current') === 'page' || /学习|插件|设置|会话/.test(b.getAttribute('aria-label') || '');
  }).map(function (b) {
    return (b.getAttribute('aria-label') || '?') + ' => aria-current=' + b.getAttribute('aria-current');
  });

  // 8) 主面板槽的容量与位置：确认它是不是真的在中间那一列
  if (anchor) {
    var r = anchor.getBoundingClientRect();
    var p = getComputedStyle(anchor);
    out['8_主面板槽位置'] = {
      rect: Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height),
      display: p.display,
      childCount: anchor.children.length,
    };
  }

  return out;
})());
