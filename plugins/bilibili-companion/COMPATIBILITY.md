# 2.0.11 compatibility / 当前兼容性

AI Buddy >= 2.0.2. Functional baseline remains 2.0.10; this patch changes independent source distribution, reproducible build helpers, documentation and version identifiers. Existing bridge 1.3.0, full-reading protocol, runtime contract hash, declared capabilities, schema 1 and minimumWriter 0.1.0-dev.2 stay unchanged. It does not migrate/replay old tasks or grant consent, quotas or model calls. Current accepted install/load and synthetic Electron evidence is described in README.md; real platform/model acceptance remains separate.

以下章节按其原始版本保留为历史记录；其中“未安装/未联调”的表述不覆盖上述当前范围。Older sections below describe their historical revision.

# 2.0.7 候选兼容性

本候选只修复内嵌确认入口和当前账号待确认计划恢复。沿用完整精读协议、合同哈希、bridgeVersion、SQLite schema 1、minimumWriter 和既有 KV 键；不迁移旧任务、不增加同意或额度、不自动获取新材料或调用模型。2.0.6 原记录保留。

This candidate keeps the existing reading protocol and storage format. Pending-plan discovery is an authenticated plugin read; confirmation and execution retain their original host authority.

# 2.0.6 候选兼容性

本候选递增插件到 2.0.6；宿主桥接合同哈希、私有 SQLite schema 1 与 minimumWriter 保持。新活动/参数分别放在 `full-activity-v206:*`、`reading-full-v1:*`、`settings-v206`，旧 2.0.5 查询不扫描新活动。旧任务、旧调用池和历史原文不自动转换、不清空、不重放。正式签名、安装与真实平台/模型验收由集成负责人另行执行，源码或 Mock 不能替代验收。

The 2.0.6 candidate adds separate keys and a capability-negotiated complete-reading protocol. Existing tasks retain their mode, history and usage. No bridge hash or SQLite schema migration is required. Signing, installation and live platform/model acceptance remain separate evidence.

# 本地第3批复验：观看与预约（历史记录）

先连接一个B站账号才能看。视频和字幕通过所选账号读取，额度和历史也按账号隔离；发表评论需要另外授权。Connect a Bilibili account before watching. Posting comments needs separate permission.

新增预约可选择按角色兴趣挑选，或者填写BV编号/官方视频链接。链接只保留规范BV编号，不保存分享参数。指定视频模式按所选次数让参与角色轮流观看同一个视频。

指定视频预约每次重启后需要在当前实例确认。确认预约本身不会打开自主观看、取得视频或调用模型；仍需原来的观看许可、当天时窗、睡眠状态与账号共享额度。取消后不再恢复。

指定视频预约及其活动使用原schema 1数据库里的独立KV命名空间。回退到2.0.1时，这些新预约和活动保留但不显示、不执行；原来的兴趣预约、设置和额度仍照旧。再次升级后仍需确认，不把旧版本的Stop或Continue当作新预约授权。完成与用量事实不会因为回退而删除或重放。

源代码与本地Mock/文件系统测试不等于真实账号和平台验收；没有在本次开发测试里登录账号、发表评论或调用真实模型。此轮不改变插件版本、桥接版本、协议哈希、schema版本或minimumWriter。
