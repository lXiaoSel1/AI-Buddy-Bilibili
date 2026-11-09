# AI Buddy Bilibili / B站陪伴

2.0.16：已经确认的阅读可以跨天读完；B站登录过期时暂停并提示重新扫码，不再降级成只读标题和简介；状态里的版本号改为读取包清单。

2.0.15：只改了兼容声明（AI 酱 >= 2.0.2、DSH >= 0.2.1-rc.3），功能和 2.0.14 相同。

2.0.14：新阅读、整理和感想使用观看角色的聊天连接；不再单独选择感想模型。旧阅读保留原连接和进度。缺少图片能力时明确暂停，不自动换模型。

Version 2.0.16 lets a confirmed reading finish across midnight, pauses and asks for a new sign-in when the Bilibili login has expired instead of falling back to the title and description, and reads the status version from the package manifest.

Version 2.0.15 changes only the compatibility declarations (AI Buddy >= 2.0.2, DSH >= 0.2.1-rc.3); features match 2.0.14.

Version 2.0.14 follows each viewing character's chat connection for new readings and reflections. Existing plans keep their pinned connection; image capability failures do not switch models.

`@ai-buddy/bilibili-companion` **2.0.16** · AI Buddy **>= 2.0.2** · DSH **>= 0.2.1-rc.3** · source-available: Apache 2.0 + Commons Clause.

让角色按你确认的计划读取 B站视频帧与字幕，保存观看笔记，并在另行授权后发表评论。此版本沿用本机 2.0.13 的已验收功能；桥接版本、合同、权限和数据格式保持原值。

## 安装与账号

在 AI 酱的扩展目录选择「B站陪伴」，核对版本并安装、启用。AI 酱不另建服务账号，不代注册。**必须连接 B站账号才能观看**：由宿主打开 B站官方登录窗口扫码，视频、字幕、额度与历史绑定到所选账号。安装、升级或仅扫码都不会自动开始观看、发表评论或调用模型；公开评论另行授权。

插件不打包 Cookie、Token、登录资料、媒体或开发者 Node。凭据由宿主保管，不进入模型提示、页面或日志。DSH 及媒体组件由宿主单独准备；FFmpeg-only 媒体工具没有 ASR 模型，没有取得字幕时会标注语言/对白未知，不会冒称听见音频。B站非官方接口可能变化，不承诺官方稳定性。

## 当前阅读行为

- 新任务先预览原视频帧图、P 范围、所选模型、帧/图/窗口/字幕数量与预计调用。默认每 **0.5 秒**采样、每 **6 秒**阅读窗、每图最多 **12 帧**；可修改参数，默认当前 P，也可选择其他 P 或全部 P。
- 明确确认后冻结整份计划并顺序执行。每个计划图像及已取得字幕的每个字符都需要对应的成功宿主回执；容量不足时缩批或补文本页，不丢图、不截尾，不沿用旧协议的固定 16 次截停。原字幕、cue ID、时间、字符偏移、拼图与 checkpoint 保留。
- 原视频经有界 Range/后台解码处理；拿不到原视频就暂停，不拿平台预览图冒充固定采样。完整覆盖回执证明材料已提交并有结果，**不保证模型完全理解、事实全对或看懂字幕外全部内容**。
- 暂停、停止、取消、账号/角色/人生变化使旧执行失效。每次继续申请新租约，阅读 ID 和冻结批次身份保持；只对有证据的未提交错误有限重试，未知提交不重放。失败/暂停/待核对、成功结果和实际模型请求 ID 按事实显示。
- 无完整模型能力/metadata 时明确拒绝或暂停，不暗中更换模型。第三方连接的图像数、上下文和 provider metadata 可能不完整；未知 provider 不猜测费用。预约仍受原时间窗、睡眠、权限与账号共享额度限制，手动继续不会被所谓便宜时段强制等待。

## 默认、权限与数据

自动观看默认关闭，评论默认关闭、未同意，自动画面阅读默认未批准；默认每天最多观看 5 次、评论 3 次、并发 1。评论必须有单独账号授权和有效活动许可，发送前重验内容与归属；只有有效平台评论 ID 才记为已发送，unknown 保留且不盲发。私有观看笔记、私聊或关系材料不能混入公开评论。

角色兴趣、观看、额度和记录按宿主的账号/角色/人生范围隔离。卸载默认保留私有 SQLite 历史与宿主已记录经历；退出/停用关闭租约、计时器和连接。schema 为 1，minimumWriter 为 `0.1.0-dev.2`；旧 writer 不得写入新数据。恢复数据库不会撤销评论、经历、钱包或真实外部动作。详见 `DEFAULTS.json`、`SETTINGS.schema.json`、`DATA-SCHEMA.json`。

## 证据边界与开发

已接受的导出前基线：core 2829 项（2825 pass / 4 skip），social 480 项（476 pass / 4 skip）；包括真实 Electron 中的 3 个合成阅读场景，以及正式安装后的两个插件实际加载。上述是历史整体验收范围，**不是本独立仓库的新测试计数**。真实账号视频→真实模型完整阅读/评论、真实 QQ 入站→模型→出站等仍未因此验收；不通过重放历史未知请求补做。

开发需固定 Node **24.21.0**、npm **11.19.0**、esbuild **0.28.2**。在独立仓库的新 checkout 执行 `npm ci`、`npm test`、`npm run build`、`npm run verify:artifacts`、`npm run repro`；不需要宿主或兄弟插件源码。`TEST-SCOPE.json` 记录私有宿主/兄弟测试排除和合成字幕 fixture，`PUBLIC-SOURCE.json` 记录导出清单；打包不安装依赖。详细说明见仓库 `docs/DEVELOPMENT.md` 与 `docs/VALIDATION.md`。已经冻结或发布的包不可改字节，同版本不替换资产。

## English

AI Buddy Bilibili 2.0.14 reads source video frames and acquired timed subtitles through a frozen, explicitly confirmed plan. It requires AI Buddy >= 2.0.2, a connected Bilibili account and a suitable user-selected model. AI Buddy adds no service signup; users scan the official platform login themselves. Installing, updating or scanning alone never starts watching, comments or model requests. Commenting needs separate consent. Credentials stay host-managed.

New plans default to 0.5-second source sampling, 6-second windows and at most 12 frames per sheet, with explicit part selection. Every required image and acquired subtitle character needs a successful host receipt. Capacity handling splits batches/pages; unknown submissions are not replayed. Failed, paused and review-needed states preserve original sources and checkpoints. An FFmpeg-only kit supplies no ASR: missing dialogue remains unknown. Receipt coverage does not establish perfect semantic understanding or official API stability. Model image/context/provider metadata and real external behavior remain bounded by the configured provider and host.

Autonomous watching and comments are off by default; limits start at 5 watches and 3 comments per day with one active task. Uninstall retains history by default. The accepted integrated baseline had core 2825 pass / 4 skip and social 476 pass / 4 skip, three synthetic scenes in real Electron, and a formal install with both plugins loaded. These are not new exported-suite results or accepted live-platform/model roundtrips. This release retains accepted local 2.0.13 behavior and changes distribution, documentation and version identifiers.

The project is source-available under Apache 2.0 **with Commons Clause**, subject to the unchanged `LICENSE.md`; see `THIRD-PARTY-NOTICES.md`. It bundles no third-party artwork, video content, accounts or runtime components and does not claim all host artwork/reference rights are cleared. [Host](https://github.com/lXiaoSel1/AI-Buddy) · [Extension directory](https://github.com/lXiaoSel1/AI-Buddy-Extensions) · [Plugin source and releases](https://github.com/lXiaoSel1/AI-Buddy-Bilibili).

## 2.0.14

沿用已验收的本机 2.0.13：新观看按角色聊天连接固定阅读、汇总和感想，集中修复的执行失效、模型包装和页面导航处理一并公开。旧计划、未知回执、权限、合同与数据格式保留。本轮仅使用新版本及正式下载身份，不增加业务行为。

Publishes the accepted local 2.0.13 behavior: new viewings pin the character chat connection for reading, consolidation and reflection, including the batch lifecycle, response-wrapper and navigation fixes. Existing plans, unknown receipts, capabilities, contract and schema are preserved. This preparation changes only release identifiers and documentation.
