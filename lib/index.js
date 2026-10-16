/**
 * dsh-workbuddy-checkin —— DeepSeek Harness 插件。
 *
 * 在 DSH 里注册一个 `workbuddy_checkin` 工具：读取**本机** WorkBuddy 桌面端的
 * 加密登录态（仅在内存中解密），查询并领取每日签到积分。
 *
 * 挂载方式（由本包的 cordis.patch.yml 声明）：
 *
 *     - insert:
 *         - id: workbuddy-checkin
 *           name: dsh-workbuddy-checkin
 *
 * 安全约定：令牌只在内存中解密后立即用于请求头，不落盘、不完整回显。
 * 只有 action="claim" 会改变服务端状态。
 *
 * @module dsh-workbuddy-checkin
 */

import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

import { listAccounts, runCheckin, selftest } from "./run.js";

const name = "workbuddy-checkin";
const inject = ["tools"];

/** 插件配置（全部可选）：由 cordis.patch.yml 的 config 段提供。 */
const Config = z.object({
	/** 覆盖登录态目录（自动探测失败时用）。 */
	authDir: z.string(),
	/** 默认只处理的账号名；工具参数 account 会覆盖它。 */
	accounts: z.array(z.string())
});

const ACTIONS = ["status", "claim", "accounts", "selftest"];

const DESCRIPTION = [
	"Check in to the WorkBuddy daily credit check-in for every WorkBuddy account signed in on this machine, and report per-account result.",
	"It reads WorkBuddy's local encrypted sign-in state, decrypts the tokens in memory only (they are never written to disk and never echoed in full), and calls WorkBuddy's own check-in API.",
	"An account whose check-in activity is not running is skipped and reported as no_activity — that is NOT a missed check-in and must not be treated as a failure.",
	"action='status' only reads and reports; 'claim' additionally claims today's credits for accounts that have an active activity and have not checked in yet; 'accounts' lists the discovered accounts with no network call; 'selftest' verifies the decryption chain offline.",
	"Prefer 'status'. Use 'claim' only when the user actually wants the credits claimed."
].join(" ");

/** 把编排层的内部结果裁剪成工具输出 schema 允许的字段。 */
const shape = (r) => ({ text: r.text, ok: r.ok, actions: r.actions });

/**
 * 在 ctx.tools 上注册 workbuddy_checkin。
 * @param {object} ctx - 携带 tools 注册表的 Cordis 上下文
 * @param {{authDir?: string, accounts?: string[]}} [config]
 */
function apply(ctx, config) {
	const cfg = config ?? {};

	ctx.tools.register(
		defineTool({
			name: "workbuddy_checkin",
			description: DESCRIPTION,
			parameters: {
				action: {
					type: "string",
					required: true,
					enum: [...ACTIONS],
					description:
						"status (read-only, default choice) | claim (read-only then claim today's credits) | accounts (offline list) | selftest (offline decryption check)."
				},
				account: {
					type: "array",
					items: { type: "string" },
					description:
						"Limit to these account names (as listed by action='accounts'), e.g. ['workbuddy-desktop']. Omit to handle every account found on this machine."
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						text: {
							type: "string",
							required: true
						},
						ok: {
							type: "boolean",
							required: true
						},
						actions: {
							type: "array",
							required: true,
							items: { type: "string" }
						}
					}
				},
				render: (_args, value) => [{ type: "text", text: value.text }]
			},
			async execute(args) {
				const only = args.account?.length ? args.account : cfg.accounts;
				const arg = { accounts: only?.length ? only : undefined, authDir: cfg.authDir };
				if (args.action === "accounts") return shape(listAccounts(arg));
				if (args.action === "selftest") return shape(selftest(arg));
				return shape(await runCheckin({ action: args.action, ...arg }));
			},
			presentCall: (args) => ({
				card: "generic",
				title: args.action === "claim" ? "WorkBuddy 签到（领取）" : "WorkBuddy 签到",
				kind: "other",
				rawInput: args
			})
		})
	);
}

export { Config, apply, inject, name };
