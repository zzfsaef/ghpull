// SPDX-License-Identifier: MIT
/**
 * 速率统计：用固定长度的时间环（默认 10 秒）计算窗口速率。
 *
 * 为什么不用「两次采样的瞬时差值」：镜像的秒级抖动会被瞬时值无限放大，
 * 拿它做并发调整或「过慢判死」会误杀。aria2 的 `SpeedCalc` 就是 1 秒一格、
 * 默认 10 秒窗口（`WINDOW_TIME=10`），这里采用同一口径。
 */

/** 一格代表 1 秒。 */
const SLOT_MS = 1000;

export class SpeedCalc {
  /**
   * @param {{windowSec?: number, now?: () => number}} [options]
   */
  constructor(options = {}) {
    /** @type {number} */ this.windowSec = Math.max(1, options.windowSec ?? 10);
    /** @type {() => number} */ this.now = options.now ?? (() => Date.now());
    /** @type {{slot: number, bytes: number}[]} */ this.#slots = [];
    this.#startedAt = this.now();
    this.#lastBytesAt = null;
    this.#total = 0;
    this.#maxBps = 0;
  }

  /** @type {{slot: number, bytes: number}[]} */
  #slots;
  #startedAt;
  /** @type {number|null} */
  #lastBytesAt;
  #total;
  #maxBps;

  /**
   * 记入一段新到达的字节。
   * @param {number} bytes
   */
  add(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    const now = this.now();
    const slot = Math.floor(now / SLOT_MS);
    const last = this.#slots[this.#slots.length - 1];
    if (last && last.slot === slot) last.bytes += bytes;
    else this.#slots.push({ slot, bytes });
    this.#total += bytes;
    this.#lastBytesAt = now;
    this.#prune(slot);

    const bps = this.bps;
    if (bps > this.#maxBps) this.#maxBps = bps;
  }

  /** @param {number} currentSlot */
  #prune(currentSlot) {
    const oldest = currentSlot - (this.windowSec - 1);
    while (this.#slots.length > 0 && this.#slots[0].slot < oldest) this.#slots.shift();
  }

  /** 窗口内累计字节数。读取时才淘汰过期格子——否则「停了一段时间没新字节」的段会被算成还在高速下载。 */
  get windowBytes() {
    this.#prune(Math.floor(this.now() / SLOT_MS));
    return this.#slots.reduce((sum, s) => sum + s.bytes, 0);
  }

  /** 本对象建立以来累计字节数。 */
  get total() {
    return this.#total;
  }

  /**
   * 窗口速率（字节/秒）。
   *
   * 分母取「已经过去的窗口长度」而不是常量 windowSec：刚开始下载的一两秒里
   * 用满窗口当分母会把速率压得极低，从而误触发「过慢」判定。
   */
  get bps() {
    const elapsedSec = (this.now() - this.#startedAt) / 1000;
    const denom = Math.min(this.windowSec, elapsedSec);
    if (denom <= 0.25) return this.windowBytes; // 首 250ms：按字节数近似
    return this.windowBytes / denom;
  }

  /** 窗口内出现过的最高速率。 */
  get maxBps() {
    return this.#maxBps;
  }

  /** 距离最后一次收到字节过了多少毫秒；从未收到则返回自发起到现在的毫秒数。 */
  get idleMs() {
    return this.now() - (this.#lastBytesAt ?? this.#startedAt);
  }

  /** 已运行秒数。 */
  get elapsedSec() {
    return (this.now() - this.#startedAt) / 1000;
  }

  /** 清空窗口（换源重连时用，避免把旧源的速度算到新源头上）。 */
  reset() {
    this.#slots = [];
    this.#startedAt = this.now();
    this.#lastBytesAt = null;
  }
}
