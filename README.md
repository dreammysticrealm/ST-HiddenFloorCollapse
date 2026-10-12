# ST-HiddenFloorCollapse

中文 | [English](#english)

一个SillyTavern第三方扩展，用来把连续隐藏的聊天楼层自动合并成一个可展开/折叠的折叠块。

## 功能

当聊天里有连续多条被隐藏的消息时，本扩展会把它们合并成一个折叠块：

```text
#20 正常消息
#21 hidden
#22 hidden
#23 hidden
#24 正常消息
```

会显示成：

```text
#20 正常消息

▶ 已隐藏3层 #21–#23

#24 正常消息
```

点一下折叠块会展开这些隐藏楼层，再点一下会重新折叠。原消息不会被删除，也不会被取消隐藏。本扩展只改变聊天界面的显示方式。

## 1.1.0：按需恢复隐藏楼层

* 收起时释放隐藏楼层的正文、图片和控件 DOM；展开时根据当前聊天数据重新渲染，分批完成。
* 尊重酒馆的消息加载范围。折叠组可直接展开当前已加载的部分，不会自动触发 Show more messages。
* 手动加载更早的消息后，新加载的隐藏楼层自动合并进对应折叠组。
* 改善首次进入聊天时的初始化，等待聊天容器和数据就绪后自动显示折叠组。
* 切换聊天或重新收起时停止待执行的恢复；正在编辑的楼层会保持展开，保护未保存的内容。
* 保留 1.0.4 的 iPhone 折叠卡片高度修复。

### 只加载 20 条消息时会怎样？

例如聊天最新楼层是 **#30**，酒馆加载最近 **20 条**，实际加载范围是 **#11–#30**。如果你隐藏了 #0–#20，折叠卡片会显示 **「已隐藏10层 #11–#20」**，点击即可展开这 10 层。

更早的 #0–#10 仍由酒馆的 Show more messages 加载。若整组隐藏楼层都在尚未加载的范围内，当前界面不会显示该组卡片。

### 更新方式

在酒馆的扩展管理中更新本扩展，然后刷新页面。本次更新需要同时更新 `index.js`、`style.css` 和 `manifest.json`，手动更新请替换整个扩展文件夹。

### 兼容性与性能

面向 SillyTavern **1.14–1.19**：兼容旧版 `addOneMessage` 和新版 `updateMessageElement` 两种渲染接口。使用这六个版本的原生渲染、分页、重编号函数，在 Chromium 和 WebKit 测试页面中验证；这不等于对每个版本、每种第三方扩展组合的完整实机测试。

为保持酒馆的楼层编号、删除和分页逻辑，每条收起的已加载消息保留一个空的 `.mes` 根节点，不缓存移出的正文 DOM。最新一条消息保留完整结构，供生成、续写和切换回复使用。酒馆首次创建消息 DOM 的开销仍然存在，优化的是收起后的 DOM 占用。

展开会重新创建消息内容，媒体播放进度、第三方控件的临时界面状态可能重置。聊天正文和隐藏状态保持不变。若某层恢复失败，可收起后重试，或输入 `/hfc-refresh`。

## 适合什么场景

* 你经常用Hide from prompt隐藏旧楼层
* 你想让隐藏楼层不占据大量屏幕空间
* 你仍然希望随时点开查看被隐藏的原文
* 你希望连续隐藏楼层合并成一组，而不是每层单独折叠
* 你想要一个类似HTML`<details>`的展开/折叠效果

## 安装方式1：从GitHub安装

这是推荐安装方式。

1. 打开SillyTavern。
2. 点击顶部或侧边栏的Extensions。
3. 找到Install Extension或Install from GitHub。
4. 在输入框粘贴本仓库地址：

```text
https://github.com/dreammysticrealm/ST-HiddenFloorCollapse
```

5. 点击Install。
6. 安装完成后刷新SillyTavern页面。
7. 打开任意聊天，如果有连续隐藏楼层，插件会自动把它们折叠成一组。

如果你安装后没有看到效果，先确认聊天里确实有被Hide from prompt隐藏的消息，然后刷新页面或输入：

```stscript
/hfc-refresh
```

## 安装方式2：手动安装

如果Install from GitHub不可用，也可以手动安装。

1. 下载或克隆本仓库。
2. 确认文件结构如下：

```text
ST-HiddenFloorCollapse/
├── manifest.json
├── index.js
├── style.css
└── README.md
```

3. 把整个`ST-HiddenFloorCollapse`文件夹放进SillyTavern的第三方扩展目录。

通常是：

```text
SillyTavern/data/<你的用户>/extensions/ST-HiddenFloorCollapse
```

或全局扩展目录：

```text
SillyTavern/public/scripts/extensions/third-party/ST-HiddenFloorCollapse
```

4. 重启SillyTavern或刷新浏览器页面。
5. 插件会自动加载并开始工作。

## 使用方法

安装后无需额外设置。插件会自动扫描聊天界面，把连续的隐藏消息合并成折叠块。

隐藏消息通常来自SillyTavern的Hide from prompt/眼睛按钮，或等价的隐藏命令。只要消息在界面上带有隐藏状态，插件就会自动处理。

折叠块默认是收起状态。点一下折叠块会展开里面的隐藏楼层，再点一下会重新折叠。

## 命令

```stscript
/hfc-refresh
```

重新扫描并重建隐藏楼层折叠组。

```stscript
/hfc-open
```

展开当前已加载的所有隐藏楼层折叠组。

```stscript
/hfc-close
```

折叠所有隐藏楼层折叠组。

## Quick Reply示例

你可以把这些命令做成Quick Reply按钮。

重新扫描：

```stscript
/qr-create label=刷新隐藏折叠 /hfc-refresh
```

展开全部：

```stscript
/qr-create label=展开隐藏楼层 /hfc-open
```

折叠全部：

```stscript
/qr-create label=折叠隐藏楼层 /hfc-close
```

## 工作原理

SillyTavern隐藏消息时，会在聊天界面上把对应消息标记为隐藏状态。本插件结合当前聊天数据和已加载的消息节点，寻找连续的隐藏消息，并在它们前面插入一个`<details>`折叠块。收起时清空消息的子节点，展开时调用酒馆原生接口恢复。

插件只处理界面显示：

* 不会删除消息
* 不会修改消息内容
* 不会取消隐藏状态
* 不会把隐藏消息重新加入prompt
* 备注会保存到当前聊天的 metadata，聊天正文保持不变

## 说明

* 只有连续的隐藏消息会被合并成一组。
* 中间隔着正常消息时，会分成多个折叠组。
* 小型系统消息和工具调用消息会被跳过。
* 折叠块使用SillyTavern主题色，并带有杂志风排版。
* 如果切换聊天、发送消息、编辑消息、删除消息或改变隐藏状态，插件会自动重新扫描。

## English

A SillyTavern third-party extension that automatically groups consecutive hidden chat messages into a magazine-style fold card.

## Features

When several consecutive chat messages are hidden, this extension turns them into one collapsible block:

```text
#20 normal message
#21 hidden
#22 hidden
#23 hidden
#24 normal message
```

It becomes:

```text
#20 normal message

▶ 已隐藏3层 #21–#23

#24 normal message
```

Click the fold card once to expand the hidden messages. Click it again to collapse them. The original messages are not deleted, edited, or unhidden. This extension only changes how hidden messages are displayed in the chat UI.

## 1.1.0: Restore hidden messages on demand

* Collapsing releases the hidden messages' text, image, and control DOM. Expanding rebuilds them from current chat data in small batches.
* Fold cards open the currently loaded portion directly, respecting SillyTavern's message window. They never trigger Show more messages automatically.
* Manually loading older history merges newly loaded hidden messages into the corresponding folds.
* Initial setup waits for the chat container and data, so fold creation does not depend on loading more history.
* Closing a fold or switching chats cancels pending restoration. Messages being edited stay expanded to protect unsaved text.
* Includes the iPhone card-height fix from 1.0.4.

### Example: a 20-message window

If the latest message is **#30** and SillyTavern loads the most recent **20 messages**, the loaded range is **#11–#30**. Hiding #0–#20 produces a fold for **10 messages, #11–#20**, which opens directly.

Use SillyTavern's Show more messages to load #0–#10. A hidden group entirely outside the loaded window has no card until its messages are loaded.

### Updating

Update the extension in SillyTavern's extension manager, then refresh the page. This release changes `index.js`, `style.css`, and `manifest.json`; for manual updates, replace the complete extension folder.

### Compatibility and performance

Targets SillyTavern **1.14–1.19**, supporting the older `addOneMessage` and newer `updateMessageElement` APIs. Tests use the native rendering, pagination, and reindexing functions from all six versions in Chromium and WebKit test pages. This is not a full device test of every release or third-party extension combination.

Each collapsed loaded message retains one empty `.mes` root for native indexing, deletion, and pagination. Removed message content is not cached as detached DOM. The newest message keeps its full structure for generation, continuation, and swipes. SillyTavern still incurs the initial rendering cost; this reduces DOM retained after collapse.

Expansion creates fresh message content. Media playback position and temporary third-party widget state may reset. Message text and hidden status are preserved. If a message fails to restore, collapse and reopen its group, or run `/hfc-refresh`.

## Use cases

* You often use Hide from prompt to hide old messages
* You want hidden messages to take less vertical space
* You still want to expand and read hidden messages when needed
* You want consecutive hidden messages to become one group instead of many separate folds
* You want a details-like expand/collapse UI

## Installation Method 1: Install from GitHub

This is the recommended method.

1. Open SillyTavern.
2. Open Extensions.
3. Find Install Extension or Install from GitHub.
4. Paste this repository URL:

```text
https://github.com/dreammysticrealm/ST-HiddenFloorCollapse
```

5. Click Install.
6. Refresh the SillyTavern page after installation.
7. Open any chat. If there are consecutive hidden messages, the extension will collapse them automatically.

If nothing changes after installation, make sure the chat actually contains messages hidden with Hide from prompt. Then refresh the page or run:

```stscript
/hfc-refresh
```

## Installation Method 2: Manual installation

If Install from GitHub is not available, you can install the extension manually.

1. Download or clone this repository.
2. Make sure the folder contains these files:

```text
ST-HiddenFloorCollapse/
├── manifest.json
├── index.js
├── style.css
└── README.md
```

3. Put the whole `ST-HiddenFloorCollapse` folder into your SillyTavern third-party extensions folder.

Usually:

```text
SillyTavern/data/<your-user>/extensions/ST-HiddenFloorCollapse
```

Or the global extension folder:

```text
SillyTavern/public/scripts/extensions/third-party/ST-HiddenFloorCollapse
```

4. Restart SillyTavern or refresh the browser page.
5. The extension will load automatically.

## Usage

No setup is required after installation. The extension automatically scans the chat and groups consecutive hidden messages.

Hidden messages usually come from SillyTavern’s Hide from prompt/eye button, or an equivalent hide command. As long as the message is marked hidden in the chat UI, the extension will process it.

Fold cards are closed by default. Click a fold card to expand the hidden messages inside. Click it again to collapse them.

## Slash commands

```stscript
/hfc-refresh
```

Rebuild hidden-message fold groups.

```stscript
/hfc-open
```

Open all currently loaded hidden-message fold groups.

```stscript
/hfc-close
```

Close all hidden-message fold groups.

## Quick Reply examples

You can turn these commands into Quick Reply buttons.

Refresh folds:

```stscript
/qr-create label=RefreshHiddenFolds /hfc-refresh
```

Open all folds:

```stscript
/qr-create label=OpenHiddenFolds /hfc-open
```

Close all folds:

```stscript
/qr-create label=CloseHiddenFolds /hfc-close
```

## How it works

When SillyTavern hides a message, the message is marked as hidden in the chat UI. This extension combines current chat data with the loaded message nodes, finds consecutive hidden messages, and inserts a `<details>` fold card before each group. Collapsing empties message children; expanding restores them with the native renderer.

This extension only changes display behavior:

* It does not delete messages
* It does not edit message content
* It does not unhide messages
* It does not add hidden messages back into the prompt
* Notes are saved in the current chat metadata; message text remains unchanged

## Notes

* Consecutive hidden messages are grouped together.
* Hidden groups separated by normal messages become separate folds.
* Small system messages and tool-call blocks are ignored.
* The fold card uses SillyTavern theme colors with a magazine-style layout.
* The extension automatically rescans after chat switches, new messages, edits, deletions, and hide-state changes.
