# dsh-workbuddy-checkin

**DeepSeek Harness 插件**：给 DSH 注册一个 `workbuddy_checkin` 工具，读取**本机** WorkBuddy 桌面端的加密登录态（只在内存中解密），查询并领取每日签到积分。

不是 WorkBuddy 插件，是 **DSH 插件** —— 一个 npm 包，通过 Cordis 挂进 DSH 的插件树。

仓库：<https://github.com/leoc114119/dsh-workbuddy-checkin>

一行装：

```sh
dsh plugin --profile desktop add github:leoc114119/dsh-workbuddy-checkin
```

---

## 它解决什么

WorkBuddy 桌面端每天签到 +100 积分，但：

- 签到入口在客户端里，得手动点；
- 多账号（`WorkBuddy` / `WorkBuddy AI`）要分别点；
- 登录态是**加密落盘**的（`$wbEncrypted` 信封 + 两层密钥），直接读文件拿不到令牌。

这个插件把这三件事包成一个工具，于是 DSH 里既能手动问一句，也能挂排程每天自动跑。

## 安装

### 方式一：从本地目录装（开发 / 自用）

```sh
dsh plugin --profile desktop add file:/绝对路径/dsh-workbuddy-checkin
```

> ⚠️ **路径前必须带 `file:`。** 裸路径会被 pnpm 装成 `link:` 符号链接，而 Node 解析依赖走 realpath
> —— 符号链接会让插件的 `@deepseek-ai/*` 依赖从**你的源码目录**往上找（那里没有），于是 DSH 只打一行
> `workbuddy-checkin (dsh-workbuddy-checkin): failed to import`，插件静默不生效。
> `file:` 会让 pnpm 在 profile 的 `node_modules/` 里落地成**真实目录**，依赖查找才能沿 profile 往上
> 命中 App 运行时自带的 `@deepseek-ai/*`。代价：`file:` 是拷贝不是链接，改完源码要重装一次。

### 方式二：从 npm 装（发布后）

```sh
dsh plugin --profile desktop add dsh-workbuddy-checkin
```

### 方式三：从 GitHub 装（已实测可用，无需 npm 账号）

```sh
dsh plugin --profile desktop add github:leoc114119/dsh-workbuddy-checkin
```

> DSH 桌面端也可以在 **设置 → 插件** 里装，等价于上面命令。
> 装完在 `~/.dsh/profiles/<profile>/package.json` 的 `dsh.profile.bundles` 里会多出 `dsh-workbuddy-checkin`。

## 用法

### 作为 DSH 工具

装好后模型就有 `workbuddy_checkin` 工具：

| `action` | 作用 | 会不会改状态 |
|---|---|---|
| `status` | 只读查询每个账号的签到状态 | 否 |
| `claim` | 先查，未签到且有活动则领取 | **是** |
| `accounts` | 列出本机发现的账号与各自 host（不联网） | 否 |
| `selftest` | 只验解密链路（keyblob → 令牌 → host），不联网 | 否 |

`account` 参数可选，传账号名数组则只处理这几个。

### 作为命令行

包里带 `bin`，可以不经过模型直接用：

```sh
dsh-workbuddy-checkin status      # 只读
dsh-workbuddy-checkin claim       # 查并领取
dsh-workbuddy-checkin accounts    # 列账号
dsh-workbuddy-checkin selftest    # 只验解密链路
dsh-workbuddy-checkin status --json
dsh-workbuddy-checkin status --account workbuddy-desktop
```

环境变量：

| 变量 | 作用 |
|---|---|
| `WB_AUTH_DIR` | 覆盖登录态目录（自动探测失败时用） |
| `WB_KEYBLOB` | 覆盖 keyblob 路径 |

### 每天 8 点自动签到

在 DSH 里建一条每天 08:00 的排程，提示词写：

```
调用 workbuddy_checkin 工具，action=claim，把每个账号的结果报给我。
```

排程到期会把提醒投进原会话，模型就会调这个工具 —— 不需要系统级定时器。

## 工作原理

### 登录态在哪

按优先级找第一个含 `.info` 的目录：

| 平台 | 路径 |
|---|---|
| macOS | `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth` |
| Windows | `%APPDATA%\CodeBuddyExtension\Data\Public\auth` |
| Linux | `$XDG_CONFIG_HOME/CodeBuddyExtension/Data/Public/auth` |
| 兜底 | `~/.workbuddy/auth` |

### 两层密钥（关键）

敏感字段用 `$wbEncrypted` 信封加密，**不是**「一个全局密钥直接加密」：

```
~/.workbuddy/keyblob                     ← 每台机器一份，首次运行随机生成，mode 600
  keyId: <本机数据密钥 ID>
  slots[]: { type: "static-v1", protectorKeyId: <保护密钥 ID>, wrapped: <信封> }
                                         ← wrapped 是用「保护密钥」加密的本机数据密钥
```

- **保护密钥**是 App 内置的全局常量，所有安装一致；
- **数据密钥**每台机器不同，随机生成后存在 keyblob 里。

所以流程是：用保护密钥按 `framing="file"` 拆开 `keyblob.slots[].wrapped` 得到本机数据密钥 → 再拿**与信封 `keyId` 匹配**的那把钥匙去解字段。

> ⚠️ 信封带 `keyId`，必须**按 keyId 选钥匙**。不能因为「开发机上恰好是保护密钥的 ID」就写死。

### 两种信封

| scheme | 结构 |
|---|---|
| 对称（默认） | 载荷直接用数据密钥 AES-256-GCM 加密 |
| `asym-v1` | 随机 32 字节文件密钥加密载荷；文件密钥被包两次 —— `userWrap`（用使用者密钥，**我们能解**）与 `developerWrap`（RSA-OAEP，托管恢复用，**读取时用不到**） |

`authorWrap` / `developerWrap` 的存在意味着**不需要任何私钥**就能读自己的数据。

### host 不写死

「该打哪个域名」从令牌自己的 JWT `iss` 推导，其次 `auth.domain`，最后才退回已知映射。账号文件名各版本/各渠道可能不同，写死必然漏。

### 两个容易踩的坑

- **状态端点必须用** `POST /v2/billing/meter/checkin-activity-status`。同目录的 `checkin-status` 是桩接口，对**所有账号**恒定返回 `active:false` / `streak:0` / `total_credits:0`，会把「今天已签到」误报成「未签到」。
- **「没有活动」≠「今天没签」**。前者调领取端点只会得到 HTTP 400「签到活动未开启或已过期」，应当跳过而不是报错。
- 判断状态看 `active` / `activity_name` / `theme_name` / `season` / `start_time` / `today_checked_in` / `streak_days` / `total_credits` / `checkin_dates`。**不要用 `daily_credit`**：真端点对所有账号恒 100、桩端点恒 0，没有区分力。

## 安全

- 令牌**只在内存中解密**，随即用于请求头；**不落盘、不完整回显**（输出一律脱敏成 `eyJhbG…(1395 字符，已脱敏)`）。
- 只**读**登录态文件与 keyblob，不改写、不复制。
- 除 `claim` 外所有动作都不发写请求。
- 请求只发往从你自己令牌 `iss` 推导出的官方域名。
- 本包不含任何硬编码的开发机密钥或账号信息 —— 唯一的常量是 App 内置的**公开**保护密钥（所有安装一致，不是秘密）。

## 已验证到什么程度

诚实分级：

| 结论 | 级别 |
|---|---|
| 解密链路（keyblob 两层密钥 → 令牌 → host） | **确定** —— 本机两个账号（`workbuddy-desktop` / `workbuddy-desktop-ai`）实测解密成功，与独立 Python 实现逐字段一致 |
| 状态查询 | **确定** —— 对两个真实账号真实请求，结果与 Python 版一致（一个 `no_activity`、一个 `already_checked_in`，连续 17 天 / 1700 积分） |
| **DSH 挂载 + 工具调用** | **确定** —— 装进 profile 后 Cordis 成功挂载；`headless` 会话里模型确实调用了 `workbuddy_checkin`，返回上面两段真实结果（即本 README 的表格数据来源） |
| `asym-v1` 信封 | **按源码实现 + 往返验证** —— 本机没有真实 `asym-v1` 样本，构造样例验证通过 |
| 真正领到一次积分 | **尚未** —— 本机账号当天都已签到 / 无活动，没有可领的机会 |
| 跨机器可用 | **未验证** —— 密钥层级按通用逻辑实现（按 keyId 选钥匙），但只在开发机上跑过 |

## 许可

MIT © 2026 leochen
