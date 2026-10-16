#!/usr/bin/env node
/**
 * dsh-workbuddy-checkin 命令行入口 —— 与 DSH 插件工具共用同一套 lib/。
 *
 * 用法：
 *   dsh-workbuddy-checkin status     只查签到状态（只读）
 *   dsh-workbuddy-checkin claim      查状态，未签到则领取（默认动作）
 *   dsh-workbuddy-checkin accounts   列出本机发现的账号与各自 host（不联网）
 *   dsh-workbuddy-checkin selftest   只验解密链路（keyblob → 令牌 → host），不联网、不改状态
 *
 * 通用参数：
 *   --json        以 JSON 输出
 *   --account X   只处理某个账号，可重复
 *   -v/--verbose  打印更多过程信息（令牌始终脱敏）
 *
 * 环境变量：
 *   WB_AUTH_DIR   覆盖登录态目录（自动探测失败时手动指定）
 *   WB_KEYBLOB    覆盖 keyblob 路径
 */

import { listAccounts, runCheckin, selftest } from "./run.js";

const ACTIONS = new Set(["status", "claim", "accounts", "selftest"]);

function parse(argv) {
	const opts = { action: "claim", json: false, account: [], verbose: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--json") opts.json = true;
		else if (a === "-v" || a === "--verbose") opts.verbose = true;
		else if (a === "--account") opts.account.push(argv[++i]);
		else if (a === "-h" || a === "--help") opts.action = "help";
		else if (!a.startsWith("-") && ACTIONS.has(a)) opts.action = a;
		else {
			process.stderr.write(`未知参数：${a}\n`);
			opts.action = "help";
		}
	}
	return opts;
}

const HELP = `WorkBuddy 每日积分签到（DSH 插件 / 可共享）

用法：
  dsh-workbuddy-checkin [status|claim|accounts|selftest] [--json] [--account X] [-v]

  status     只查签到状态（只读）
  claim      查状态，未签到则领取（默认动作，会改变服务端状态）
  accounts   列出本机发现的账号与各自 host（不联网）
  selftest   只验解密链路，不联网、不改状态

环境变量：
  WB_AUTH_DIR   覆盖登录态目录
  WB_KEYBLOB    覆盖 keyblob 路径
`;

async function main() {
	const opts = parse(process.argv.slice(2));
	if (opts.action === "help") {
		process.stdout.write(HELP);
		return 0;
	}
	const arg = { accounts: opts.account.length ? opts.account : undefined };

	let out;
	if (opts.action === "accounts") out = listAccounts(arg);
	else if (opts.action === "selftest") out = selftest(arg);
	else out = await runCheckin({ action: opts.action, ...arg });

	if (opts.json) process.stdout.write(JSON.stringify(out, null, 2) + "\n");
	else process.stdout.write(out.text + "\n");
	return out.ok ? 0 : 1;
}

main().then(
	(code) => process.exit(code),
	(exc) => {
		process.stderr.write(`未预期的错误：${exc?.stack ?? exc}\n`);
		process.exit(3);
	}
);
