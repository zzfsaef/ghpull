## 变更类型 / Change type

- [ ] Bug 修复（不改变现有公共行为）· Bug fix (no change to public behaviour)
- [ ] 新功能（新增参数或新增行为）· New feature (new option or behaviour)
- [ ] 行为变更（可能影响现有调用方，**必须说明迁移方式**）· Behaviour change (**migration path required**)
- [ ] 文档（README / CONTRIBUTING / 代码注释）· Documentation
- [ ] CI 与工具链（workflow、jsconfig、检查脚本）· CI and tooling
- [ ] 重构（对外行为不变）· Refactor (no external behaviour change)

## 关联 issue / Related issues

Closes #
Relates to #

## 已实跑的命令与结果 / Commands actually run

> 只勾选你**真的执行过**的命令，并在下面贴上输出摘要（失败或跳过也要写清楚，别写「应该会通过」）。
> Tick only what you **really ran**, and paste a summary of the output below (state failures and
> skips too — never write "it should pass").

- [ ] `npm run check`
- [ ] `npm test`
- [ ] `npm run test:coverage`

输出摘要（粘贴关键行即可）/ Output summary (key lines are enough)：

```
（在此粘贴 / paste here）
```

## 是否改动了公共行为 / CLI 参数 · Public behaviour and CLI options

- [ ] 本次改动**没有**触及公共行为、CLI 参数或输出格式 · This change touches none of them
- [ ] 本次改动触及了公共行为，逐项列出如下 · It does — listed below

| 项目 / Item | 改动前 / Before | 改动后 / After | 兼容性影响 / Compatibility |
| --- | --- | --- | --- |
|  |  |  |  |

## 检查清单 / Checklist

- [ ] **零依赖保持不变**：`package.json` 的 `dependencies` 与 `devDependencies` 仍是空对象，且没有引入新的运行时依赖 · **Zero dependencies preserved**: both are still empty objects and no runtime dependency was added
- [ ] `npm run check` 通过 · passes
- [ ] `npm test` 通过（新增或修复的行为都有对应测试）· passes (new or fixed behaviour is covered by tests)
- [ ] 没有把个人身份信息写进仓库：无真实姓名、无邮箱、无本机绝对路径、无私有内网地址或私有链接 · No personal identity: no real name, no email, no local absolute path, no private intranet address or private link
- [ ] 涉及用户可见行为时，文档已同步更新 · Documentation updated for any user-visible change
