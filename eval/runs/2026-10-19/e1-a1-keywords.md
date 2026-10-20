# E1 · A1（纯中文 idea）· 条件 C2：调用方提供 keywords

- 日期：2026-10-19
- 插件版本：0.3.0（工作树，含 render/index 文案修复；**运行中的宿主仍是旧构建**，见 §4）
- 条件：`scout_projects(idea, keywords="screenshot search notes OCR")`
- 与 batch1 的区别：batch1 不传 keywords（走插件内翻译层 → 失败拒绝）；本条按拒绝文案的建议补上英文词，模拟「调用方按报错照做」的真实恢复路径。

## 1. 原始返回（20 条，按插件排序）

| # | repo | stars | 语言 | pushed |
|---|---|---|---|---|
| 1 | jaywcjlove/linux-command | 37.2k | Markdown | 2026-09-06 |
| 2 | Dujltqzv/Some-Many-Books | 24.9k | 未知 | 2026-06-18 |
| 3 | xushengfeng/eSearch | 7.3k | TypeScript | 2026-10-15 |
| 4 | cirosantilli/china-dictatorship | 3.3k | HTML | 2026-02-05 |
| 5 | gege-circle/.github | 2.0k | 未知 | 2025-10-04 |
| 6 | pxvr-official/1 | 542 | 未知 | 2021-03-15 |
| 7 | deweyapp/dewey | 396 | JavaScript | 2021-01-05 · 已归档 |
| 8 | cirosantilli/china-dictatroship-7 | 376 | HTML | 2026-02-05 |
| 9 | xevrion/gyotaku | 345 | Rust | 2026-10-19 |
| 10 | idibidiart/AllSeeingEye | 308 | CSS | 2017-12-11 |
| 11 | ecoron/SerpScrap | 273 | Python | 2026-09-02 |
| 12 | mRFWq7LwNPZjaVv5v6eo/cihna-dictattorshrip-8 | 211 | HTML | 2026-02-05 |
| 13 | chenbihao/blink | 7 | Rust | 2026-10-17 |
| 14 | kuroko1t/anygrep | 3 | Python | 2026-10-12 |
| 15 | section9-lab/MyClip | 2 | Swift | 2026-10-10 |
| 16 | Get-Lizard/lizard | 1 | Swift | 2026-10-18 |
| 17 | DrunkTrader/oxide | 1 | Rust | 2026-10-08 |
| 18 | barryallen16/greymatter | 0 | HTML | 2026-10-19 |
| 19 | martinezooo/VanillaShot | 0 | TypeScript | 2026-10-18 |
| 20 | ZaidK07/Notes-Web-App | 0 | TypeScript | 2026-10-08 |

## 2. 卡片自述的诊断信息（原样摘录）

- 查询词覆盖：`screenshot → 77.6k`、`search → 1285k ⚠️ 几乎不构成约束`、`notes → null`、中文整句 → 8。
- 插件自己标注：「上面 1 个词几乎不缩小范围……这类词要么是平台词，要么根本没参与匹配」。
- 长尾提示：8 个 star ≤100 的项目入选，8 个由保留槽位进入。
- 归档提示：1 行归档（deweyapp/dewey）。

## 3. 人工初判（未对照 gold，仅形态）

明显切题：xevrion/gyotaku（截图内文字搜索，PaddleOCR+sqlite）、section9-lab/MyClip（截图→可搜索笔记）、kuroko1t/anygrep（本地语义搜笔记/PDF/截图）、xushengfeng/eSearch（离线 OCR 搜索）、martinezooo/VanillaShot（可搜索截屏历史）、barryallen16/greymatter（5340 张截图的可搜索归档）、idibidiart/AllSeeingEye（浏览记录截图+全文搜索）。
明显噪声：jaywcjlove/linux-command、Dujltqzv/Some-Many-Books、cirosantilli/china-dictatorship ×2、gege-circle/.github、pxvr-official/1、ecoron/SerpScrap、DrunkTrader/oxide、ZaidK07/Notes-Web-App、chenbihao/blink、Get-Lizard/lizard、deweyapp/dewey。

即：**C2 条件下 A1 明显可救**，前 20 里有 7 条形态切题、其中 6 条 star < 400（全靠长尾通道）。这与 batch1 的「0 候选」形成对照——差别只在有没有英文检索词。

## 4. 关于运行中的宿主（重要）

同一 idea、同一会话里再次**不传** keywords 调用，返回仍是旧文案：

```
检索请求失败，因此没有结果。拒绝执行：idea 含中文，但 keywords 未提供。
  ……（拒绝说明）……
  这是网络或代理问题，不是没有匹配项目。
```

`检索请求失败` + `这是网络或代理问题` 正是本次要修掉的旧渲染路径，且 detail 里没有追加翻译失败原因。说明宿主进程仍持有插件启动时加载的旧 `lib/`，工作树的修改尚未生效。

因此：**A1 的真实翻译失败原因（六种之一）无法在本会话内取得**，必须重载插件（重启宿主）后重测。E1 的 A1/A2 只能先按 C2（调用方给 keywords）条件记录，C1（插件自译）标为「环境未就绪，待重载」。
