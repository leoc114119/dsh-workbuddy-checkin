# 更新记录

## 0.1.1 — 2026-10-17

**适配 DSH 内核 `0.2.1-rc.2`，补兼容性说明与发布元数据。工具行为无变化。**

- ✅ 在 DSH **0.2.1-rc.2** 上实测通过：插件挂载为 `active`，`workbuddy_checkin` 工具
  正常返回（`workbuddy-desktop` 第 10 季 / 连续 18 天 / 累计 1800 积分；
  `workbuddy-desktop-ai` 无进行中活动 → 按 `no_activity` 跳过）。
- 📄 README 新增「与 DSH 内核的兼容性」一节：解释本插件**故意不声明
  `peerDependencies`** 的理由，以及 `file:` 安装（拷贝而非链接）改完源码必须重装。
- 📄 README「已验证到什么程度」表补上 `0.2.1-rc.2` 实测行。
- 🧹 `package.json` 补 `homepage` / `repository` / `bugs`，`files` 纳入本文件。

> 为什么会有这一版：同一天 `dsh-workbuddy-connect` 因为把 `peerDependencies`
> **精确钉死**在内核版本上（`0.2.0-rc.2`），在内核升到 `0.2.1-rc.x` 后被宿主
> 版本闸门拦下，整条 provider 静默消失、插件页只剩空态。本插件不声明 peers，
> 因此两次内核升级都没被波及 —— 这次把这条经验写进文档，而不是跟着去钉版本。

## 0.1.0 — 2026-10-16

首个版本。

- `workbuddy_checkin` 工具：`status` / `claim` / `accounts` / `selftest` 四个动作。
- 读取本机 WorkBuddy 加密登录态，**仅在内存中解密**令牌（不落盘、不完整回显）。
- 两层密钥解密链路（保护密钥拆 keyblob → 本机数据密钥 → 按信封 `keyId` 选钥匙）；
  支持对称与 `asym-v1` 两种信封。
- check-in host 从令牌 JWT 的 `iss` 推导，不写死域名。
- 状态判断用 `/v2/billing/meter/checkin-activity-status`（不是桩接口 `checkin-status`），
  且区分「没有活动」与「今天没签」。
- 同时提供 `bin`（CLI），与 DSH 工具共用同一套 `lib/`。
