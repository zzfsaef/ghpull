# 贡献指南

[English](CONTRIBUTING.md) · **简体中文**

感谢你有兴趣为 ghpull 做贡献。本文说明本项目的开发方式、必须遵守的约束，以及提交改动的流程。

## 项目定位与硬约束

ghpull 是一个**纯客户端**的多源分段下载 CLI，用于在慢速链路上从 GitHub（及其镜像）拉取大文件：
HTTP Range 并发分段、多源择优、两层断点续传、停滞看门狗、SHA-256 校验、覆盖保护。

请在任何改动中保持以下约束，它们不是建议而是硬性要求：

- **零运行时依赖。**`dependencies` 与 `devDependencies` 必须保持为空对象。
  只用 Node.js 标准库。需要新依赖的方案通常会被拒绝，除非能论证不可替代且维护者明确同意。
- **纯客户端。**不引入服务端、不引入需要账号或密钥的托管服务。
- **Node.js >= 18**（见 `package.json` 的 `engines`），使用 ESM（`"type": "module"`）。
- **不把个人身份信息写进仓库**：真实姓名、邮箱、本机绝对路径、私有内网地址、私有链接都不允许。

## 开发环境

只需要 Node.js（>= 18），不需要安装任何东西即可开跑；npm 只是便捷包装
（`npm run check` / `npm test` 分别等于 `node tools/check-syntax.mjs` 与 `node --test`）：

```bash
git clone https://github.com/zzfsaef/ghpull.git
cd ghpull
npm run check   # 语法检查，零依赖
npm test        # 单元测试
```

本项目零运行时依赖，**不需要也不提交 `package-lock.json`**：CI 与发布流程直接调用 `node`，
不执行 `npm install`，也不会因为缺少 lockfile 而失败。

## 目录结构

| 路径 | 内容 |
| --- | --- |
| `bin/ghpull.mjs` | CLI 入口（`bin` 字段指向它） |
| `src/` | 实现代码，对外入口见 `package.json` 的 `exports` |
| `test/` | `node:test` 测试 |
| `tools/check-syntax.mjs` | 零依赖语法检查脚本 |
| `jsconfig.json` | 类型检查配置（配合 `npm run typecheck`） |

## 提交前必须跑的检查

```bash
npm run check          # 语法检查
npm test               # 单元测试
npm run test:coverage  # 覆盖率（node --test --experimental-test-coverage）
npm run typecheck      # 可选：npx --yes typescript@5 tsc -p jsconfig.json（需要网络）
```

在 PR 描述里请贴上你**实际执行过**的命令与输出摘要。只跑通一部分也可以提交，
但不要声称跑过没跑过的命令。

## 代码风格

- ESM、2 空格缩进、LF 换行、UTF-8；具体规则见 `.editorconfig` 与 `.gitattributes`。
- 新增或修改行为时请补测试：能离线复现的优先（本地 fixture、可注入的 HTTP 桩），
  避免让测试依赖真实外网。
- 提交信息用简短的祈使句描述改动（例如 `fix: resume after watchdog stall`）。

## 提交流程

1. Fork 仓库，从默认分支切出一个主题分支。
2. 按上面的要求完成改动与自测。
3. 提交 Pull Request，并按仓库的 PR 模板填写变更类型、实跑结果与检查清单。
4. 维护者会 review；如果涉及公共行为或 CLI 参数变更，请主动说明迁移方式。

## 报告问题

- **Bug 与功能建议**：请使用仓库的 issue 模板提交，模板里要求的版本、系统、完整命令请如实填写。
- **使用问题与讨论**：到 <https://github.com/zzfsaef/ghpull/discussions>。
- **安全漏洞**：**不要**开公开 issue。请通过
  <https://github.com/zzfsaef/ghpull/security/advisories/new> 私密上报，细节见 `SECURITY.md`。

本项目只通过这些 GitHub 渠道沟通，不提供邮件联系方式。

参与本项目即表示你同意遵守 `CODE_OF_CONDUCT.md`。
