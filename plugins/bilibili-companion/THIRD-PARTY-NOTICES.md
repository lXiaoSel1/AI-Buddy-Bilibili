# Current distribution note — 2.0.11

The original notices below are retained as historical provenance. The plugin archive does not include platform content, credentials, FFmpeg/ASR or NapCat. The host now provides separately managed components; NapCat is obtained unmodified from its pinned official upstream only after explicit Connect, and the FFmpeg-only media kit adds no ASR model. This repository does not mirror those components. Root THIRD_PARTY_NOTICES.md and licenses/upstream/LICENSE.md preserve the legal references in the unchanged license. Current installation evidence and unverified live-platform/model limits are in README.md. Existing host artwork/reference-rights qualifications remain; no blanket rights-clearance claim is made.

---

# 第三方说明

本插件自有实现没有复制 B站上游插件脚本，没有打包Cookie、登录态、视频资源、ASR模型、FFmpeg或QQ依赖。DSH包及客户端注册形状参照本项目Source10工作与协作插件；许可沿本项目现行LICENSE.md。运行使用Node.js内置SQLite，其运行时许可保留在交付根隔离runtime中。

HTTP路径、响应字段、WBI固定置换数据等协议事实参考本地只读历史研究：`integration/_reports-archive/ai-buddy-autonomous-companion-plan/20261020-r1/sources/Alterssss__dsh-bili-whale/tools/commands/subtitles.mjs`和同目录`video-content.mjs`。该历史package.json声明MIT，但本地未见LICENSE文本，因此未复制其实现或将其源文件纳入本包。A独立实现受管理HTTP流程与生命周期。历史研究不等于当前API实测；固定端点未来可能变化。

受管理B站后端、FFmpeg或ASR如日后纳入，整合者须固定版本、核实许可并补充声明。本候选不声称已有这些组件的分发授权或真实平台兼容验证。
