/**
 * 网络学堂会话心跳。
 *
 * 会话是「一段时间不操作就失效」的，而插件只有一张手动复制的 Cookie 快照。
 * 于是每 20 分钟让常驻的专用浏览器自己逛一遍学堂首页（失效就顺路走
 * `/f/login` → 清华 SSO → 回学堂，见 `learn-browser.js`），拿到的新 Cookie
 * 验活通过才落盘；续不上则把状态标成「需要重新登录」，让界面直接告诉用户
 * —— 而不是等他某天点开详情才发现。
 *
 * 为什么是「走浏览器」而不是「拿 Cookie 发个请求」：2026-10-12 实测只请求学堂
 * 时 Cookie 能保住，但清华 SSO 那边的会话没人喂，一旦真要续期就撞上人工登录。
 * 走浏览器的每一次导航都会经过 SSO，两边的会话一起被喂暖 —— 这才是能安静下来
 * 的关键。
 *
 * 这里只管**什么时候跑**；「跑什么」由调用方注入（`check`），所以本模块
 * 在测试里不需要网络、不需要浏览器。
 *
 * 局限（写在这里免得以后误以为它能包治百病）：DSH 没开着的时段心跳不跳，
 * 超过学校的空闲超时后会话照样会死。这时候靠的就是「下次开机自动续期」。
 */

/**
 * 心跳间隔：8 分钟。
 *
 * 2026-10-18 从 20 分钟改短：学堂那张 `JSESSIONID` 是**会话 Cookie + 服务端空闲
 * 超时**，20 分钟一跳离超时窗口太近 —— 只要某一跳迟了几十秒（渲染慢、CDP 慢），
 * 或者宿主被挂起过，就会错过窗口、票变死。8 分钟把余量做到两倍以上。
 *
 * 代价是每 8 分钟一次浏览器导航（≈几秒 CPU）。实测值得：宁可多喂几次，
 * 也不要每次都要人工重新登录。
 */
export const LEARN_KEEPALIVE_INTERVAL_MS = 8 * 60 * 1000;
/** 启动后先等一会儿再验：别和宿主自己的启动流程抢资源。 */
export const LEARN_KEEPALIVE_FIRST_DELAY_MS = 5000;

/**
 * 起一个心跳。
 *
 * @param {{check: (reason: string) => Promise<any>, intervalMs?: number,
 *   firstDelayMs?: number, logger?: object, onResult?: (result: any) => void}} options
 * @returns {{stop: () => void, runNow: (reason?: string) => Promise<any>}}
 */
export function startLearnKeepAlive(options = {}) {
  const check = options.check;
  if (typeof check !== 'function') throw new Error('check-required');
  const intervalMs = Number.isFinite(options.intervalMs) ? options.intervalMs : LEARN_KEEPALIVE_INTERVAL_MS;
  const firstDelayMs = Number.isFinite(options.firstDelayMs) ? options.firstDelayMs : LEARN_KEEPALIVE_FIRST_DELAY_MS;
  const logger = options.logger ?? console;
  const onResult = typeof options.onResult === 'function' ? options.onResult : null;

  let stopped = false;
  let inFlight = false;
  let timer = null;
  let lastRunAt = null;

  async function run(reason) {
    // 上一轮还没跑完就跳过这一轮：续期可能要十几秒，堆起来只会同时开好几个浏览器
    if (stopped || inFlight) return null;
    inFlight = true;
    lastRunAt = Date.now();
    try {
      const result = await check(reason);
      if (typeof onResult === 'function') onResult(result);
      return result;
    } catch (error) {
      // 心跳绝不能把宿主带崩：这里一律吞掉，只留日志
      logger.error?.('[study-assistant] 会话心跳异常：', error);
      return null;
    } finally {
      inFlight = false;
    }
  }

  const first = setTimeout(() => { void run('startup'); }, firstDelayMs);
  first.unref?.();
  timer = setInterval(() => {
    // 睡眠/休眠期间计时器不走，醒来后这一轮会迟到很久。迟到本身就说明墙钟上空了
    // 一大段、票多半已经过期 —— 单独记成 'resume'，日志里一眼能分出「睡过一夜」。
    const gap = lastRunAt === null ? 0 : Date.now() - lastRunAt;
    void run(gap > intervalMs * 3 ? 'resume' : 'timer');
  }, intervalMs);
  timer.unref?.();

  return {
    runNow: (reason = 'manual') => run(reason),
    stop() {
      stopped = true;
      clearTimeout(first);
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}
