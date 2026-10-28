// 找出作业列表接口（DataTables 服务端分页）的**确切请求形状**。
//
// 结论来自读平台自己的实现，不是猜的：
//   .probe-learn/dataTablePlugin.js:293-307
//     $.ajax({ "type": 'POST', "url": sSource, "dataType": "json",
//              "data": { aoData: JSON.stringify(aoData) },
//              "success": function(data){ if (data.result=='success') fnCallback(data.object); ... } })
//   .probe-learn/js__res_app_wlxt_js_jquery.js_v_839:11875-11898
//     var csrf_token = getCookie("XSRF-TOKEN");
//     function handleUrlWithCsrf(url){ ... url += "?_csrf=" + encodeURIComponent(csrf_token) }
//
// 所以：POST + x-www-form-urlencoded 的单个 `aoData` 参数 + URL 上的 `_csrf`。
// 之前只发 GET `?wlkcid=...`，三个条件全不满足 → http-400。
//
// 本脚本对同一个课堂号把若干候选形状各试一次，只打印状态码与正文开头，
// 用来确定「最少需要哪些 aoData 字段」。只发 GET/POST 读接口，绝不写。
const COOKIE = process.env.LEARN_COOKIE ?? '';
const BASE = 'https://learn.tsinghua.edu.cn';
const W = process.argv[2] ?? '2026-2027-1152225553';
const PATH = process.argv[3] ?? '/b/wlxt/kczy/zy/student/zyListWj';

if (COOKIE === '') {
  console.log('用法：$env:LEARN_COOKIE = "JSESSIONID=...; XSRF-TOKEN=..."; node tools/probe-learn-zy-shape.mjs [课堂号] [路径]');
  process.exitCode = 1;
} else {
  await main();
}

function xsrfOf(cookie) {
  const m = /(?:^|;\s*)XSRF-TOKEN=([^;]*)/.exec(cookie);
  return m ? decodeURIComponent(m[1]) : '';
}

// 标准 DataTables 1.9 的 aoData 骨架（jQuery DataTables 自己发的那一套）
function baseAoData(wlkcid) {
  return [
    { name: 'sEcho', value: 1 },
    { name: 'iColumns', value: 1 },
    { name: 'sColumns', value: '' },
    { name: 'iDisplayStart', value: 0 },
    { name: 'iDisplayLength', value: 100 },
    { name: 'mDataProp_0', value: 'bt' },
    { name: 'sSearch', value: '' },
    { name: 'bRegex', value: false },
    { name: 'sSearch_0', value: '' },
    { name: 'bRegex_0', value: false },
    { name: 'bSearchable_0', value: true },
    { name: 'bSortable_0', value: true },
    { name: 'iSortCol_0', value: 0 },
    { name: 'sSortDir_0', value: 'asc' },
    { name: 'iSortingCols', value: 0 },
    { name: 'wlkcid', value: wlkcid },
  ];
}

async function attempt(label, { method, url, body }) {
  const headers = {
    Cookie: COOKIE,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: 'application/json, text/javascript, */*; q=0.01',
    'X-Requested-With': 'XMLHttpRequest',
    'X-XSRF-TOKEN': xsrfOf(COOKIE),
  };
  if (body !== undefined) headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';

  try {
    const res = await fetch(BASE + url, { method, headers, body, redirect: 'manual' });
    const text = await res.text();
    const ok = res.status === 200;
    console.log(`${ok ? '✓' : '✗'} ${label}`);
    console.log(`    HTTP ${res.status}  正文 ${text.length} 字符`);
    if (ok) {
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { /* 不是 JSON */ }
      if (parsed && typeof parsed === 'object') {
        console.log(`    JSON 顶层键：${Object.keys(parsed).join(', ')}`);
        console.log(`    result = ${JSON.stringify(parsed.result)}   msg = ${JSON.stringify(parsed.msg)}`);
        const obj = parsed.object;
        if (Array.isArray(obj)) console.log(`    object 是数组，${obj.length} 项`);
        else if (obj && typeof obj === 'object') {
          console.log(`    object 顶层键：${Object.keys(obj).join(', ')}`);
          for (const k of ['aaData', 'iTotalRecords', 'iTotalDisplayRecords', 'sEcho']) {
            if (k in obj) console.log(`      ${k} = ${Array.isArray(obj[k]) ? `数组(${obj[k].length})` : JSON.stringify(obj[k])}`);
          }
          const rows = obj.aaData;
          if (Array.isArray(rows) && rows.length > 0) {
            console.log(`    第一行字段：${Object.keys(rows[0]).join(', ')}`);
            console.log(`    第一行样例：${JSON.stringify(rows[0]).slice(0, 300)}`);
          }
        }
      } else {
        console.log(`    正文开头：${text.slice(0, 300)}`);
      }
    } else {
      console.log(`    正文开头：${text.slice(0, 200)}`);
    }
  } catch (error) {
    console.log(`✗ ${label}`);
    console.log(`    异常：${error.message}`);
  }
  console.log();
}

async function main() {
  const csrf = encodeURIComponent(xsrfOf(COOKIE));
  const q = `${PATH}?wlkcid=${encodeURIComponent(W)}`;
  const qc = `${q}&_csrf=${csrf}`;
  const c = `${PATH}?_csrf=${csrf}`;

  console.log(`课堂号 ${W}`);
  console.log(`路径   ${PATH}`);
  console.log(`csrf   ${csrf === '' ? '（Cookie 里没有 XSRF-TOKEN）' : '已取到'}`);
  console.log();

  // 1. 原样复现旧探针（GET + 只带 wlkcid）
  await attempt('A. GET  ?wlkcid=...                    （旧探针的做法）', { method: 'GET', url: q });
  // 2. GET + _csrf
  await attempt('B. GET  ?wlkcid=...&_csrf=...', { method: 'GET', url: qc });
  // 3. POST + _csrf + 空 aoData
  await attempt('C. POST ?_csrf=...  body aoData=[]', { method: 'POST', url: c, body: 'aoData=' + encodeURIComponent('[]') });
  // 4. POST + _csrf + 只有 wlkcid 的 aoData
  await attempt('D. POST ?_csrf=...  body aoData=[{wlkcid}]', {
    method: 'POST', url: c,
    body: 'aoData=' + encodeURIComponent(JSON.stringify([{ name: 'wlkcid', value: W }])),
  });
  // 5. POST + _csrf + 完整 DataTables 骨架 + wlkcid
  await attempt('E. POST ?_csrf=...  body aoData=<完整骨架>', {
    method: 'POST', url: c,
    body: 'aoData=' + encodeURIComponent(JSON.stringify(baseAoData(W))),
  });
  // 6. POST + _csrf + 完整骨架，且 wlkcid 同时放在查询串上
  await attempt('F. POST ?wlkcid=...&_csrf=...  body aoData=<完整骨架>', {
    method: 'POST', url: qc,
    body: 'aoData=' + encodeURIComponent(JSON.stringify(baseAoData(W))),
  });

  process.exitCode = 0;
}
