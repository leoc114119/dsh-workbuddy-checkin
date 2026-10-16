/**
 * WorkBuddy 账号发现与签到接口 —— Node 移植版（对应 Python 版 wb_checkin.py）。
 *
 * 设计要点（均为实测结论，勿随意改动）：
 *   * 状态端点必须用 POST /v2/billing/meter/checkin-activity-status。
 *     同目录的 checkin-status 是桩接口，对**所有账号**恒定返回 active:false、
 *     streak:0、total_credits:0、checkin_dates:null（哪怕对方已连续签到 17 天），
 *     会把「今天已签到」误报成「未签到」。
 *   * 判断账号状态请看 active / activity_name / theme_name / season / start_time /
 *     today_checked_in / streak_days / total_credits / checkin_dates。
 *     **不要用 daily_credit**：真端点对所有账号恒 100、桩端点恒 0，没有区分力。
 *   * 「没有活动」不等于「今天没签」：前者调领取端点只会得到 HTTP 400
 *     「签到活动未开启或已过期」，应当跳过而不是报错。
 *   * host **不写死账号名**：从令牌自己的 iss（签发方）推导，其次 auth.domain，
 *     最后才退回已知映射。账号文件名各版本/各渠道可能不同，写死必然漏。
 *   * 鉴权只需 Authorization: Bearer。X-User-Id / X-Domain 照官方客户端一并带上
 *     （实测传正确 uid、不传、传伪造 uid 三者返回一致，即并非必需）。
 *
 * 安全：令牌只在内存中解密后立即用于请求头，不落盘、不完整回显。
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { mask, openWbField } from "./crypto.js";

/** 已知账号名 → host。仅作**最后兜底**；正常情况下 host 由令牌的 iss 推导。 */
const KNOWN_HOSTS = {
	"workbuddy-desktop": "www.codebuddy.cn",
	"workbuddy-desktop-ai": "www.workbuddy.ai"
};
const DEFAULT_HOST = "www.codebuddy.cn";

const PATH_STATUS = "/v2/billing/meter/checkin-activity-status";
const PATH_CLAIM = "/v2/billing/meter/daily-checkin";
const TIMEOUT_MS = 25000;

/** 跨平台候选登录态目录，按优先级排列。 */
export function authDirs() {
	const home = homedir();
	const leaf = ["CodeBuddyExtension", "Data", "Public", "auth"];
	const cands = [];
	if (process.platform === "darwin") {
		cands.push(join(home, "Library", "Application Support", ...leaf));
		cands.push(join(home, ".workbuddy", "auth"));
	} else if (process.platform === "win32") {
		const appdata = process.env.APPDATA || join(home, "AppData", "Roaming");
		cands.push(join(appdata, ...leaf));
		cands.push(join(home, ".workbuddy", "auth"));
	} else {
		const xdg = process.env.XDG_CONFIG_HOME || join(home, ".config");
		cands.push(join(xdg, ...leaf));
		cands.push(join(home, ".workbuddy", "auth"));
	}
	const override = process.env.WB_AUTH_DIR;
	if (override) cands.unshift(override.replace(/^~(?=\/|$)/, home));
	return cands;
}

/** 返回第一个存在且含 .info 的目录；找不到返回 null。 */
export function findAuthDir() {
	for (const d of authDirs()) {
		try {
			if (statSync(d).isDirectory() && readdirSync(d).some((f) => f.endsWith(".info"))) return d;
		} catch {
			/* 不存在或不可读：继续找下一个 */
		}
	}
	return null;
}

/** 从 JWT 解出签发方域名 —— 这是「该打哪个 host」最可靠的来源。 */
export function hostFromToken(token) {
	try {
		const parts = String(token).split(".");
		if (parts.length < 2) return null;
		// ⚠️ 补 padding 必须用 ((4 - len % 4) % 4)：JS 的 % 保留被除数符号，
		// 直接照抄 Python 的 -len % 4 会得到负数，repeat(-n) 抛 RangeError，
		// 于是所有 payload 长度不是 4 的倍数的令牌都会解码失败（被兜底掩盖）。
		const seg = parts[1];
		const payload = seg + "=".repeat((4 - (seg.length % 4)) % 4);
		const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
		for (const field of ["iss", "domain", "aud"]) {
			const v = data?.[field];
			for (const item of Array.isArray(v) ? v : [v]) {
				if (typeof item !== "string" || !item.includes("://")) continue;
				try {
					const host = new URL(item).hostname;
					if (host) return host;
				} catch {
					/* 非 URL：跳过 */
				}
			}
		}
	} catch {
		/* 不是 JWT：交给上层走兜底 */
	}
	return null;
}

/** 一个账号的登录态与签到操作。 */
export class Account {
	constructor(name, path) {
		this.name = name;
		this.path = path;
		this.host = null;
		this.hostSrc = null;
		this.token = null;
		this.uid = null;
		this.domain = null;
		this.nickname = null;
		this.error = null;
	}

	/** 读取并解密登录态；失败时记录 error 而不是抛出，便于多账号并存。 */
	load() {
		let data;
		try {
			data = JSON.parse(readFileSync(this.path, "utf8"));
		} catch (exc) {
			this.error = `读取失败: ${exc?.name ?? "Error"}: ${exc?.message ?? exc}`;
			return this;
		}

		const auth = data?.auth ?? {};
		const account = data?.account ?? {};
		try {
			this.token = openWbField(auth.accessToken);
		} catch (exc) {
			this.error = `令牌解密失败: ${exc?.name ?? "Error"}: ${exc?.message ?? exc}`;
			return this;
		}

		this.uid = account.uid ?? "";
		this.domain = auth.domain ?? "";

		// host 优先级：令牌 iss > auth.domain > 已知映射 > 默认
		const issHost = hostFromToken(this.token);
		if (issHost) {
			this.host = issHost;
			this.hostSrc = "token.iss";
		} else if (this.domain) {
			this.host = this.domain;
			this.hostSrc = "auth.domain";
		} else if (KNOWN_HOSTS[this.name]) {
			this.host = KNOWN_HOSTS[this.name];
			this.hostSrc = "known-hosts";
		} else {
			this.host = DEFAULT_HOST;
			this.hostSrc = "default(兜底)";
		}

		try {
			this.nickname = openWbField(account.nickname);
		} catch {
			this.nickname = null;
		}
		if (!this.token || !this.uid) this.error = "登录态缺少 accessToken 或 uid";
		return this;
	}

	/**
	 * 发一次请求。
	 * @returns {Promise<[number|"ERR", object]>} [HTTP 状态码或 "ERR", 解析后的响应体]
	 */
	async request(path, method = "POST") {
		const url = `https://${this.host}${path}`;
		// 服务端只认 Bearer；X-User-Id / X-Domain 与官方客户端保持一致地带上，
		// 但实测并非必需（不传 / 传伪造 uid 结果完全相同）。
		const headers = {
			Authorization: `Bearer ${this.token}`,
			Accept: "application/json",
			"Content-Type": "application/json",
			"X-User-Id": this.uid
		};
		if (this.domain) headers["X-Domain"] = this.domain;
		try {
			const res = await fetch(url, {
				method,
				headers,
				body: method === "POST" ? "{}" : undefined,
				signal: AbortSignal.timeout(TIMEOUT_MS)
			});
			const raw = await res.text();
			let payload;
			try {
				payload = raw.trim() ? JSON.parse(raw) : {};
			} catch {
				payload = { raw: raw.slice(0, 300) };
			}
			return [res.status, payload ?? {}];
		} catch (exc) {
			return ["ERR", { error: `${exc?.name ?? "Error"}: ${exc?.message ?? exc}` }];
		}
	}

	/** 查签到状态（只读）。 */
	async status() {
		const [code, payload] = await this.request(PATH_STATUS, "POST");
		if (code !== 200) return { ok: false, http: code, error: errOf(payload, code) };
		const data = payload?.data ?? {};
		if (payload?.code !== 0) {
			return { ok: false, http: code, error: payload?.msg || "接口返回非 0" };
		}
		return {
			ok: true,
			active: !!data.active,
			activity_name: data.activity_name || "",
			theme_name: data.theme_name || "",
			season: data.season || 0,
			start_time: data.start_time || "",
			end_time: data.end_time || "",
			today_checked_in: !!data.today_checked_in,
			streak_days: data.streak_days || 0,
			daily_credit: data.daily_credit || 0,
			today_credit: data.today_credit || 0,
			total_credits: data.total_credits,
			checkin_dates: data.checkin_dates || []
		};
	}

	/** 领取今日签到（**会改变服务端状态**）。 */
	async claim() {
		const [code, payload] = await this.request(PATH_CLAIM, "POST");
		const body = payload ?? {};
		if (code !== 200) return { ok: false, http: code, error: errOf(body, code) };
		if (body.code != null && body.code !== 0) {
			return { ok: false, http: code, error: body.msg || "领取失败", code: body.code };
		}
		const data = body.data ?? {};
		return {
			ok: true,
			credit: data.credit || body.credit || 0,
			streak_days: data.streak_days || body.streak_days || 0
		};
	}
}

function errOf(payload, httpCode) {
	const p = payload ?? {};
	if (p.msg) return p.msg;
	if (p.error) return p.error;
	if (p.raw) return p.raw;
	if (httpCode === 401) return "401 未授权（host 用错了？该账号需打自己的域名）";
	return `HTTP ${httpCode}`;
}

/**
 * 扫描登录态目录，返回账号列表（已 load）。
 * @param {string[]} [only] 只处理这些账号名
 * @param {string} [authDir] 覆盖目录
 */
export function discover(only, authDir) {
	const d = authDir || findAuthDir();
	if (!d) return [];
	const accounts = [];
	for (const fn of readdirSync(d).sort()) {
		if (!fn.endsWith(".info")) continue;
		const name = fn.slice(0, -".info".length);
		if (only?.length && !only.includes(name)) continue;
		accounts.push(new Account(name, join(d, fn)).load());
	}
	return accounts;
}

export { DEFAULT_HOST, KNOWN_HOSTS, PATH_CLAIM, PATH_STATUS, mask };
