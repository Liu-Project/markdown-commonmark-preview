# 参与贡献指南

感谢你愿意为 **Markdown CommonMark Preview & Editing** 贡献代码！无论是修 Bug、加功能、完善文档还是提建议，都欢迎。

## 快速开始

```bash
# 1. 克隆仓库
git clone https://github.com/Liu-Project/markdown-commonmark-preview.git
cd markdown-commonmark-preview

# 2. 安装依赖
npm install

# 3. 编译（tsc + esbuild 打包）
npm run compile

# 4. 在 VS Code 中按 F5 启动扩展开发宿主（Extension Development Host）进行调试
```

## 提交 Issue

- 先搜索已有 [Issues](https://github.com/Liu-Project/markdown-commonmark-preview/issues)，避免重复。
- Bug 报告请使用模板，尽量提供：复现步骤、期望行为、实际行为、VS Code 版本、扩展版本、截图 / GIF、错误日志。

## 提交 Pull Request

1. 从 `master` 拉新分支：`git checkout -b feat/xxx` 或 `git checkout -b fix/xxx`。
2. 保持改动聚焦：一个 PR 只做一件事。
3. 代码风格与现有代码保持一致，**不添加与功能无关的注释**。
4. 提交前务必通过本地校验：
   ```bash
   npm run compile      # 编译通过
   npx tsc -p ./ --noEmit  # 类型检查通过
   ```
5. 涉及功能变更时，同步更新 `README.md` 与 `CHANGELOG.md`。
6. 提交信息建议遵循 `type(scope): 描述` 或 `v版本号: 描述` 的简洁风格。

## 开发约定

- 渲染引擎基于 `markdown-it`，新增渲染能力请在 `src/commonmarkCustomEditors.ts` 的 `buildMd()` 中挂载插件。
- 滚动联动逻辑是 VS Code 内置 Markdown 预览的逐字移植（见文件头注释），改动时请保持行为一致。
- 新增第三方依赖需在 `THIRD_PARTY_NOTICES.md` 中登记其来源与许可证。

## 行为准则

请遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)，友善、尊重地交流。
