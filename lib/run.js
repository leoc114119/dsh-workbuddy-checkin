/**
 * 签到编排层 —— 对应 Python 版 wb_checkin.py 的 run() / cmd_accounts() / cmd_selftest()。
 *
 * 与命令行版共享同一套逻辑：DSH 插件工具、CLI、脚本调用都走这里，
 * 避免「插件一套、命令行一套」两份实现漂移。
 *
 * ⚠️ 只有 action="claim" 会改变服务端状态；status / accounts / selftest 全程只读。
 */

import { authDirs, discover, findAuthDir } from "./accounts.js";
import { KEYBLOB_PATH, candidateKeys, mask, unwrapKeyblob } from "./crypto.js";

/** 列出本机发现的账号（不联网）。 */
export function listAccounts({ accounts: only, authDir } = {}) {
	const dir = authDir || findAuthDir();
	const rows = discover(only, authDir).map((acc) => ({
		account: acc.name,
		host: acc.host,
		host_source: acc.hostSrc,
		uid: acc.uid || null,
		nickname: acc.nickname,
		token: acc.token ? mask(acc.token) : null,
		usable: !acc.error,
		error: acc.error
	}));

	const lines = [];
	if (!rows.length) {
		lines.push("未发现任何 WorkBuddy 登录态。已尝试：");
		for (const c of authDirs()) lines.push(`  - ${c}`);
		lines.push("可用环境变量 WB_AUTH_DIR 手动指定目录。");
		return { ok: false, text: lines.join("\n"), actions: [], results: rows };
	}
	lines.push(`登录态目录：${dir}`);
	for (const r of rows) {
		lines.push(
			`${r.account}  host=${r.host} [${r.host_source}]  ` +
				(r.usable ? `✅ nickname=${r.nickname ?? "?"} token=${r.token}` : `❌ ${r.error}`)
		);
	}
	lines.push("");
	lines.push("令牌一律脱敏，不落盘。");
	return { ok: true, text: lines.join("\n"), actions: rows.map((r) => `${r.account}:${r.usable ? "ok" : "error"}`), results: rows };
}

/** 只验解密链路（keyblob → 令牌 → host），不联网、不改状态。 */
export function selftest({ accounts: only, authDir } = {}) {
	const lines = [];
	let ok = true;

	lines.push("1) keyblob");
	lines.push(`   路径：${KEYBLOB_PATH}`);
	const kb = unwrapKeyblob();
	if (kb.size) {
		for (const kid of kb.keys()) lines.push(`   ✅ 解出本机数据密钥 keyId=${kid}`);
	} else {
		lines.push("   ℹ️  未能解出数据密钥（若 auth 字段用保护密钥加密，仍可正常工作）");
	}
	const keys = candidateKeys();
	lines.push(`   可用密钥：${[...keys.keys()].filter(Boolean).sort().join(", ")}`);

	lines.push("2) 登录态目录");
	const dir = authDir || findAuthDir();
	if (!dir) {
		lines.push("   ❌ 未找到。尝试过的路径：");
		for (const c of authDirs()) lines.push(`      - ${c}`);
		return { ok: false, text: lines.join("\n"), actions: [], results: [] };
	}
	lines.push(`   ✅ ${dir}`);

	lines.push("3) 令牌解密与 host 推导");
	const accounts = discover(only, authDir);
	if (!accounts.length) {
		lines.push("   ❌ 目录内没有 .info");
		return { ok: false, text: lines.join("\n"), actions: [], results: [] };
	}
	for (const acc of accounts) {
		if (acc.error) {
			lines.push(`   ❌ ${acc.name}：${acc.error}`);
			ok = false;
		} else {
			lines.push(`   ✅ ${acc.name}：token=${mask(acc.token)} host=${acc.host}（来源 ${acc.hostSrc}）`);
		}
	}
	lines.push("");
	lines.push(ok ? "自检通过。" : "自检未通过。");
	return {
		ok,
		text: lines.join("\n"),
		actions: accounts.map((a) => `${a.name}:${a.error ? "error" : "ok"}`),
		results: accounts.map((a) => ({ account: a.name, host: a.host, host_source: a.hostSrc, ok: !a.error, error: a.error }))
	};
}

/**
 * 查询（并可选领取）签到。
 * @param {object} opts
 * @param {"status"|"claim"} [opts.action] status=只读；claim=未签则领取
 * @param {string[]} [opts.accounts] 只处理指定账号名
 * @param {string} [opts.authDir] 覆盖登录态目录
 */
export async function runCheckin({ action = "claim", accounts: only, authDir } = {}) {
	const doClaim = action === "claim";
	const list = discover(only, authDir);
	if (!list.length) {
		const tried = authDirs().map((c) => `  - ${c}`).join("\n");
		return {
			ok: false,
			text: `未发现任何 WorkBuddy 登录态。已尝试：\n${tried}\n（可用 WB_AUTH_DIR 指定目录）`,
			actions: [],
			results: []
		};
	}

	const results = [];
	const lines = [];
	const actions = [];
	let exitCode = 0;

	for (const acc of list) {
		const entry = { account: acc.name, host: acc.host, nickname: acc.nickname };
		lines.push(`── ${acc.name} ──`);
		lines.push(`host：${acc.host}（来源 ${acc.hostSrc}）`);

		if (acc.error) {
			entry.ok = false;
			entry.stage = "auth";
			entry.error = acc.error;
			actions.push(`${acc.name}:auth_error`);
			lines.push(`❌ ${acc.error}`);
			results.push(entry);
			exitCode = Math.max(exitCode, 1);
			continue;
		}

		const st = await acc.status();
		entry.status = st;
		if (!st.ok) {
			entry.ok = false;
			entry.stage = "status";
			entry.error = st.error;
			actions.push(`${acc.name}:status_error`);
			lines.push(`❌ 状态查询失败：${st.error}`);
			results.push(entry);
			exitCode = Math.max(exitCode, 1);
			continue;
		}

		if (st.active) {
			lines.push(`活动：进行中（${st.activity_name || "未命名"}${st.theme_name ? ` / ${st.theme_name}` : ""}，第 ${st.season} 季）`);
			if (st.start_time || st.end_time) lines.push(`窗口：${st.start_time} ~ ${st.end_time}`);
		} else {
			lines.push("活动：该账号没有进行中的签到活动");
		}
		lines.push(
			`今日已签到：${st.today_checked_in ? "是" : "否"} ｜ 连续 ${st.streak_days} 天 ｜ 累计 ${st.total_credits ?? "?"} 积分`
		);

		// 没有活动 ≠ 今天没签。前者领不了（服务端返回 400「签到活动未开启或已过期」），
		// 必须单独判定，否则会把「该账号压根没有活动」误报成「漏签了、快去补领」。
		if (!st.active) {
			entry.ok = true;
			entry.action = "no_activity";
			actions.push(`${acc.name}:no_activity`);
			lines.push("ℹ️  该账号当前没有可签到的活动，跳过（不是漏签，也无需补领）。");
			results.push(entry);
			continue;
		}

		if (st.today_checked_in) {
			entry.ok = true;
			entry.action = "already_checked_in";
			actions.push(`${acc.name}:already_checked_in`);
			lines.push("✅ 今天已签过，无需操作。");
			results.push(entry);
			continue;
		}

		if (!doClaim) {
			entry.ok = true;
			entry.action = "would_claim";
			actions.push(`${acc.name}:would_claim`);
			lines.push("⏳ 今天还没签（只读模式，未领取）。用 action=claim 领取。");
			results.push(entry);
			continue;
		}

		const cl = await acc.claim();
		entry.claim = cl;
		if (cl.ok) {
			entry.ok = true;
			entry.action = "claimed";
			actions.push(`${acc.name}:claimed:+${cl.credit}`);
			lines.push(`🎉 签到成功：+${cl.credit} 积分（连续 ${cl.streak_days} 天）`);
		} else {
			entry.ok = false;
			entry.stage = "claim";
			entry.error = cl.error;
			actions.push(`${acc.name}:claim_failed`);
			lines.push(`❌ 领取失败：${cl.error}`);
			exitCode = Math.max(exitCode, 1);
		}
		results.push(entry);
	}

	const counted = results.filter((r) => r.action !== "no_activity" && !r.stage);
	const skipped = results.length - counted.length;
	const okCount = counted.filter((r) => r.ok).length;
	let summary = `合计 ${results.length} 个账号，成功 ${okCount} 个`;
	if (skipped) summary += `，${skipped} 个无签到活动/出错（跳过或失败，非漏签）`;
	lines.push("");
	lines.push(summary + "。");

	return { ok: exitCode === 0, text: lines.join("\n"), actions, results };
}
