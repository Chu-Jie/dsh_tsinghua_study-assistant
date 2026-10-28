/*
 * 主题皮肤冲突探针（纯 ES5，可直接粘进 DevTools Console）。
 *
 * 背景：用户报告「关闭主题插件后所有面板正常，开启后中间什么都没有」。
 * 本探针只做一件事：把「中间那格到底渲染了没有、有没有尺寸、被谁挡住」
 * 变成一组数字，避免继续猜。
 *
 * 用法：F12 → Console → 全选粘贴 → 回车。会打印一个 __SA_REPORT__ 对象，
 * 把最后一行的 JSON 复制回来即可（或在 Console 里右键 → Copy object）。
 */
(function () {
  var out = {};

  function info(el) {
    if (!el) return null;
    var cs = window.getComputedStyle(el);
    var r = el.getBoundingClientRect();
    return {
      tag: el.tagName,
      cls: String(el.className || '').slice(0, 80),
      w: Math.round(r.width),
      h: Math.round(r.height),
      top: Math.round(r.top),
      left: Math.round(r.left),
      display: cs.display,
      position: cs.position,
      zIndex: cs.zIndex,
      overflow: cs.overflow,
      contain: cs.contain,
      opacity: cs.opacity,
      visibility: cs.visibility,
      color: cs.color,
      bg: cs.backgroundColor,
      pointerEvents: cs.pointerEvents,
      transform: cs.transform
    };
  }

  function q(sel) {
    try { return document.querySelector(sel); } catch (e) { return null; }
  }

  // 0) 皮肤是否生效 + 皮肤投射的状态属性
  var body = document.body;
  out.skin = {
    onBody: body.hasAttribute('data-dsh-maid-atelier'),
    mailFlags: (function () {
      var flags = {};
      Array.prototype.forEach.call(body.attributes, function (a) {
        if (a.name.indexOf('data-maid-') === 0 || a.name.indexOf('data-dsh-whale') === 0) flags[a.name] = a.value || true;
      });
      return flags;
    })(),
    htmlFlags: (function () {
      var flags = {};
      Array.prototype.forEach.call(document.documentElement.attributes, function (a) {
        if (a.name.indexOf('data-maid-') === 0 || a.name.indexOf('data-dsh-whale') === 0) flags[a.name] = a.value || true;
      });
      return flags;
    })()
  };

  // 1) 关键容器
  // 注意：`.sa-root` 既能命中主面板容器，也可能命中**被渲染进槽位的 style 节点**
  // （style 也允许带 class，且会被 flex 拉成整列大小）——这正是 2026-09-30 那次
  // 「面板一片空白」的根因。用 data-sa-panel 精确区分，两个都报出来。
  out.nodes = {
    mainSlot: info(q('[data-slot="main"]')),
    realPanel: info(q('[data-sa-panel]')),
    saRootAny: info(q('.sa-root')),
    styleNodeInSlot: info(q('[data-slot="main"] > style')),
    cordisPanel: info(q('[data-cordis-panel]')),
    skinStage: info(q('[data-skin-chrome="character-stage"]')),
    topTrim: info(q('[data-skin-chrome="top-trim"]')),
    bottomTrim: info(q('[data-skin-chrome="bottom-trim"]')),
    leftMaid: info(q('[data-maid-character="left"]'))
  };

  // 2) main 槽锚点的祖先链（看哪一层把高度吃掉或藏起来）
  out.chain = (function () {
    var chain = [];
    var el = q('[data-slot="main"]');
    while (el && chain.length < 10) {
      chain.push(info(el));
      el = el.parentElement;
    }
    return chain;
  })();

  // 3) main 槽锚点里到底有几个子节点、各自是什么
  out.mainChildren = (function () {
    var anchor = q('[data-slot="main"]');
    if (!anchor) return null;
    return Array.prototype.slice.call(anchor.children).map(function (c) {
      var meta = info(c);
      meta.hasSaRoot = !!(c.querySelector && c.querySelector('.sa-root'));
      meta.textPreview = String(c.textContent || '').replace(/\s+/g, ' ').slice(0, 60);
      return meta;
    });
  })();

  // 4) 令牌实际取值（读 body 上的计算值）
  out.tokens = (function () {
    var names = [
      '--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-label-primary',
      '--dsw-specific-sidebar-fill', '--maid-sidebar-width'
    ];
    var cs = window.getComputedStyle(body);
    var values = {};
    names.forEach(function (n) { values[n] = (cs.getPropertyValue(n) || '').trim() || '<空>'; });
    return values;
  })();

  // 5) 命中 main 槽锚点的样式规则（找出来自皮肤的、可能影响它的声明）
  out.rulesTouchingMain = (function () {
    var hits = [];
    var anchor = q('[data-slot="main"]');
    if (!anchor) return hits;
    Array.prototype.forEach.call(document.styleSheets, function (sheet) {
      var rules = null;
      try { rules = sheet.cssRules; } catch (e) { return; }
      if (!rules) return;
      Array.prototype.forEach.call(rules, function (rule) {
        if (!rule.selectorText || !rule.style) return;
        // 只关心「能命中 main 槽锚点或其父级」的规则：按 .matches 实测
        var sel = rule.selectorText;
        if (sel.indexOf('data-slot') === -1 && sel.indexOf('centerCol') === -1 &&
            sel.indexOf('data-pane') === -1 && sel.indexOf('character-stage') === -1) return;
        var matched = false;
        try { matched = anchor.matches(sel); } catch (e) { matched = false; }
        if (!matched) return;
        var decl = [];
        ['display', 'position', 'z-index', 'height', 'width', 'overflow', 'contain', 'opacity', 'visibility'].forEach(function (p) {
          var v = rule.style.getPropertyValue(p);
          if (v) decl.push(p + ':' + v);
        });
        if (decl.length) hits.push(sel.slice(0, 120) + '  =>  ' + decl.join('; '));
      });
    });
    return hits;
  })();

  var json = JSON.stringify(out, null, 1);
  console.log('__SA_REPORT__');
  console.log(json);
  console.log('__SA_REPORT_END__');
  return json;
})();
