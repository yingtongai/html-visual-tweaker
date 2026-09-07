# HTML Visual Tweaker

一个基于 Chrome Manifest V3 的本地 HTML 可视化微调扩展。可以在浏览器中直接选中页面元素，实时调整文案、文字样式、位置与尺寸，并按页面地址保存最近 5 个版本。

> 保存的是浏览器本地的样式覆盖规则和文案修改，不会改动服务器文件，也不会直接改写原始 HTML 源码。

## 功能

- 仅在本地 `file://` HTML 页面启用，避免影响普通网站。
- 点击“修改”后进入编辑状态；保存后自动锁定，防止误改。
- 调整文案、颜色、字体、字号、边距、圆角与位移。
- 选中框显示元素标签，四个角可拉伸宽高；移动时提供对齐线和吸附。
- “取消”撤销本次未保存调整；“恢复”可回到初始状态或最近 5 个保存版本。
- “隐藏”收起工具栏和选中框；点击 Chrome 扩展图标可再次显示。

## 直接安装

仓库已经包含构建完成、可直接加载的 `dist/` 扩展文件，不需要安装 Node.js。

1. 在 GitHub 页面点击 **Code**，选择 **Download ZIP**。
2. 解压下载的 ZIP 文件。
3. 打开 Chrome 的 `chrome://extensions`，开启右上角的“开发者模式”。
4. 点击“加载已解压的扩展程序”。
5. 选择解压目录中的 `dist` 文件夹。
6. 在扩展卡片中打开“详情”，开启“允许访问文件网址”。
7. 用 Chrome 打开本地 HTML 文件，例如 `file:///E:/example/index.html`。
8. 点击浏览器工具栏中的 **HTML Visual Tweaker** 图标，工具栏会显示在页面右上角。

## 使用方法

1. 点击工具栏的“修改”。
2. 点击要调整的元素。优先点击文字、图标或图片本身，可以从已选容器切换到内部的小元素。
3. 直接拖动元素移动位置；靠近其他元素的边缘或中心时会出现对齐线并吸附。
4. 拖动选中框四角调整宽度和高度；也可在右侧面板输入精确值。
5. 在“文案”输入框修改文字，或调整颜色、字体、字号、外边距、圆角和位移。
6. 点击“保存修改”持久化当前版本；点击“取消”放弃当前未保存调整。
7. 使用“恢复”回到初始状态或任一已保存版本。

## 数据与限制

- 所有历史记录保存在浏览器本地 `chrome.storage.local`，按本地页面 URL 区分，不会上传网络。
- 每个页面只保留最近 5 个已保存版本。
- 首版只调整元素的外层样式；不会编辑图表数据、Canvas/SVG 内部对象、跨域 iframe 或 Shadow DOM 内部节点。
- 伪元素（`::before` / `::after`）没有独立 DOM 节点，暂不能单独选中。

## 开发与更新构建

只有修改源码时才需要 Node.js 18+：

```bash
npm install
npm run typecheck
npm run build
```

每次发布源码修改时，请把重新生成的 `dist/` 一起上传。安装过扩展的用户可在 `chrome://extensions` 点击“重新加载”，再刷新目标页面。

## 发布到 GitHub

建议上传：

```text
src/
public/
plugins/
dist/
package.json
package-lock.json
tsconfig.json
vite.config.ts
README.md
.gitignore
marketplace.json
codex-marketplace.json
```

不要上传：

```text
node_modules/
.agents/
.codex/
.env*（除 .env.example 外）
证书、私钥、账号凭据、日志和临时文件
```

`dist/` 会提交到仓库，GitHub 下载后可以直接加载；`.gitignore` 会继续排除依赖、凭据与本机配置。
