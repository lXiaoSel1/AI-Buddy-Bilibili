## 2.0.14 — 2026-11-08

- 沿用已验收的本机 2.0.13：新观看按角色聊天连接固定阅读、汇总和感想，集中修复的执行失效、模型包装和页面导航处理一并公开。旧计划、未知回执、权限、合同与数据格式保留。本轮仅使用新版本及正式下载身份，不增加业务行为。
- Publishes the accepted local 2.0.13 behavior: new viewings pin the character chat connection for reading, consolidation and reflection, including the batch lifecycle, response-wrapper and navigation fixes. Existing plans, unknown receipts, capabilities, contract and schema are preserved. This preparation changes only release identifiers and documentation.

## 2.0.11 — 2026-11-01

## 2.0.13 — 本地角色模型修订 / Local character-model revision

- 新观看按参与角色解析聊天连接；移除独立感想模型选择，阅读、汇总和感想使用本次计划固定连接。
- 多角色预约及错峰按实际角色连接处理；旧计划、未知回执、评论授权和数据格式保留。
- New readings follow the viewing character's chat connection and pin it through reading, consolidation and reflection. The separate model selector is removed. Existing plans and unknown receipts are preserved; permissions and data schema are unchanged.

- Publish an independent, self-contained source repository and fixed development toolchain; update installation, permission, retention and verification boundaries.
- Functional baseline remains 2.0.10. Bridge, capabilities, contract hash and data schema are unchanged. This patch does not claim new live platform or model acceptance.

## 2.0.10 — 2026-11-01

- Unify reading/history state, retry image loading, preserve precise receipts and stop non-converging aggregation.

# 2.0.8

- 修复预览结束后确认整份计划被旧活动租约拒绝：每轮执行申请独立 attempt 租约，原阅读 ID、冻结计划、批次和模型幂等身份保持不变，旧终态租约不复活。
- 成功确认立即同步本地 checkpoint，已有 pending、结果和无效付费回执保留；页面按失败/暂停真实状态显示，宿主待核对标志不被覆盖，恢复后清除旧失败原因。自动观看为可选设置，不阻挡手动现在看或继续。
- 旧 BUDDY_SOCIAL_DENIED 失败仅在本地及当前账号宿主共同证明从未提交模型时显示明确继续入口。只在用户点击后重验账号、人物人生、模型、当天时间与额度；迟到请求不能覆盖停止、暂停、设置变化或停用。保留原失败快照，已提交或未知请求不重放，升级不自动迁移或开始阅读。
- Fresh per-execution leases preserve stable reading and batch identities. Confirmation facts synchronize without erasing receipt checkpoints. Explicit recovery is limited to host-proven zero-call lease failures; unknown submissions remain blocked. No host API, permission, contract or data-schema version changes.

# 2.0.7

- 完整精读计划在当前主窗口插件页面内查看和确认；只有明确选择独立窗口时才移出主窗口。
- 观看安排顶部恢复当前账号的全部待确认计划，不受最近 200 条观看记录限制；刷新和重启后仍按宿主实际确认状态显示。
- 待确认使用中性提示，不再标成观看失败或第 3 步暂停；宿主尚未接受确认时保持未确认。
- Added inline complete-plan review, durable account-scoped pending-plan recovery, and host-authoritative confirmation state. Existing consent, quotas, contract and data versions are unchanged.

# 2.0.6

- 新任务采用独立完整精读协议：默认全片每 0.5 秒采样、每 6 秒阅读窗、每图最多 12 帧；尾窗保留空格。两个秒参数可改，当前 P 为默认，可选择其他 P 或全部 P。
- 开始前展示原视频帧图、P 范围、模型、帧/图/窗口/字幕数量和预计调用；确认冻结计划后自动顺序执行，无固定 16 次截停。改参数/P 会新建预览，旧记录保留。
- 全部字幕以 cue ID、原文 SHA256 和字符 offset 分页；模型容量不足缩批/补页，不丢图或截尾。事实、对白与不确定项先逐批记录，再整理角色感想；原文、拼图和 checkpoint 保留。
- 实际原视频通过固定大小 Range 流式读取；一条后台解码/拼图流水线，线程和领先缓存有界。无法取得原视频时暂停，不用平台预览图冒充固定采样。
- 新任务及参数使用独立 KV 键；2.0.5 任务继续原模式，原调用记录和额度池保留。已知未提交最多重试两次；未知提交不重发。完成整份计划才形成一条独立观看经历。
- Added complete, source-preserved reading with a frozen preview/confirmation, adjustable sampling/window seconds, explicit part selection, full cue-character coverage, bounded background decoding, and durable uncertain-submission checkpoints. Legacy tasks retain their mode and usage.

# 2.0.2

- 没有连接 B站账号时页面能打开：显示「先连接一个 B站账号」和扫码连接，并照实写明这个版本看视频也要用账号（视频和字幕经账号读取，额度和记录按账号分开）。以前读设置直接被拒，页面报错。
- 预约行：窗口内「现在看」（计入这个预约）、暂停后「继续」、看完后「看记录」、「更多 › 取消这个预约」；写视频标题或「按兴趣挑选 · 还剩 N 个」；看完的预约不再显示原始值 completed。「今天不看」放在预约列表上方。
- 正在看的卡：「观看中」和按四个步骤的进度条；现在看不再挡住暂停、停止。
- 预览框写「还能再发 N 条」；已发表的评论「在 B站查看」打开这条评论；笔记写条数；没取到视频的原因用文字写，代码收进技术详情。
- 设置：「被打断后」（选「等我继续」时自动恢复也会等你）；看完后增加「聊天结束后说」（每个都说，和「她挑值得说的」一样等你们没在聊天时）；默认参与角色；评论开关算一项改动。新设置另存，回退到 2.0.1 仍能读写原设置。
- 读取失败用黄色提示和技术详情；页面自己滚动；角色头像显示宿主给的图；扫码登录或删除账号后自动重新读取。
- Watching with no account connected now shows a connect card that states the actual rule; plan rows get their own actions; preview shows the remaining allowance; new settings: after-chat sharing, default character; the page scrolls itself and shows character faces.

# 0.1.0-dev.5

- Revalidate cached subtitles by fetching them through the host after a definitive pre-model provenance rejection. Retry at most once; unknown model outcomes are never replayed.

# 0.1.0-dev.2

修复跨午夜已完成理解的原日计次、部分材料缓存无法升级、材料过滤/截断虚假完整、并发继续重复执行、异步权限/设置检查竞态、分享候选在用户返回后的迟到投递、评论事实错误范围与模型来源、退出未排空独立outbox操作、重启未知请求被安排替换、旧人生/过期暂停阻塞新安排、重试诊断污染幂等payload。新增控制代次、安排原子结算与完整缓存校验；schema仍为1，minimumWriter单调升级到dev.2。旧候选、失败测试记录与外部未验收状态保留。

冻结复核追加：平台rpid只接受正安全整数或长度不超过64的非零十进制字符串；对象、数组、布尔、零、空值及不安全数均不能标为已发送。领域层对归一化platformId再次校验，畸形回执保留unknown名额且不重发。

# 0.1.0-dev.1

新增隔离B站领域流程、共享SQLite额度、材料/理解证据边界、持久outbox、暂停/睡眠/跨日规则、托管评论唯一出口及原生DSH页面入口。社交桥和受管理平台操作仍为未签认提案；真实外部账号和最终联合安装未执行。

## 2.0.2

- 添加宿主保管的预览分镜、图片输入、分段阅读、预算和进度接口；沿用原有UI。
- 手动与自动预约共用阅读器；新增自动画面阅读显式确认。
- 每片16次调用、最多2次细看；未知结果不重试，账号/人生和材料引用继续隔离。
- 新阅读记录独立保存，原schema/合同兼容；不重新编码动画，不随功能自动登录、发表评论或安装正式程序。
