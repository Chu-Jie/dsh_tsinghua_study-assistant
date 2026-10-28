/**
 * 听课提醒用的字典：学生姓名的同音字表 + 点名/提问提示词。
 *
 * ## 为什么按「音节 + 声调」匹配，而不是按拼音字母
 *
 * 只按字母匹配的话，`du` 会命中 都/读/度/独 —— 一节高数课里「都听懂了吧」
 * 「读一下这段」能触发几十次，提醒就彻底没用了。加上声调后：
 *
 *   示例姓名「杜浩阳」→ du4 hao4 yang2
 *
 *   - 全名 `du4 hao4 yang2`：几乎零误报；
 *   - 名字 `hao4 yang2`：像「浩阳/灏洋/皓扬」这种相邻组合，普通话里没有
 *     别的常用词长这样；
 *   - 姓氏单字 `du4`：单独出现完全不可靠（程度/速度/制度…），必须再叠一层
 *     「附近有称呼语」和「不落在常见词里」两个条件才认。
 *
 * ## 为什么故意把「都」「好」「号」排除在同音字表外
 *
 * 用户的要求是「名字只要是拼音一样就要提示」，但这三个字是极端高频词，
 * 而且它们的常用读音与目标音节不同（都 dōu、好 hǎo、号 hào 多半是「学号/
 * 号码」）。放进来等于把误报率放大一个数量级。识别出的**错字**本来就更可能
 * 是形近/音近的冷僻同音字（昊/浩/皓/灏），而不是这些高频字。
 * 如果实际使用中发现确实漏了某个字，往 `SYLLABLE_CHARS` 里加即可。
 *
 * ⚠️ 这个清单需要学生本人过一遍确认（原计划就是「开工时把同音字清单列给
 *    用户逐字确认」）。
 */

/** 默认学生姓名。可被插件配置 `studentName` 覆盖。 */
export const DEFAULT_STUDENT_NAME = '示例同学';

/**
 * 音节（带声调）→ 该音节的候选汉字。
 *
 * 只覆盖姓名用到的音节。刻意不装完整拼音全表：那需要几 MB 的数据，
 * 而这里只需要三个音节、几十个字。
 */
export const SYLLABLE_CHARS = {
  du4: '杜度渡镀肚妒蠹',
  hao4: '昊浩皓灏淏颢',
  yang2: '阳洋扬杨羊佯徉炀',
};

/** 字 → 音节。由 `SYLLABLE_CHARS` 反推，避免两张表不同步。 */
export const SYLLABLE_OF = (() => {
  const map = new Map();
  for (const [syllable, chars] of Object.entries(SYLLABLE_CHARS)) {
    for (const ch of chars) if (!map.has(ch)) map.set(ch, syllable);
  }
  return map;
})();

/**
 * 姓氏单字匹配的「误报词」清单。
 *
 * 命中位置只要落在这些词的范围内，就判定为误报。这是姓氏单字那一档的
 * 第二道闸 —— 第一道是「附近必须有称呼语」。
 */
export const SURNAME_FALSE_WORDS = [
  '程度', '速度', '制度', '温度', '态度', '角度', '深度', '宽度', '长度', '高度',
  '浓度', '密度', '进度', '力度', '幅度', '厚度', '强度', '难度', '精度', '尺度',
  '维度', '亮度', '硬度', '湿度', '频度', '灰度', '弧度', '坡度', '限度', '跨度',
  '虚度', '再度', '月度', '年度', '季度', '一度', '两度', '三度', '几度', '百度',
  '度过', '过渡', '渡口', '渡江', '渡船', '度假', '度量', '度数', '镀金', '肚子',
  '嫉妒', '妒忌', '蠹虫',
];

/** 点名 / 签到动作本身。落进这一档说明「要签到了」，值得最高级别提醒。 */
export const ROLLCALL_CUES = [
  '点名', '点到', '签到', '签到码', '签一下', '打卡', '扫码', '二维码',
  '雨课堂', '学习通', '随机点', '随机抽', '抽一个', '抽人', '点名册', '考勤',
];

/** 直接要求作答（点名式提问）—— 需要立刻反应。 */
export const STRONG_QUESTION_CUES = [
  '谁来回答', '谁来答', '谁来', '请回答', '举手', '你来说', '你来讲',
  '同学来', '有没有同学', '随堂测', '小测', '指名',
];

/** 一般性的提问 / 练习 —— 值得一眼扫到，但不必打断。 */
export const QUESTION_CUES = [
  '这道题', '这一题', '这个题', '这个问题', '思考一下', '想一想', '想一下',
  '做一下', '选什么', '答案是', '正确答案', '小组讨论', '讨论一下',
  '做个练习', '课堂练习', '下面这道', '提问',
];

/** 称呼语。只用于「姓氏单字」那一档，用来确认老师确实在叫一个人。 */
export const ADDRESS_CUES = [
  '同学', '在吗', '到了吗', '来了吗', '在哪', '你来', '你来答', '你来回答',
  '请回答', '说一下', '讲一下', '回答一下',
];

/** 字符类里只允许放汉字，防止配置进来的字符串把正则改坏。 */
function classChars(chars) {
  let out = '';
  for (const ch of String(chars ?? '')) {
    if (/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/.test(ch)) out += ch;
  }
  return out;
}

/**
 * 拆成「每个字一个候选字符类」。
 *
 * 表里没有的字退化成它自己 —— 这样姓名配成「张三」这种表外名字时，
 * 仍然能做精确匹配，只是没有同音容错。
 */
export function nameClasses(name) {
  const out = [];
  for (const ch of String(name ?? '')) {
    const syllable = SYLLABLE_OF.get(ch);
    out.push(syllable === undefined ? ch : classChars(SYLLABLE_CHARS[syllable]));
  }
  return out;
}

/**
 * 把「姓名变体」配置拆成数组。
 *
 * 语音转写把同一个名字写成别的字是常态（同音、近音、室友的绰号）。配置项里用
 * 顿号、逗号、空白都行，这里一次拆干净；空串返回空数组（= 只用同音字表）。
 *
 * @param {string|string[]} input 配置原文
 * @returns {string[]}
 */
export function parseNameVariants(input) {
  const text = Array.isArray(input) ? input.join('、') : String(input ?? '');
  return text
    .split(/[\s,，、;；/|]+/u)
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/** 转义成正则字面量（变体按原文匹配，不解释元字符）。 */
function literalSource(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 为姓名建匹配器。
 *
 * @param {string} name 姓名
 * @param {string|string[]} [variants] 变体（同音字/绰号），按原文精确匹配
 * @returns {{
 *   name: string,
 *   syllables: (string|undefined)[],
 *   classes: string[],
 *   full: RegExp|null,     整名，如 du4 hao4 yang2
 *   given: RegExp|null,    名（去掉姓），如 hao4 yang2
 *   surname: RegExp|null,  姓单字，只在 ≥3 字姓名时给出
 *   variants: RegExp[],    变体字面量
 * }}
 */
export function buildNameMatcher(name, variants = []) {
  const safe = String(name ?? '').trim() || DEFAULT_STUDENT_NAME;
  const chars = [...safe];
  const classes = nameClasses(safe);
  const syllables = chars.map((ch) => SYLLABLE_OF.get(ch));
  const source = classes.map((c) => (c.length > 1 ? `[${c}]` : c)).join('');
  const extras = parseNameVariants(variants)
    .filter((item) => item !== safe)
    .map((item) => new RegExp(literalSource(item), 'g'));

  return {
    name: safe,
    syllables,
    classes,
    full: source === '' ? null : new RegExp(source, 'g'),
    given: chars.length >= 3 ? new RegExp(classes.slice(1).map((c) => (c.length > 1 ? `[${c}]` : c)).join(''), 'g') : null,
    surname: chars.length >= 3 ? new RegExp(classes[0].length > 1 ? `[${classes[0]}]` : classes[0], 'g') : null,
    variants: extras,
  };
}
