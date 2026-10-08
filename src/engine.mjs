// SPDX-License-Identifier: MIT
/**
 * 下载引擎。
 *
 * 一句话：把文件看成一串「空洞」，谁空着谁去补；空洞够大就从中点切开给另一条连接。
 * 这条规则同时覆盖了三件事——初始铺开、慢尾再切分、收尾不让最后一块单飞——
 * 也就是 aria2 里 `min-split-size` / `SegmentMan` / endgame 三处逻辑的合并简化版。
 *
 * 与参考实现的差异（有意为之，写在 README 的「设计取舍」里）：
 *   - 不做 Metalink 分块校验，也不做 BT/RPC：v0.1 只解决 HTTP 分段下载。
 *   - endgame 用「把最后的大空洞继续对半切」近似 aria2 的「重复请求同一片」，
 *     不重复写同一段字节，因此不会出现同一段被两个连接交错写入的情形。
 */

import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { rename, rm, truncate, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  ChecksumError,
  DestinationExistsError,
  GhpullError,
  NoSourceError,
  UsageError,
} from "./errors.mjs";
import { SpeedCalc } from "./speed.mjs";
import { BUILTIN_MIRROR_TEMPLATES, SourceStats, expandMirrors, selectFastest } from "./source.mjs";
import { clearParts, ensurePartsDir, partFileFor, readState, stateFileFor, writeState } from "./state.mjs";
import { openRange, probe } from "./transport.mjs";
import { compareHash, parseExpectedHash, sizeOf } from "./verify.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 并发调整的采样间隔（秒）与步长——沿用 dl.mjs 实测有效的那组数字。 */
const SAMPLE_SEC = 6;
const SAMPLE_STEP = 2;

/**
 * 自适应并发的**启动闸门**（`--no-adaptive` 可关）。
 *
 * 实测（同一 66MB 文件、直连、20s 一臂、8 轮轮转）：单连接能跑到 11.27 MiB/s，
 * 而一上来就摊开 8 条连接反被钉在 2.06 MiB/s（每条约 0.26 MiB/s）——健康链路上
 * 并发是**惩罚**；只有单连接被饿住（0.02 MiB/s）时，8 连接才反过来赢 40 倍以上。
 * 所以默认先只开 1 条连接测速：够快就不摊开，确认真被限速才逐级升到 `--conns`。
 */
const RAMP_FAST_BPS = 4 * 1024 * 1024;
const RAMP_STARVED_BPS = 256 * 1024;
const RAMP_IMPROVE = 1.15;

/** 状态落盘的间隔（毫秒）。 */
const STATE_SAVE_MS = 3000;

/** 来源失败后的冷却时间（毫秒）。 */
const SOURCE_COOLDOWN_MS = 30000;

/**
 * 单个候选源的竞速预算（毫秒）。
 *
 * 竞速的目的只是「挑一条更快的源」，不该变成新的等待点：实测在公共镜像上，
 * 一个候选卡到自己的超时（15s）会把整个启动拖到十几秒才落第一个字节。
 * 预算内测不到数据就按「不可用」记，让下载立刻用剩下的源开跑。
 * 测试里用 `raceBudgetMs` 覆盖成一个很小的值。
 */
const RACE_BUDGET_MS = 5000;

/** 探测阶段最多尝试几个来源（原始地址 + 若干镜像），避免全部不可用时挨个耗满超时。 */
const PROBE_TARGETS_MAX = 4;

/** 一个分段。 */
class Segment {
  /**
   * @param {number} id
   * @param {number} start
   * @param {number} end 闭区间
   */
  constructor(id, start, end) {
    this.id = id;
    this.start = start;
    this.end = end;
    /** 已经落到分片文件里的字节数（相对 start）。 */
    this.done = 0;
    /** @type {"pending"|"active"|"done"} */
    this.status = "pending";
    this.attempts = 0;
    /** 中止原因：`split`=自己切分让位给新连接、`stall`=看门狗、`cancel`=用户取消。 */
    this.abortKind = "";
    /** @type {AbortController|null} */
    this.controller = null;
    /** @type {SpeedCalc|null} */
    this.speed = null;
  }

  get length() {
    return this.end - this.start + 1;
  }

  get remaining() {
    return this.length - this.done;
  }
}

export class Engine {
  /**
   * @param {import("./args.mjs").CliOptions & {signal?: AbortSignal}} options
   * @param {{onEvent?: (event: any) => void, log?: (message: string) => void}} [hooks]
   */
  constructor(options, hooks = {}) {
    this.opts = options;
    this.hooks = hooks;
    this.signal = options.signal;
    /** @type {Segment[]} */
    this.segments = [];
    this.stats = new SourceStats();
    /** @type {{name: string, url: string}[]} */
    this.candidates = [];
    /** @type {Map<string, number>} */
    this.sourceCooldown = new Map();
    this.globalSpeed = new SpeedCalc({ windowSec: 10 });
    this.nextSegmentId = 0;

    this.size = 0;
    this.out = "";
    this.finalUrl = options.url;
    this.transport = options.transport;
    this.startedAt = Date.now();
    this.reusedBytes = 0;
    this.fetchedBytes = 0;
    this.peakConns = 0;
    this.activeCount = 0;
    this.targetConns = 1;
    this.lastSampleAt = Date.now();
    this.lastSampleBps = 0;
    /** 启动闸门状态：档位表、当前档、窗口起点与窗口内已抓字节数。 */
    this.rampStages = [1];
    this.rampStageIndex = 0;
    this.rampBestBps = 0;
    this.rampBestStage = 1;
    this.rampLocked = true;
    this.rampWindowAt = Date.now();
    this.rampWindowBytes = 0;
    this.lastSaveAt = 0;
    this.lastProgressAt = 0;
    this.fatal = null;
    this.aborted = false;
    this.singleStream = false;
    this.lastError = "";
  }

  /** 事件（进度/日志）出口。 */
  emit(event) {
    this.hooks.onEvent?.(event);
  }

  /** @param {string} message */
  log(message) {
    this.hooks.log?.(message);
  }

  /**
   * 跑完一次下载。
   * @returns {Promise<object>} 结果摘要
   */
  async run() {
    // 1) 输出路径已知时，先做覆盖保护——必须在联网之前拒绝，否则白白建立连接
    if (this.opts.out) {
      this.out = path.resolve(this.opts.out);
      await this.#guardDestination({ beforeNetwork: true });
    }

    if (this.opts.sha256) {
      try {
        this.expectedHash = parseExpectedHash(this.opts.sha256);
      } catch (error) {
        throw new UsageError(/** @type {Error} */ (error).message);
      }
    } else {
      this.expectedHash = "";
    }

    // 2) 探测目标：先原始地址，失败时依次试镜像。
    //    `--mirror` 的意义就是「原始地址不行时还有别的源」；实测在热点链路下原始地址会整段
    //    返回 504 / SSL 超时，若只探原始地址，整轮下载在建立分段连接之前就被判死，镜像永远轮不到。
    const probeTargets = this.#buildCandidates().slice(0, PROBE_TARGETS_MAX);
    let probed = null;
    /** @type {unknown} */
    let probeError = null;
    for (const target of probeTargets) {
      try {
        probed = await probe(target.url, {
          transport: this.opts.transport,
          timeoutSec:
            target.name === "origin" ? this.opts.timeoutSec : Math.min(this.opts.timeoutSec, 15),
          maxSockets: this.opts.maxConns,
          curlPath: this.opts.curlPath,
        });
        if (target.name !== "origin") {
          this.log(`原始地址探测失败，改用镜像来源：${target.url}`);
          this.emit({ type: "probe-mirror", name: target.name, url: target.url });
        }
        break;
      } catch (error) {
        if (probeError === null) probeError = error;
        const message = /** @type {Error} */ (error).message;
        this.stats.recordFailure(target.url, message);
        this.emit({ type: "probe-failed", name: target.name, url: target.url, error: message });
      }
    }
    if (probed === null) throw probeError;
    this.finalUrl = probed.finalUrl;
    this.size = probed.size ?? 0;
    this.transport = probed.transport;
    if (!this.opts.out) {
      const name = path.basename(probed.filename || "download.bin");
      this.out = path.resolve(name);
      await this.#guardDestination({ beforeNetwork: false });
    }
    this.emit({ type: "probe", size: this.size, transport: this.transport, out: this.out, acceptRanges: probed.acceptRanges });

    if (this.size === 0) return this.#finishEmpty();
    if (!probed.acceptRanges) {
      this.singleStream = true;
      return this.#runSingleStream(probed);
    }

    // 3) 候选来源
    this.candidates = this.#buildCandidates();
    if (this.candidates.length > 1) await this.#raceSources();

    // 4) 分段（有断点就复用）
    await this.#loadOrPlanSegments(probed);

    // 5) 并发跑
    await this.#runSegmented();

    // 6) 合并 + 校验 + 落位
    return this.#finish();
  }

  /** 覆盖保护。 */
  async #guardDestination({ beforeNetwork }) {
    if (this.opts.force) return;
    const existing = await sizeOf(this.out);
    if (existing === null) return;
    if (this.opts.continueDownload) return;
    const state = this.opts.resume ? await readState(this.out) : null;
    if (state) return; // 是我们自己的断点，允许继续
    void beforeNetwork;
    throw new DestinationExistsError(
      `输出文件已存在，拒绝覆盖：${this.out}\n（要续传请加 --continue；要重新下载请加 --force）`,
    );
  }

  /** size 为 0 的资源：不联网建连，直接落一个空文件并校验。 */
  async #finishEmpty() {
    await rm(this.out, { force: true });
    await writeFile(this.out, "");
    const actualHash = createHash("sha256").digest("hex");
    if (this.expectedHash && this.expectedHash !== actualHash) {
      throw new ChecksumError(
        `SHA-256 不一致：期望 ${this.expectedHash.slice(0, 12)}…，实际 ${actualHash.slice(0, 12)}…`,
      );
    }
    const result = {
      ok: true,
      url: this.opts.url,
      out: this.out,
      bytes: 0,
      elapsedSec: 0,
      avgBps: 0,
      reusedBytes: 0,
      fetchedBytes: 0,
      fetchBps: 0,
      peakConns: 0,
      sources: 1,
      transport: this.transport,
      sha256: actualHash,
    };
    this.emit({ type: "done", result });
    return result;
  }

  /** 展开镜像模板。 */
  #buildCandidates() {
    const templates =
      this.opts.mirrorMode === "auto"
        ? [...BUILTIN_MIRROR_TEMPLATES, ...this.opts.mirrors.map((template) => ({ name: template, template }))]
        : this.opts.mirrors.map((template) => ({ name: template, template }));
    const mirrorList = expandMirrors(this.opts.url, templates).filter((entry) => entry.url !== this.opts.url);
    return [{ name: "origin", url: this.opts.url }, ...mirrorList];
  }

  /**
   * 来源竞速：每个候选实抓一段（默认 256KiB）测真实速率，再按「不慢于最快源 50%」过滤。
   * 只有多个候选时才做——单源时竞速纯属浪费。
   *
   * 每个候选都有预算（默认 RACE_BUDGET_MS）：卡住的候选按「不可用」处理并被踢出，
   * 绝不为它多等（旧实现用 Promise.all 等最慢的那个，等于把最慢源的超时加到启动路径上）。
   */
  async #raceSources() {
    const raceBytes = 256 * 1024;
    const budgetMs = Number(this.opts.raceBudgetMs ?? RACE_BUDGET_MS);
    this.emit({ type: "race", candidates: this.candidates.length, budgetMs });
    const measured = await Promise.all(
      this.candidates.map((candidate) => this.#measureCandidate(candidate, raceBytes, budgetMs)),
    );
    const usable = measured.filter((entry) => entry.ok && entry.bps > 0);
    this.emit({
      type: "race-done",
      results: measured.map((entry) => ({ name: entry.name, bps: Math.round(entry.bps), ok: entry.ok })),
    });
    if (usable.length === 0) return; // 全都失败：交给正式下载去报错
    this.candidates = selectFastest(
      usable.map((entry) => ({ name: entry.name, url: entry.url })),
      this.stats,
    );
  }

  /**
   * 量一个候选源。预算内没拿到数据就按「不可用」记 —— 绝不为了等它把启动拖住。
   * @param {{name: string, url: string}} candidate
   * @param {number} raceBytes
   * @param {number} budgetMs
   */
  async #measureCandidate(candidate, raceBytes, budgetMs) {
    const started = Date.now();
    /** @type {{bytes: AsyncIterable<Buffer>, abort: () => void}|null} */
    let stream = null;
    let expired = false;
    let bytes = 0;
    const timer = setTimeout(() => {
      expired = true;
      try {
        stream?.abort();
      } catch {
        /* 已经结束了 */
      }
    }, budgetMs);
    try {
      stream = await openRange(candidate.url, {
        start: 0,
        end: raceBytes - 1,
        transport: this.opts.transport,
        timeoutSec: Math.min(this.opts.timeoutSec, Math.ceil(budgetMs / 1000)),
        maxSockets: this.opts.maxConns,
        curlPath: this.opts.curlPath,
      });
      for await (const chunk of stream.bytes) {
        bytes += /** @type {Buffer} */ (chunk).length;
        if (bytes >= raceBytes) break;
      }
    } catch (error) {
      if (!expired) {
        this.stats.recordFailure(candidate.url, /** @type {Error} */ (error).message);
        return { ...candidate, bps: 0, ok: false };
      }
    } finally {
      clearTimeout(timer);
      try {
        stream?.abort();
      } catch {
        /* 已经结束了 */
      }
    }
    if (bytes === 0) {
      this.stats.recordFailure(candidate.url, `竞速超时（${budgetMs}ms 内没有数据）`);
      return { ...candidate, bps: 0, ok: false, timeout: true };
    }
    const seconds = Math.max(0.05, (Date.now() - started) / 1000);
    const bps = bytes / seconds;
    this.stats.recordSpeed(candidate.url, bps);
    return { ...candidate, bps, ok: true };
  }

  /** 有断点就续，没有就规划。 */
  async #loadOrPlanSegments(probed) {
    const minSplit = this.opts.minSplit;
    const state = this.opts.resume && !this.opts.force ? await readState(this.out) : null;
    if (state && state.size === this.size && (state.url === this.opts.url || state.url === this.finalUrl)) {
      const restored = [];
      for (const entry of state.segments) {
        const segment = new Segment(this.nextSegmentId++, entry.start, entry.end);
        const onDisk = await sizeOf(partFileFor(this.out, entry.start, entry.end));
        if (onDisk === segment.length) segment.done = segment.length;
        else if (onDisk !== null && onDisk > 0 && onDisk < segment.length) segment.done = onDisk;
        else if (onDisk !== null) {
          segment.done = 0;
          await rm(partFileFor(this.out, entry.start, entry.end), { force: true });
        }
        segment.status = segment.remaining === 0 ? "done" : "pending";
        restored.push(segment);
      }
      if (restored.length > 0 && restored.every((segment) => segment.remaining === 0)) {
        this.segments = restored;
        this.reusedBytes = this.size;
        this.emit({ type: "resume", segments: restored.length, reused: this.reusedBytes, complete: true });
        return;
      }
      this.segments = restored;
      this.reusedBytes = restored.reduce((sum, segment) => sum + segment.done, 0);
      this.emit({ type: "resume", segments: restored.length, reused: this.reusedBytes, complete: false });
      return;
    }

    if (this.opts.force) await clearParts(this.out);
    await ensurePartsDir(this.out);
    // 自适应并发下先只切一段：等启动测速窗口（#adaptConcurrency）确认真需要更多连接，
    // 再由 #maybeSplit 按 targetConns 逐步切开 —— 免得一上来就把链路摊成 8 条。
    const initialTarget = this.opts.adaptive && this.opts.conns > 1
      ? 1
      : Math.max(1, Math.min(this.opts.conns, Math.floor(this.size / (2 * minSplit)) || 1));
    this.segments = [new Segment(this.nextSegmentId++, 0, this.size - 1)];
    while (this.segments.length < initialTarget) {
      const largest = this.#largestSplittable(minSplit);
      if (!largest) break;
      this.#split(largest);
    }
    this.reusedBytes = 0;
    this.emit({ type: "plan", segments: this.segments.length, minSplit, initialTarget, adaptive: this.opts.adaptive === true });
  }

  /** @param {number} minSplit */
  #largestSplittable(minSplit) {
    let best = null;
    for (const segment of this.segments) {
      if (segment.remaining < 2 * minSplit) continue;
      if (!best || segment.remaining > best.remaining) best = segment;
    }
    return best;
  }

  /**
   * 从剩余部分的中点切开：左边保留原编号与分片文件，右边新建。
   * 切点落在**未下载区**的中点，保证左边已有的字节仍然合法。
   * @param {Segment} segment
   */
  #split(segment) {
    const cut = segment.start + segment.done + Math.floor(segment.remaining / 2);
    const right = new Segment(this.nextSegmentId++, cut, segment.end);
    segment.end = cut - 1;
    const index = this.segments.indexOf(segment);
    this.segments.splice(index + 1, 0, right);
    if (segment.status === "active") {
      // 只发中止信号，**不能**在这里把它放回队列：写循环还在收尾（可能要等 drain），
      // 提前标成 pending 会让另一个 worker 抢到同一段、同时打开同一个分片文件写同一段
      // 偏移，两个写入者交错就写出重复/错位的字节。放回队列由 #downloadSegment 的
      // split 分支在写循环真正结束后完成。
      segment.abortKind = "split";
      segment.controller?.abort();
    }
    return right;
  }

  /** 主循环：worker 抢段 + 定时器做自适应/看门狗/再切分。 */
  async #runSegmented() {
    // 默认自适应：先按闸门的第一档开（通常就是 1 条连接）测速，够快就不摊开；
    // `--no-adaptive` 时直接按 --conns 开满。分段数会在运行中增长，不受初始分段数限制。
    this.rampStages = this.#planStages();
    this.rampStageIndex = 0;
    this.rampBestBps = 0;
    this.rampBestStage = this.rampStages[0];
    this.rampLocked = !this.opts.adaptive || this.rampStages.length === 1;
    this.rampWindowAt = Date.now();
    this.rampWindowBytes = this.fetchedBytes;
    this.targetConns = this.opts.adaptive
      ? this.rampStages[0]
      : Math.max(1, Math.min(this.opts.conns, this.opts.maxConns));
    const ticker = this.#startTicker();
    // worker 按上限开满，超出的那些在闸门前每 50ms 轮询一次——不占带宽，
    // 但保证分段一多就立刻有人接手。
    const workerCount = Math.max(1, this.opts.maxConns);
    const workers = [];
    for (let i = 0; i < workerCount; i += 1) workers.push(this.#worker(i));
    try {
      await Promise.all(workers);
    } finally {
      clearInterval(ticker);
    }
    if (this.fatal) throw this.fatal;
    if (this.aborted || this.signal?.aborted) throw new GhpullError("已取消");
    const incomplete = this.segments.filter((segment) => segment.remaining > 0);
    if (incomplete.length > 0) {
      throw new GhpullError(
        `还有 ${incomplete.length} 个分段没下完（共 ${incomplete.reduce((sum, s) => sum + s.remaining, 0)} 字节）。` +
          `已保留断点，重新运行可继续。`,
      );
    }
  }

  /** 定时器：进度、自适应并发、看门狗、再切分、状态落盘。 */
  #startTicker() {
    return setInterval(() => {
      try {
        this.#tick();
      } catch (error) {
        this.fatal = /** @type {Error} */ (error);
      }
    }, 250);
  }

  #tick() {
    if (this.signal?.aborted) {
      this.aborted = true;
      for (const segment of this.segments) {
        segment.abortKind = "cancel";
        segment.controller?.abort();
      }
      return;
    }
    const now = Date.now();
    this.#checkWatchdogs(now);
    this.#maybeSplit(now);
    this.#adaptConcurrency(now);
    this.#reportProgress(now);
    if (now - this.lastSaveAt > STATE_SAVE_MS) {
      this.lastSaveAt = now;
      void this.#saveState();
    }
  }

  /** 停滞 / 过慢 判定：杀掉并放回队列，由别的来源重试。 */
  #checkWatchdogs(now) {
    for (const segment of this.segments) {
      if (segment.status !== "active" || !segment.speed || !segment.controller) continue;
      const speed = segment.speed;
      const idleSec = speed.idleMs / 1000;
      const tooSlow = speed.elapsedSec > 10 && speed.bps < this.opts.lowestSpeed;
      if (idleSec >= this.opts.stallSec || tooSlow) {
        const reason = idleSec >= this.opts.stallSec ? `停滞 ${Math.round(idleSec)}s 无新字节` : `速率 ${Math.round(speed.bps)}B/s 低于下限`;
        this.lastError = reason;
        this.emit({ type: "stall", segment: segment.start, reason });
        segment.abortKind = "stall";
        segment.controller.abort();
      }
    }
    void now;
  }

  /**
   * 有空闲连接就去切最大的空洞；收尾阶段允许切得更碎（endgame 近似）。
   */
  #maybeSplit(now) {
    void now;
    const endgameRemaining = this.segments.reduce((sum, s) => sum + s.remaining, 0);
    const endgame = endgameRemaining <= Math.max(2 * this.opts.minSplit, 4 * 1024 * 1024);
    const threshold = endgame ? Math.max(256 * 1024, Math.floor(this.opts.minSplit / 8)) : this.opts.minSplit;
    // 连接上限只由自适应目标决定；endgame 放宽的是「切多细」，不是「开几条」。
    const ceiling = this.targetConns;
    while (this.activeCount < ceiling) {
      const largest = this.#largestSplittable(threshold);
      if (!largest) break;
      const wasActive = largest.status === "active";
      this.#split(largest);
      this.emit({ type: "split", at: largest.end + 1, remaining: endgameRemaining, active: wasActive });
    }
  }

  /**
   * 自适应并发。
   *
   * 默认走**启动闸门**：先只开 1 条连接，每 `SAMPLE_SEC` 秒看一次这一档真实跑出来的
   * 速率，只有「确实更快」或者「被限速（低于下限）」才加连接，最多到 `--conns`；
   * 加档没换来速度就退回最好的一档并锁死。实测见 README「Segmentation」一节：
   * 健康链路上单连接 11 MiB/s、摊开 8 条只有 2.06 MiB/s —— 并发是保险，不是提速。
   * `--no-adaptive` 时退回旧的 ±2 采样微调（一上来就摊开）。
   */
  #adaptConcurrency(now) {
    if (!this.opts.adaptive) return this.#shimmyConcurrency(now);
    if (this.rampLocked) return;
    const windowMs = Number(this.opts.rampSampleMs) > 0 ? Number(this.opts.rampSampleMs) : SAMPLE_SEC * 1000;
    if (now - this.rampWindowAt < windowMs) return;
    const seconds = Math.max(0.05, (now - this.rampWindowAt) / 1000);
    const bytes = this.fetchedBytes - this.rampWindowBytes;
    const bps = bytes / seconds;
    this.rampWindowAt = now;
    this.rampWindowBytes = this.fetchedBytes;
    // 这一档一个字节都没下动：交给看门狗/重试换源，加连接救不了卡住的源。
    if (bytes <= 0) return;
    const stage = this.rampStages[this.rampStageIndex] ?? this.targetConns;
    const isLast = this.rampStageIndex >= this.rampStages.length - 1;
    const improved = this.rampBestBps > 0 && bps >= this.rampBestBps * RAMP_IMPROVE;
    if (bps > this.rampBestBps) {
      this.rampBestBps = bps;
      this.rampBestStage = stage;
    }
    if (isLast) return this.#lockRamp(stage, bps, "已经是连接上限");
    if (bps >= RAMP_FAST_BPS) return this.#lockRamp(stage, bps, "单连接已经够快，不必摊开");
    // 第一档无条件试下一档；之后要么真的更快，要么被限速（低于下限），否则回到最好的一档。
    if (this.rampStageIndex === 0 || improved || bps < RAMP_STARVED_BPS) {
      this.rampStageIndex += 1;
      return this.#applyRampStage(this.rampStages[this.rampStageIndex], bps, improved ? "更快" : "单连接被限速");
    }
    return this.#lockRamp(this.rampBestStage, bps, `加到 ${stage} 条没有更快`);
  }

  /** `--no-adaptive`：每 6 秒采样一次，速率变好 +2，变差 -2。 */
  #shimmyConcurrency(now) {
    if (now - this.lastSampleAt < SAMPLE_SEC * 1000) return;
    const bps = this.globalSpeed.bps;
    if (this.lastSampleBps > 0) {
      const better = bps >= this.lastSampleBps * 1.05;
      const next = better
        ? Math.min(this.opts.maxConns, this.targetConns + SAMPLE_STEP)
        : Math.max(1, this.targetConns - SAMPLE_STEP);
      if (next !== this.targetConns) {
        this.targetConns = next;
        this.emit({ type: "concurrency", target: next, bps: Math.round(bps) });
      }
    }
    this.lastSampleBps = bps;
    this.lastSampleAt = now;
  }

  /** 启动闸门的档位表：1 → 2 → 4 → … → `--conns`（末档一定是 `--conns`）。 */
  #planStages() {
    const max = Math.max(1, Math.min(this.opts.conns, this.opts.maxConns));
    const stages = [];
    for (let n = 1; n < max; n *= 2) stages.push(n);
    stages.push(max);
    return stages;
  }

  /** @param {number} next @param {number} bps @param {string} reason */
  #applyRampStage(next, bps, reason) {
    if (next === this.targetConns) return;
    this.targetConns = next;
    this.emit({ type: "concurrency", target: next, bps: Math.round(bps) });
    this.emit({ type: "ramp", target: next, bps: Math.round(bps), reason });
  }

  /** @param {number} stage @param {number} bps @param {string} reason */
  #lockRamp(stage, bps, reason) {
    const changed = stage !== this.targetConns;
    this.targetConns = stage;
    this.rampLocked = true;
    if (changed) this.emit({ type: "concurrency", target: stage, bps: Math.round(bps) });
    this.emit({ type: "ramp-done", conns: stage, bps: Math.round(bps), reason });
  }

  #reportProgress(now) {
    if (now - this.lastProgressAt < 500) return;
    this.lastProgressAt = now;
    const downloaded = this.reusedBytes + this.fetchedBytes;
    const elapsedSec = (now - this.startedAt) / 1000;
    this.emit({
      type: "progress",
      downloaded,
      total: this.size,
      bps: this.globalSpeed.bps,
      conns: this.activeCount,
      targetConns: this.targetConns,
      elapsedSec,
      sources: this.candidates.length,
    });
  }

  async #saveState() {
    try {
      await writeState(this.out, {
        url: this.finalUrl,
        size: this.size,
        sha256: this.expectedHash || undefined,
        updatedAt: new Date().toISOString(),
        segments: this.segments
          .filter((segment) => segment.length > 0)
          .map((segment) => ({ start: segment.start, end: segment.end, done: segment.done })),
      });
    } catch (error) {
      this.emit({ type: "warn", message: `状态落盘失败：${/** @type {Error} */ (error).message}` });
    }
  }

  /** 一个 worker 的生命周期。 */
  async #worker(index) {
    void index;
    for (;;) {
      if (this.fatal || this.aborted || this.signal?.aborted) return;
      // 闸门：在途连接数到顶就先等着。单线程 JS 里「判断 + 认领」之间没有 await，
      // 所以不会有两个 worker 同时越过闸门。
      if (this.activeCount >= this.targetConns) {
        await sleep(50);
        continue;
      }
      const segment = this.#claim();
      if (!segment) {
        if (this.#allDone()) return;
        await sleep(100);
        continue;
      }
      await this.#downloadSegment(segment);
    }
  }

  #allDone() {
    return this.segments.every((segment) => segment.remaining === 0);
  }

  /** 认领剩余最多的空闲分段。 */
  #claim() {
    let best = null;
    for (const segment of this.segments) {
      if (segment.status !== "pending" || segment.remaining <= 0) continue;
      if (segment.attempts > this.opts.retries) continue;
      if (!best || segment.remaining > best.remaining) best = segment;
    }
    if (best) best.status = "active";
    return best;
  }

  /** 选一个来源：按历史速率排序，跳过冷却中的。 */
  #pickSource() {
    const now = Date.now();
    const usable = this.candidates.filter((candidate) => (this.sourceCooldown.get(candidate.url) ?? 0) <= now);
    const pool = usable.length > 0 ? usable : this.candidates;
    const sorted = pool.slice().sort((a, b) => this.stats.score(b.url) - this.stats.score(a.url));
    return sorted[0];
  }

  /** 下载一个分段（可中断、可重试）。 */
  async #downloadSegment(segment) {
    const startAt = segment.start + segment.done;
    if (startAt > segment.end) {
      segment.status = "done";
      return;
    }
    const controller = new AbortController();
    segment.controller = controller;
    segment.abortKind = "";
    const speed = new SpeedCalc({ windowSec: 10 });
    segment.speed = speed;
    const source = this.#pickSource();
    const partFile = partFileFor(this.out, segment.start, segment.end);
    this.activeCount += 1;
    this.peakConns = Math.max(this.peakConns, this.activeCount);

    /** @type {import("node:fs").WriteStream|null} */
    let ws = null;
    /** @type {{abort: () => void, finished: Promise<void>}|null} */
    let stream = null;
    let failure = "";
    try {
      stream = await openRange(source.url, {
        start: startAt,
        end: segment.end,
        transport: this.opts.transport,
        timeoutSec: this.opts.timeoutSec,
        // 让 curl 自己的停滞保护和看门狗用同一个阈值：两条传输的失败时机应当一致
        stallSec: this.opts.stallSec,
        maxSockets: this.opts.maxConns,
        curlPath: this.opts.curlPath,
        signal: controller.signal,
      });
      this.transport = stream.transport ?? this.transport;
      ws = createWriteStream(partFile, { flags: segment.done > 0 ? "a" : "w" });
      let written = segment.done;
      for await (const chunk of stream.bytes) {
        if (controller.signal.aborted) break;
        let buffer = /** @type {Buffer} */ (chunk);
        // 请求是按「旧」的 end 发出去的，而 #split 可能已经让本分段变短：超出的字节
        // 属于右边那个新分段，绝不能落进这个分片文件（旧版会静默拼进成品，产物比
        // 声明的 size 长出一截，且哈希只在合并时算过、没人对账）。
        const room = segment.length - written;
        if (room <= 0) break;
        if (buffer.length > room) buffer = buffer.subarray(0, room);
        if (!ws.write(buffer)) await once(ws, "drain");
        written += buffer.length;
        segment.done = written;
        this.fetchedBytes += buffer.length;
        this.globalSpeed.add(buffer.length);
        speed.add(buffer.length);
      }
      if (written < segment.length) failure = `分段未写完：${written}/${segment.length}`;
    } catch (error) {
      failure = /** @type {Error} */ (error).message;
      if (controller.signal.aborted) failure = this.lastError || "已中断";
    } finally {
      if (ws) {
        try {
          ws.end();
          await once(ws, "close");
        } catch {
          /* 关闭失败不影响判定 */
        }
        // 兜底对账：磁盘上的分片文件不能比分段长（切分、外部改动都可能造成）。
        // 多余字节不属于这一段，截掉；否则合并时的大小校验会直接报错中止。
        const onDisk = await sizeOf(partFile);
        if (onDisk !== null && onDisk > segment.length) await truncate(partFile, segment.length);
      }
      stream?.abort();
      segment.controller = null;
      segment.speed = null;
      this.activeCount -= 1;
    }
    // 切分后本分段可能比已经写下的字节还短：done 是「文件里属于这一段的字节数」，
    // 不能超过段长，否则统计与合并都会跟着偏。
    if (segment.done > segment.length) segment.done = segment.length;

    if (segment.done >= segment.length) {
      segment.status = "done";
      const bps = speed.bps;
      if (bps > 0) this.stats.recordSpeed(source.url, bps);
      this.emit({ type: "segment-done", segment: segment.start, source: source.name, bps: Math.round(bps) });
      return;
    }

    segment.status = "pending";
    // 为了开新连接而自己切分导致的中止，不算来源失败：不冷却、不涨 attempts。
    // 否则收尾阶段的连续切分会把 --retries 耗光，最后抛出一个假的「没有可用来源」。
    if (segment.abortKind === "split") {
      segment.abortKind = "";
      this.emit({ type: "requeue", segment: segment.start, reason: "split" });
      return;
    }
    segment.abortKind = "";
    segment.attempts += 1;
    if (failure) {
      this.lastError = failure;
      this.stats.recordFailure(source.url, failure);
      this.sourceCooldown.set(source.url, Date.now() + SOURCE_COOLDOWN_MS);
      this.emit({ type: "segment-failed", segment: segment.start, source: source.name, error: failure, attempt: segment.attempts });
    }
    if (segment.attempts > this.opts.retries) {
      this.fatal = new NoSourceError(
        `分段 ${segment.start}-${segment.end} 重试 ${segment.attempts} 次仍未完成。最后一次的报错：${failure || "未知"}`,
      );
    }
  }

  /** 合并分片、校验、落位。 */
  async #finish() {
    await this.#saveState();
    const ordered = this.segments.slice().sort((a, b) => a.start - b.start);
    let cursor = 0;
    for (const segment of ordered) {
      if (segment.start !== cursor) {
        throw new GhpullError(`分段覆盖不连续：期望从 ${cursor} 开始，实际是 ${segment.start}`);
      }
      cursor = segment.end + 1;
    }
    if (cursor !== this.size) throw new GhpullError(`分段总长度 ${cursor} 与预期 ${this.size} 不一致`);

    // 哈希在合并过程中同步计算，不再回读一遍文件
    const tmpFile = `${this.out}.ghpull-merge`;
    await rm(tmpFile, { force: true });
    const hash = createHash("sha256");
    const ws = createWriteStream(tmpFile);
    try {
      for (const segment of ordered) {
        if (segment.length === 0) continue;
        const partFile = partFileFor(this.out, segment.start, segment.end);
        // 分片文件是磁盘上的既成事实：先确认它装着的正好是一个分段的字节，再按这个
        // 长度读。否则被外部改动过（偏大/被截断）的分片会静默拼出长度不对的成品，
        // 而没给 --sha256 时没人会发现。
        const onDisk = await sizeOf(partFile);
        if (onDisk === null) {
          throw new GhpullError(`缺少分片文件 ${path.basename(partFile)}（分段 ${segment.start}-${segment.end}），已中止且未落任何成品。`);
        }
        if (onDisk !== segment.length) {
          const partsDir = path.basename(path.dirname(stateFileFor(this.out)));
          throw new GhpullError(
            `分片文件 ${path.basename(partFile)} 大小不符：磁盘上是 ${onDisk} 字节，应为 ${segment.length} 字节` +
              `（分段 ${segment.start}-${segment.end}）。断点数据已被改动，删掉 ${partsDir} 目录后重下。`,
          );
        }
        const rs = createReadStream(partFile, { start: 0, end: segment.length - 1 });
        for await (const chunk of rs) {
          const buffer = /** @type {Buffer} */ (chunk);
          if (!ws.write(buffer)) await once(ws, "drain");
          hash.update(buffer);
        }
      }
      ws.end();
      await once(ws, "close");
    } catch (error) {
      ws.destroy();
      await rm(tmpFile, { force: true });
      throw error;
    }

    const actualHash = hash.digest("hex");
    if (this.expectedHash) {
      const comparison = compareHash(this.expectedHash, actualHash);
      if (!comparison.ok) {
        await rm(tmpFile, { force: true });
        throw new ChecksumError(`${comparison.message}。分片已保留在 ${path.dirname(stateFileFor(this.out))}，可加 --force 重下。`);
      }
    }

    await rm(this.out, { force: true });
    await rename(tmpFile, this.out);
    if (!this.opts.keepParts) await clearParts(this.out);

    const elapsedSec = (Date.now() - this.startedAt) / 1000;
    const result = {
      ok: true,
      url: this.opts.url,
      out: this.out,
      bytes: this.size,
      elapsedSec: Number(elapsedSec.toFixed(2)),
      avgBps: Math.round(this.size / Math.max(elapsedSec, 0.001)),
      reusedBytes: this.reusedBytes,
      fetchedBytes: this.fetchedBytes,
      fetchBps: Math.round(this.fetchedBytes / Math.max(elapsedSec, 0.001)),
      peakConns: this.peakConns,
      sources: this.candidates.length,
      transport: this.transport,
      sha256: actualHash,
    };
    this.emit({ type: "done", result });
    return result;
  }

  /** 不支持 Range 时的单流兜底（无法续传，只能重来）。 */
  async #runSingleStream(probed) {
    void probed;
    await ensurePartsDir(this.out);
    const partFile = partFileFor(this.out, 0, Math.max(0, this.size - 1));
    await rm(partFile, { force: true });
    const controller = new AbortController();
    this.signal?.addEventListener("abort", () => controller.abort(), { once: true });
    const stream = await openRange(this.opts.url, {
      start: 0,
      end: Math.max(0, this.size - 1),
      allowFullResponse: true,
      transport: this.opts.transport,
      timeoutSec: this.opts.timeoutSec,
      maxSockets: 1,
      curlPath: this.opts.curlPath,
      signal: controller.signal,
    });
    this.transport = stream.transport ?? this.transport;
    const ws = createWriteStream(partFile);
    const hash = createHash("sha256");
    let written = 0;
    const speed = new SpeedCalc({ windowSec: 10 });
    const watchdog = setInterval(() => {
      if (speed.idleMs / 1000 >= this.opts.stallSec) controller.abort();
    }, 1000);
    try {
      for await (const chunk of stream.bytes) {
        const buffer = /** @type {Buffer} */ (chunk);
        if (!ws.write(buffer)) await once(ws, "drain");
        written += buffer.length;
        this.fetchedBytes += buffer.length;
        speed.add(buffer.length);
        hash.update(buffer);
        if (Date.now() - this.lastProgressAt > 500) {
          this.lastProgressAt = Date.now();
          this.emit({ type: "progress", downloaded: written, total: this.size || null, bps: speed.bps, conns: 1, targetConns: 1, elapsedSec: (Date.now() - this.startedAt) / 1000, sources: 1 });
        }
      }
    } finally {
      clearInterval(watchdog);
      ws.end();
      await once(ws, "close");
      stream.abort();
    }
    this.size = written;
    const actualHash = hash.digest("hex");
    if (this.expectedHash) {
      const comparison = compareHash(this.expectedHash, actualHash);
      if (!comparison.ok) throw new ChecksumError(`${comparison.message}（单流模式无法续传，请加 --force 重下）`);
    }
    await rm(this.out, { force: true });
    await rename(partFile, this.out);
    if (!this.opts.keepParts) await clearParts(this.out);
    const elapsedSec = (Date.now() - this.startedAt) / 1000;
    const result = {
      ok: true,
      url: this.opts.url,
      out: this.out,
      bytes: this.size,
      elapsedSec: Number(elapsedSec.toFixed(2)),
      avgBps: Math.round(this.size / Math.max(elapsedSec, 0.001)),
      reusedBytes: 0,
      fetchedBytes: this.fetchedBytes,
      fetchBps: Math.round(this.fetchedBytes / Math.max(elapsedSec, 0.001)),
      peakConns: 1,
      sources: 1,
      transport: this.transport,
      sha256: actualHash,
      mode: "single-stream",
    };
    this.emit({ type: "done", result });
    return result;
  }
}

/**
 * 对外入口。
 * @param {import("./args.mjs").CliOptions & {signal?: AbortSignal}} options
 * @param {{onEvent?: (event: any) => void, log?: (message: string) => void}} [hooks]
 */
export async function download(options, hooks = {}) {
  const engine = new Engine(options, hooks);
  return engine.run();
}

export { Segment };
