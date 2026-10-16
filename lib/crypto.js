/**
 * $wbEncrypted 信封解密 —— Node 移植版（对应 Python 版 wbcrypto.py）。
 *
 * WorkBuddy 桌面端把登录态里的敏感字段（accessToken / refreshToken / nickname /
 * phoneNumber）用 AES-256-GCM 信封加密后落盘。Node 自带 aes-256-gcm，所以这里
 * 不需要像 Python 版那样手写 AES/GHASH，但**信封与密钥层级的格式必须逐字节一致**。
 *
 * ## 密钥层级（关键，别再搞错）
 *
 * App 用的是两层结构，**不是**「一个全局密钥直接加密」：
 *
 *     ~/.workbuddy/keyblob            ← 每台机器一份（首次运行随机生成，mode 600）
 *       keyId: <本机数据密钥ID>
 *       slots[]: { type: "static-v1", protectorKeyId: <保护密钥ID>, wrapped: <信封> }
 *                                    ← wrapped 是用「保护密钥」加密的本机数据密钥
 *
 *   * 「保护密钥」(protector) 是 App 内置的全局常量，所有安装一致；
 *   * 「数据密钥」每台机器不同，随机生成后存在 keyblob 里。
 *
 * 所以通用解法是：用保护密钥按 framing="file" 解开 keyblob.slots[].wrapped，
 * 得到本机的数据密钥；再拿**与信封 keyId 相匹配**的那把钥匙去解字段。
 *
 * ⚠️ 原开发机实测：auth 文件的信封 keyId 恰好等于保护密钥的 ID，所以直接用保护
 * 密钥就能解开 —— 但那是那台机器的巧合，**不能**据此写成通用实现。别人的机器上
 * auth 文件可能用 keyblob 里的数据密钥，必须按 keyId 选钥匙。
 *
 * AAD 里绑定 framing/keyId/suite，顺序错一个字节 tag 校验就失败。
 *
 * 安全约定：本模块只在内存里解密，绝不把明文写回磁盘、不打印完整令牌。
 */

import { createDecipheriv, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// --------------------------------------------------------------------------
// 常量
// --------------------------------------------------------------------------

/** 保护密钥（App 内置全局常量）。仅用于解开 keyblob；不要假设它是数据密钥。 */
const PROTECTOR_SECRET = "Sik9U5aXhCdwTVEwsEySDOmDoB9r9ntFxHF1fst9LQI=";
const PROTECTOR_KEY = createHash("sha256").update(PROTECTOR_SECRET, "utf8").digest();
export const PROTECTOR_KEY_ID = createHash("sha256").update(PROTECTOR_KEY).digest("hex").slice(0, 16);

const FRAMING_NUM = { file: 1, field: 2, record: 3, stream: 4 };
const FRAMING_TAG = { file: "WBEF1", field: "WBEV1", record: "WBER1", stream: "WBES1" };

// 非对称信封（asym-v1）的 framing tag 与对称**不同**：file 是 WBEA1 不是 WBEF1。
const ASYM_FRAMING_TAG = { file: "WBEA1", field: "WBEV1" };
const WRAP_MAGIC = "WB-WRAP\0";

export const KEYBLOB_PATH = process.env.WB_KEYBLOB || join(homedir(), ".workbuddy", "keyblob");

// --------------------------------------------------------------------------
// 基础工具
// --------------------------------------------------------------------------

const u32 = (n) => {
	const b = Buffer.alloc(4);
	b.writeUInt32BE(n >>> 0);
	return b;
};

const lenpref = (s) => {
	const b = Buffer.isBuffer(s) ? s : Buffer.from(String(s), "utf8");
	return Buffer.concat([u32(b.length), b]);
};

const optStr = (s) => (s == null ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), lenpref(s)]));

const b64 = (s) => Buffer.from(String(s), "base64");

/**
 * AES-256-GCM 解密并校验 tag。tag 不符时 throw。
 * @param {Buffer} key 32 字节密钥
 * @param {Buffer} nonce
 * @param {Buffer} ct 密文
 * @param {Buffer} tag 16 字节认证标签
 * @param {Buffer} aad 附加认证数据
 * @returns {Buffer} 明文
 */
export function aesGcmDecrypt(key, nonce, ct, tag, aad) {
	const d = createDecipheriv("aes-256-gcm", key, nonce);
	d.setAAD(aad);
	d.setAuthTag(tag);
	return Buffer.concat([d.update(ct), d.final()]);
}

/** 复刻 App 的对称信封 AAD 拼装顺序（顺序错则 tag 校验必失败）。 */
function wbAad(framing, keyId, suite) {
	return Buffer.concat([
		Buffer.from("WB-AAD\0", "utf8"),
		Buffer.from([1]),
		lenpref(FRAMING_TAG[framing]),
		lenpref("sym-v1"),
		u32(suite),
		lenpref(keyId),
		Buffer.from([FRAMING_NUM[framing]]),
		Buffer.from([0, 0])
	]);
}

/**
 * asym-v1 载荷的 AAD（对应 App 的 buildAuthenticatedContextAad）。
 * ⚠️ 与 file key wrap 的 AAD **不能合并**：magic 不同、末尾字节也不同。
 */
function asymContextAad(framing, keyId, suite, purpose, resourceId, fieldPath) {
	return Buffer.concat([
		Buffer.from("WB-AAD\0", "utf8"),
		Buffer.from([1]),
		lenpref(ASYM_FRAMING_TAG[framing]),
		lenpref("asym-v1"),
		u32(suite),
		lenpref(keyId),
		Buffer.from([FRAMING_NUM[framing]]),
		lenpref(purpose),
		lenpref(resourceId),
		optStr(fieldPath),
		Buffer.from([0, 0])
	]);
}

/** 包裹文件密钥时的 AAD（对应 App 的 buildFileKeyWrapContext；末尾**没有**额外字节）。 */
function fileKeyWrapAad(framing, fileKeyId, devKeyId, suite, purpose, resourceId, fieldPath) {
	return Buffer.concat([
		Buffer.from(WRAP_MAGIC, "utf8"),
		Buffer.from([1]),
		lenpref(ASYM_FRAMING_TAG[framing]),
		lenpref("asym-v1"),
		u32(suite),
		lenpref(fileKeyId),
		lenpref(devKeyId),
		Buffer.from([FRAMING_NUM[framing]]),
		lenpref(purpose),
		lenpref(resourceId),
		optStr(fieldPath)
	]);
}

const keyList = (keys) => [...keys.keys()].filter(Boolean).sort().join(", ");

// --------------------------------------------------------------------------
// 信封
// --------------------------------------------------------------------------

/** 把 base64 信封解成对象。 */
function parseEnvelope(raw) {
	const env = JSON.parse(b64(raw).toString("utf8"));
	if (!env || typeof env !== "object" || Array.isArray(env)) throw new Error("信封不是对象");
	return env;
}

/** 用 keys 里 keyId 匹配的那把钥匙解对称信封。 */
function openEnvelope(env, framing, keys) {
	const keyId = env.keyId;
	const key = keys.get(keyId);
	if (!key) throw new Error(`没有匹配的密钥：信封 keyId=${keyId}，已有的=${keyList(keys)}`);
	return aesGcmDecrypt(key, b64(env.nonce), b64(env.ciphertext), b64(env.authTag), wbAad(framing, keyId, env.suite));
}

/**
 * 解开 asym-v1 信封。结构照抄 App 自己的 openAsymmetricEnvelope：
 *   载荷用一把随机「文件密钥」加密；文件密钥被包两次 ——
 *   一次用**使用者密钥**（userWrap，我们能解），一次用开发者 RSA 公钥
 *   （developerWrap，读取时用不到，只是托管恢复用）。
 * 所以只要手里有使用者密钥（keyblob 里的数据密钥），无需任何私钥就能解密。
 */
function openAsym(env, framing, keys) {
	if (env.suite !== 1) throw new Error(`不支持的 asym 套件：${env.suite}`);
	const wrap = env.userWrap;
	const dev = env.developerWrap;
	if (!wrap || typeof wrap !== "object" || !dev || typeof dev !== "object") {
		throw new Error("asym 信封缺少 userWrap / developerWrap");
	}
	const { purpose, resourceId } = env;
	const fieldPath = env.fieldPath;
	if (typeof purpose !== "string" || typeof resourceId !== "string") {
		throw new Error("asym 信封缺少 purpose / resourceId");
	}
	if (framing === "field" && !fieldPath) throw new Error("asym 字段信封缺少 fieldPath");

	const userKey = keys.get(wrap.keyId);
	if (!userKey) {
		throw new Error(`没有与 userWrap.keyId=${wrap.keyId} 匹配的密钥（已有的=${keyList(keys)}）`);
	}

	const fileKey = aesGcmDecrypt(
		userKey,
		b64(wrap.nonce),
		b64(wrap.ciphertext),
		b64(wrap.authTag),
		fileKeyWrapAad(framing, env.keyId, dev.publicKeyId, env.suite, purpose, resourceId, fieldPath)
	);
	if (fileKey.length !== 32 || createHash("sha256").update(fileKey).digest("hex").slice(0, 16) !== env.keyId) {
		throw new Error("拆出的文件密钥与信封 keyId 不符");
	}

	return aesGcmDecrypt(
		fileKey,
		b64(env.nonce),
		b64(env.ciphertext),
		b64(env.authTag),
		asymContextAad(framing, env.keyId, env.suite, purpose, resourceId, fieldPath)
	);
}

// --------------------------------------------------------------------------
// 密钥层级
// --------------------------------------------------------------------------

/**
 * 解开 keyblob，返回 Map<keyId, Buffer>。失败返回空 Map。
 *
 * 这是让插件在**别人机器上**也能用的关键一步：keyblob 用全局保护密钥包着
 * 本机随机生成的 32 字节数据密钥。
 * @param {string} [path] keyblob 路径，默认 ~/.workbuddy/keyblob
 * @returns {Map<string, Buffer>}
 */
export function unwrapKeyblob(path) {
	const out = new Map();
	let kb;
	try {
		kb = JSON.parse(readFileSync(path || KEYBLOB_PATH, "utf8"));
	} catch {
		return out;
	}
	const target = kb?.keyId;
	for (const slot of kb?.slots ?? []) {
		if (!slot || typeof slot !== "object" || slot.type !== "static-v1") continue;
		if (typeof slot.wrapped !== "string") continue;
		let pt;
		try {
			// keyblob 用 framing="file" 包裹（实测确认；field/record/stream 均 tag 失败）
			pt = openEnvelope(parseEnvelope(slot.wrapped), "file", new Map([[PROTECTOR_KEY_ID, PROTECTOR_KEY]]));
		} catch {
			continue;
		}
		if (pt.length === 32 && createHash("sha256").update(pt).digest("hex").slice(0, 16) === target) {
			out.set(target, pt);
		}
	}
	return out;
}

/**
 * 所有可用的解密钥匙：Map<keyId, Buffer>。
 *
 * 含保护密钥本身与 keyblob 里的本机数据密钥 —— 信封里带 keyId，按 keyId 选即可，
 * 这样无论对方机器把字段加密在哪一层都能解。
 * @returns {Map<string, Buffer>}
 */
export function candidateKeys() {
	const keys = new Map([[PROTECTOR_KEY_ID, PROTECTOR_KEY]]);
	for (const [k, v] of unwrapKeyblob()) keys.set(k, v);
	return keys;
}

/**
 * 解开一个 $wbEncrypted 字段；非信封字段原样返回。
 *
 * 同时支持两种信封：
 *   * 对称（默认，envelope 里就是载荷）—— 用与 keyId 匹配的密钥直解；
 *   * 非对称（scheme: "asym-v1"）—— 先用使用者密钥拆出文件密钥再解载荷。
 * @param {unknown} value
 * @param {Map<string, Buffer>} [keys]
 * @returns {unknown} 明文字符串（或原值）
 */
export function openWbField(value, keys) {
	if (!value || typeof value !== "object" || value.$wbEncrypted !== 1) return value;
	const ks = keys ?? candidateKeys();
	const env = parseEnvelope(value.envelope);
	if (value.scheme === "asym-v1" || env.scheme === "asym-v1") {
		return openAsym(env, "field", ks).toString("utf8");
	}
	return openEnvelope(env, "field", ks).toString("utf8");
}

/** 脱敏显示：只留前缀，绝不回显完整令牌。 */
export function mask(secret, keep = 6) {
	if (!secret) return "(空)";
	const s = String(secret);
	if (s.length <= keep) return s[0] + "*".repeat(Math.max(0, s.length - 1));
	return `${s.slice(0, keep)}…(${s.length} 字符，已脱敏)`;
}
