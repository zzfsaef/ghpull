// SPDX-License-Identifier: MIT
/**
 * 来源（原始 URL + 镜像）的选择与打分。
 *
 * 两条来自 aria2 的经验：
 *   - 只有速度超过阈值（`SPEED_THRESHOLD`，aria2 取 20 KiB/s）的来源才算「快源」；
 *   - 长期均值用带计数器的 EMA：样本少时用滑动平均，样本够了切 0.8/0.2；
 *     一旦新均值掉到旧均值的 80% 以下，计数器清零（来源劣化就重新观察）。
 * 另外沿用「只保留不慢于最快源 50% 的候选」这条更保守的过滤。
 */

/** 低于此速率的来源不参与排序（字节/秒）。 */
export const SPEED_THRESHOLD = 20 * 1024;

/** 只保留不慢于最快源这个比例的候选。 */
export const FASTEST_RATIO = 0.5;

/** 均值跌破旧值的这个比例就重置计数器。 */
const DEGRADE_RATIO = 0.8;

/**
 * 内置镜像模板。**默认不启用**——它们是第三方志愿者服务，可用性与合法性都由用户自行判断，
 * 而且域名随时可能失效；要启用需显式 `--mirror-mode auto`。
 */
export const BUILTIN_MIRROR_TEMPLATES = Object.freeze([
  { name: "gh-proxy.com", template: "https://gh-proxy.com/{url}" },
  { name: "ghfast.top", template: "https://ghfast.top/{url}" },
  { name: "ghproxy.net", template: "https://ghproxy.net/{url}" },
]);

/**
 * 把模板展开成候选 URL。模板里必须含 `{url}`，否则抛错（静默忽略会让用户以为生效了）。
 * @param {string} url 原始 URL
 * @param {{name?: string, template: string}[]} templates
 * @returns {{name: string, url: string}[]}
 */
export function expandMirrors(url, templates) {
  /** @type {{name: string, url: string}[]} */
  const out = [];
  for (const entry of templates) {
    const template = typeof entry === "string" ? entry : entry.template;
    const name = typeof entry === "string" ? entry : entry.name ?? entry.template;
    if (!template.includes("{url}")) {
      throw new Error(`镜像模板必须包含 {url} 占位符：${template}`);
    }
    out.push({ name, url: template.split("{url}").join(url) });
  }
  return out;
}

/**
 * 来源速度台账。
 */
export class SourceStats {
  constructor() {
    /** @type {Map<string, {speed: number, counter: number, ok: number, fail: number, lastError: string}>} */
    this.records = new Map();
  }

  /** @param {string} url */
  #ensure(url) {
    let record = this.records.get(url);
    if (!record) {
      record = { speed: 0, counter: 0, ok: 0, fail: 0, lastError: "" };
      this.records.set(url, record);
    }
    return record;
  }

  /**
   * 记录一次成功传输的速率。
   * @param {string} url
   * @param {number} bps 字节/秒
   */
  recordSpeed(url, bps) {
    if (!Number.isFinite(bps) || bps <= 0) return;
    const record = this.#ensure(url);
    record.ok += 1;
    record.counter += 1;
    if (record.counter < 5) {
      // 样本少：滑动平均，避免第一个样本就把均值钉死
      record.speed = record.speed + (bps - record.speed) / record.counter;
    } else {
      const next = record.speed * 0.8 + bps * 0.2;
      if (record.speed > 0 && next < record.speed * DEGRADE_RATIO) {
        record.counter = 1; // 明显劣化：重新观察
        record.speed = next;
      } else {
        record.speed = next;
      }
    }
  }

  /**
   * 记录一次失败。
   * @param {string} url
   * @param {string} message
   */
  recordFailure(url, message) {
    const record = this.#ensure(url);
    record.fail += 1;
    record.lastError = message;
  }

  /**
   * @param {string} url
   */
  speedOf(url) {
    return this.records.get(url)?.speed ?? 0;
  }

  /**
   * @param {string} url
   */
  failuresOf(url) {
    return this.records.get(url)?.fail ?? 0;
  }

  /**
   * 打分：历史速度为主；没有任何样本的候选给一个中性分，让它有机会被试用。
   * @param {string} url
   */
  score(url) {
    const record = this.records.get(url);
    if (!record || record.ok === 0) return SPEED_THRESHOLD;
    return record.speed;
  }
}

/**
 * 从候选里挑出「不比最快源慢一半」的那些；全都低于阈值时，把最快的几个原样返回，
 * 因为「慢」也好过「没有」。
 * @param {{name: string, url: string}[]} candidates
 * @param {SourceStats} stats
 * @returns {{name: string, url: string}[]}
 */
export function selectFastest(candidates, stats) {
  if (candidates.length <= 1) return candidates.slice();
  const scored = candidates
    .map((candidate) => ({ candidate, score: stats.score(candidate.url) }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0].score;
  const fast = scored.filter((item) => item.score >= best * FASTEST_RATIO).map((item) => item.candidate);
  if (fast.length > 0) return fast;
  return scored.slice(0, 2).map((item) => item.candidate);
}
