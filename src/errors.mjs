// SPDX-License-Identifier: MIT
/**
 * 统一错误类型与退出码。
 *
 * 退出码一旦发布就属于公共接口，改动需要走 CHANGELOG 的 Changed/Breaking。
 */

/** 退出码表。0 成功；1 通用失败；2 用法错误；3 拒绝覆盖；4 校验失败；5 目标不支持；6 全部源不可用。 */
export const EXIT = Object.freeze({
  OK: 0,
  FAILURE: 1,
  USAGE: 2,
  EXISTS: 3,
  CHECKSUM: 4,
  UNSUPPORTED: 5,
  NO_SOURCE: 6,
});

/** 退出码到人类可读说明的映射（`--help` 与错误摘要共用）。 */
export const EXIT_TEXT = Object.freeze({
  [EXIT.OK]: "成功",
  [EXIT.FAILURE]: "失败（网络、磁盘或中断）",
  [EXIT.USAGE]: "命令行用法错误",
  [EXIT.EXISTS]: "输出文件已存在，且没有给出 --force / --continue",
  [EXIT.CHECKSUM]: "校验值与实际内容不一致",
  [EXIT.UNSUPPORTED]: "目标行为不受支持（例如服务器不支持 Range 且无法降级）",
  [EXIT.NO_SOURCE]: "所有候选来源都不可用",
});

/** 所有 ghpull 主动抛出的错误都继承自它，便于 CLI 顶层统一收口。 */
export class GhpullError extends Error {
  /**
   * @param {string} message 面向用户的说明（不含堆栈，可直接打印）
   * @param {{code?: number, cause?: unknown, detail?: string}} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "GhpullError";
    this.code = options.code ?? EXIT.FAILURE;
    /** 面向调试的补充信息，`--verbose` 时打印。 */
    this.detail = options.detail ?? "";
  }
}

/** 参数不合法（缺失、冲突、越界）。 */
export class UsageError extends GhpullError {
  constructor(message, options = {}) {
    super(message, { ...options, code: EXIT.USAGE });
    this.name = "UsageError";
  }
}

/** 目标文件已存在且未允许覆盖。 */
export class DestinationExistsError extends GhpullError {
  constructor(message, options = {}) {
    super(message, { ...options, code: EXIT.EXISTS });
    this.name = "DestinationExistsError";
  }
}

/** 校验（长度或哈希）不匹配。 */
export class ChecksumError extends GhpullError {
  constructor(message, options = {}) {
    super(message, { ...options, code: EXIT.CHECKSUM });
    this.name = "ChecksumError";
  }
}

/** 单个来源（原始 URL 或某个镜像）不可用。 */
export class SourceError extends GhpullError {
  constructor(message, options = {}) {
    super(message, { ...options, code: options.code ?? EXIT.FAILURE });
    this.name = "SourceError";
  }
}

/** 服务器不支持 Range，且调用方没有允许单流降级。 */
export class UnsupportedError extends GhpullError {
  constructor(message, options = {}) {
    super(message, { ...options, code: EXIT.UNSUPPORTED });
    this.name = "UnsupportedError";
  }
}

/** 所有候选来源都试过且都失败。 */
export class NoSourceError extends GhpullError {
  constructor(message, options = {}) {
    super(message, { ...options, code: EXIT.NO_SOURCE });
    this.name = "NoSourceError";
  }
}

/**
 * 把一个未知的抛出物转成 `GhpullError`。
 * @param {unknown} error
 * @returns {GhpullError}
 */
export function toGhpullError(error) {
  if (error instanceof GhpullError) return error;
  if (error instanceof Error) {
    /** @type {{code?: string, cause?: unknown}} */
    const anyError = /** @type {any} */ (error);
    const code = anyError.code;
    if (code === "ENOSPC") {
      return new GhpullError(`磁盘空间不足：${error.message}`, { code: EXIT.FAILURE, cause: error });
    }
    if (code === "EACCES" || code === "EPERM") {
      return new GhpullError(`没有权限写入目标路径：${error.message}`, { code: EXIT.FAILURE, cause: error });
    }
    return new GhpullError(error.message, { code: EXIT.FAILURE, cause: error });
  }
  return new GhpullError(String(error), { code: EXIT.FAILURE });
}
