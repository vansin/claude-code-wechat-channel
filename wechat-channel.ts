#!/usr/bin/env bun
/**
 * Claude Code WeChat Channel Plugin
 *
 * Bridges WeChat messages into a Claude Code session via the Channels MCP protocol.
 * Uses the official WeChat ClawBot ilink API (same as @tencent-weixin/openclaw-weixin).
 *
 * Flow:
 *   1. QR login via ilink/bot/get_bot_qrcode + get_qrcode_status
 *   2. Long-poll ilink/bot/getupdates for incoming WeChat messages
 *   3. Forward messages to Claude Code as <channel> events
 *   4. Expose a reply tool so Claude can send messages back via ilink/bot/sendmessage
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ── Config ────────────────────────────────────────────────────────────────────

const CHANNEL_NAME = "wechat";
const CHANNEL_VERSION = "0.2.0";
const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const BOT_TYPE = "3";
const WECHAT_ACCOUNT = process.env.WECHAT_ACCOUNT || "default";
const CREDENTIALS_DIR = path.join(
  process.env.HOME || "~",
  ".claude",
  "channels",
  "wechat",
);
const ACCOUNTS_DIR = path.join(CREDENTIALS_DIR, "accounts");

// Resolve credentials file: accounts/<name>.json > legacy account.json (default only)
function resolveCredentialsFile(): string {
  const accountFile = path.join(ACCOUNTS_DIR, `${WECHAT_ACCOUNT}.json`);
  if (fs.existsSync(accountFile)) return accountFile;
  // Only fallback to legacy file for "default" account
  if (WECHAT_ACCOUNT === "default") {
    const legacyFile = path.join(CREDENTIALS_DIR, "account.json");
    if (fs.existsSync(legacyFile)) return legacyFile;
  }
  return accountFile; // Will trigger "not found" during login
}
const CREDENTIALS_FILE = resolveCredentialsFile();

const LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;

// ── Logging (stderr only — stdout is MCP stdio) ─────────────────────────────

const LOG_PREFIX = WECHAT_ACCOUNT === "default" ? "[wechat]" : `[wechat:${WECHAT_ACCOUNT}]`;

function log(msg: string) {
  process.stderr.write(`${LOG_PREFIX} ${msg}\n`);
}

function logError(msg: string) {
  process.stderr.write(`${LOG_PREFIX} ERROR: ${msg}\n`);
}

// ── Credentials ──────────────────────────────────────────────────────────────

type AccountData = {
  token: string;
  baseUrl: string;
  accountId: string;
  userId?: string;
  savedAt: string;
};

function loadCredentials(): AccountData | null {
  try {
    if (!fs.existsSync(CREDENTIALS_FILE)) return null;
    return JSON.parse(fs.readFileSync(CREDENTIALS_FILE, "utf-8"));
  } catch {
    return null;
  }
}

function saveCredentials(data: AccountData): void {
  // Ensure accounts/ directory exists for multi-account support
  fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
  // Save to accounts/<name>.json
  const accountFile = path.join(ACCOUNTS_DIR, `${WECHAT_ACCOUNT}.json`);
  fs.writeFileSync(accountFile, JSON.stringify(data, null, 2), "utf-8");
  try { fs.chmodSync(accountFile, 0o600); } catch { /* best-effort */ }
  // Default account also writes legacy file for backward compat
  if (WECHAT_ACCOUNT === "default") {
    const legacyFile = path.join(CREDENTIALS_DIR, "account.json");
    fs.writeFileSync(legacyFile, JSON.stringify(data, null, 2), "utf-8");
    try { fs.chmodSync(legacyFile, 0o600); } catch { /* best-effort */ }
  }
}

// ── WeChat ilink API ─────────────────────────────────────────────────────────

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildHeaders(token?: string, body?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
  };
  if (body) {
    headers["Content-Length"] = String(Buffer.byteLength(body, "utf-8"));
  }
  if (token?.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }
  return headers;
}

async function apiFetch(params: {
  baseUrl: string;
  endpoint: string;
  body: string;
  token?: string;
  timeoutMs: number;
}): Promise<string> {
  const base = params.baseUrl.endsWith("/")
    ? params.baseUrl
    : `${params.baseUrl}/`;
  const url = new URL(params.endpoint, base).toString();
  const headers = buildHeaders(params.token, params.body);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: params.body,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
    return text;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ── QR Login ─────────────────────────────────────────────────────────────────

interface QRCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

interface QRStatusResponse {
  status: "wait" | "scaned" | "confirmed" | "expired";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
}

async function fetchQRCode(baseUrl: string): Promise<QRCodeResponse> {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = new URL(
    `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(BOT_TYPE)}`,
    base,
  );
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`QR fetch failed: ${res.status}`);
  return (await res.json()) as QRCodeResponse;
}

async function pollQRStatus(
  baseUrl: string,
  qrcode: string,
): Promise<QRStatusResponse> {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = new URL(
    `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
    base,
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35_000);
  try {
    const res = await fetch(url.toString(), {
      headers: { "iLink-App-ClientVersion": "1" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`QR status failed: ${res.status}`);
    return (await res.json()) as QRStatusResponse;
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      return { status: "wait" };
    }
    throw err;
  }
}

async function doQRLogin(
  baseUrl: string,
): Promise<AccountData | null> {
  log("正在获取微信登录二维码...");
  const qrResp = await fetchQRCode(baseUrl);

  log("\n请使用微信扫描以下二维码：\n");
  try {
    const qrterm = await import("qrcode-terminal");
    await new Promise<void>((resolve) => {
      qrterm.default.generate(
        qrResp.qrcode_img_content,
        { small: true },
        (qr: string) => {
          process.stderr.write(qr + "\n");
          resolve();
        },
      );
    });
  } catch {
    log(`二维码链接: ${qrResp.qrcode_img_content}`);
  }

  log("等待扫码...");
  const deadline = Date.now() + 480_000;
  let scannedPrinted = false;

  while (Date.now() < deadline) {
    const status = await pollQRStatus(baseUrl, qrResp.qrcode);

    switch (status.status) {
      case "wait":
        break;
      case "scaned":
        if (!scannedPrinted) {
          log("👀 已扫码，请在微信中确认...");
          scannedPrinted = true;
        }
        break;
      case "expired":
        log("二维码已过期，请重新启动。");
        return null;
      case "confirmed": {
        if (!status.ilink_bot_id || !status.bot_token) {
          logError("登录确认但未返回 bot 信息");
          return null;
        }
        const account: AccountData = {
          token: status.bot_token,
          baseUrl: status.baseurl || baseUrl,
          accountId: status.ilink_bot_id,
          userId: status.ilink_user_id,
          savedAt: new Date().toISOString(),
        };
        saveCredentials(account);
        log("✅ 微信连接成功！");
        return account;
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  log("登录超时");
  return null;
}

// ── WeChat Message Types ─────────────────────────────────────────────────────

interface TextItem {
  text?: string;
}

interface RefMessage {
  message_item?: MessageItem;
  title?: string;
}

interface CDNMedia {
  encrypt_query_param?: string;
  aes_key?: string;
}

interface ImageItem {
  media?: CDNMedia;
  thumb_media?: CDNMedia;
  aeskey?: string;  // hex-encoded AES key (preferred over media.aes_key)
  url?: string;
}

interface MessageItem {
  type?: number;
  text_item?: TextItem;
  voice_item?: { text?: string };
  image_item?: ImageItem;
  ref_msg?: RefMessage;
}

interface WeixinMessage {
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  session_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
  create_time_ms?: number;
}

interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

// Message type constants
const MSG_TYPE_USER = 1;
const MSG_ITEM_TEXT = 1;
const MSG_ITEM_IMAGE = 2;
const MSG_ITEM_VOICE = 3;
const MSG_TYPE_BOT = 2;
const MSG_STATE_FINISH = 2;

// ── CDN Media Download + AES Decrypt ─────────────────────────────────────────

const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const MEDIA_DIR = path.join(CREDENTIALS_DIR, "media", WECHAT_ACCOUNT);

function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

function parseAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new Error(`Invalid AES key length: ${decoded.length}`);
}

async function downloadAndDecryptImage(imageItem: ImageItem): Promise<string | null> {
  const encryptQueryParam = imageItem.media?.encrypt_query_param;
  if (!encryptQueryParam) {
    log("image: no encrypt_query_param");
    return null;
  }

  // Get AES key: prefer image_item.aeskey (hex) over media.aes_key (base64)
  let aesKeyBase64: string | undefined;
  if (imageItem.aeskey) {
    aesKeyBase64 = Buffer.from(imageItem.aeskey, "hex").toString("base64");
  } else if (imageItem.media?.aes_key) {
    aesKeyBase64 = imageItem.media.aes_key;
  }

  const cdnUrl = `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`;
  log(`image: downloading from CDN...`);

  try {
    const res = await fetch(cdnUrl);
    if (!res.ok) {
      logError(`image CDN download failed: ${res.status}`);
      return null;
    }
    const encrypted = Buffer.from(await res.arrayBuffer());
    log(`image: downloaded ${encrypted.length} bytes`);

    let imageBuffer: Buffer;
    if (aesKeyBase64) {
      const key = parseAesKey(aesKeyBase64);
      imageBuffer = decryptAesEcb(encrypted, key);
      log(`image: decrypted ${imageBuffer.length} bytes`);
    } else {
      imageBuffer = encrypted;
      log(`image: no AES key, using raw bytes`);
    }

    // Save to local file
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    const filename = `img_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.jpg`;
    const filepath = path.join(MEDIA_DIR, filename);
    fs.writeFileSync(filepath, imageBuffer);
    log(`image: saved to ${filepath}`);
    return filepath;
  } catch (err) {
    logError(`image download/decrypt failed: ${String(err)}`);
    return null;
  }
}

function extractContentFromMessage(msg: WeixinMessage): { text: string; imageUrls: string[] } {
  const imageUrls: string[] = [];
  let text = "";

  if (!msg.item_list?.length) return { text, imageUrls };

  for (const item of msg.item_list) {
    if (item.type === MSG_ITEM_TEXT && item.text_item?.text) {
      const t = item.text_item.text;
      const ref = item.ref_msg;
      if (!ref) {
        text = t;
      } else {
        const parts: string[] = [];
        if (ref.title) parts.push(ref.title);
        text = parts.length ? `[引用: ${parts.join(" | ")}]\n${t}` : t;
      }
    }
    if (item.type === MSG_ITEM_IMAGE && item.image_item) {
      // Mark that we have an image; actual download happens async in polling loop
      const encParam = item.image_item.media?.encrypt_query_param;
      if (encParam) imageUrls.push(`__pending_download__`);
      else if (item.image_item.url) imageUrls.push(item.image_item.url);
    }
    if (item.type === MSG_ITEM_VOICE && item.voice_item?.text) {
      text = item.voice_item.text;
    }
  }

  return { text, imageUrls };
}

// Backward-compat wrapper
function extractTextFromMessage(msg: WeixinMessage): string {
  const { text, imageUrls } = extractContentFromMessage(msg);
  if (imageUrls.length > 0 && !text) {
    return `[用户发送了${imageUrls.length}张图片]\n${imageUrls.map(u => `图片: ${u}`).join("\n")}`;
  }
  if (imageUrls.length > 0 && text) {
    return `${text}\n${imageUrls.map(u => `[附图: ${u}]`).join("\n")}`;
  }
  return text;
}

// ── Context Token Cache ──────────────────────────────────────────────────────

const contextTokenCache = new Map<string, string>();

function cacheContextToken(userId: string, token: string): void {
  contextTokenCache.set(userId, token);
}

function getCachedContextToken(userId: string): string | undefined {
  return contextTokenCache.get(userId);
}

// ── getUpdates / sendMessage ─────────────────────────────────────────────────

async function getUpdates(
  baseUrl: string,
  token: string,
  getUpdatesBuf: string,
): Promise<GetUpdatesResp> {
  try {
    const raw = await apiFetch({
      baseUrl,
      endpoint: "ilink/bot/getupdates",
      body: JSON.stringify({
        get_updates_buf: getUpdatesBuf,
        base_info: { channel_version: CHANNEL_VERSION },
      }),
      token,
      timeoutMs: LONG_POLL_TIMEOUT_MS,
    });
    return JSON.parse(raw) as GetUpdatesResp;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
    }
    throw err;
  }
}

function generateClientId(): string {
  return `claude-code-wechat:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

async function sendTextMessage(
  baseUrl: string,
  token: string,
  to: string,
  text: string,
  contextToken: string,
): Promise<string> {
  const clientId = generateClientId();
  await apiFetch({
    baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body: JSON.stringify({
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: clientId,
        message_type: MSG_TYPE_BOT,
        message_state: MSG_STATE_FINISH,
        item_list: [{ type: MSG_ITEM_TEXT, text_item: { text } }],
        context_token: contextToken,
      },
      base_info: { channel_version: CHANNEL_VERSION },
    }),
    token,
    timeoutMs: 15_000,
  });
  return clientId;
}

async function uploadImageToCdn(
  baseUrl: string,
  token: string,
  toUserId: string,
  imagePath: string,
): Promise<{ downloadParam: string; aeskey: string; fileSize: number; fileSizeCiphertext: number }> {
  // Read image file
  let plaintext: Buffer;
  if (imagePath.startsWith("http://") || imagePath.startsWith("https://")) {
    // Download from URL first
    log(`image upload: downloading from ${imagePath.slice(0, 60)}...`);
    const res = await fetch(imagePath);
    if (!res.ok) throw new Error(`Failed to download image: ${res.status}`);
    plaintext = Buffer.from(await res.arrayBuffer());
  } else {
    plaintext = fs.readFileSync(imagePath);
  }

  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString("hex");
  const aeskey = crypto.randomBytes(16);

  log(`image upload: rawsize=${rawsize} filesize=${filesize} md5=${rawfilemd5}`);

  // Step 1: Get upload URL
  const uploadUrlRaw = await apiFetch({
    baseUrl,
    endpoint: "ilink/bot/getuploadurl",
    body: JSON.stringify({
      filekey,
      media_type: 1, // IMAGE
      to_user_id: toUserId,
      rawsize,
      rawfilemd5,
      filesize,
      no_need_thumb: true,
      aeskey: aeskey.toString("hex"),
      base_info: { channel_version: CHANNEL_VERSION },
    }),
    token,
    timeoutMs: 15_000,
  });
  const uploadUrlResp = JSON.parse(uploadUrlRaw);
  const uploadParam = uploadUrlResp.upload_param;
  if (!uploadParam) {
    throw new Error(`getUploadUrl returned no upload_param: ${uploadUrlRaw}`);
  }

  // Step 2: Encrypt and upload to CDN
  const ciphertext = encryptAesEcb(plaintext, aeskey);
  const cdnUrl = `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
  log(`image upload: uploading ${ciphertext.length} bytes to CDN...`);

  const cdnRes = await fetch(cdnUrl, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: new Uint8Array(ciphertext),
  });
  if (!cdnRes.ok) {
    const errMsg = cdnRes.headers.get("x-error-message") || `status ${cdnRes.status}`;
    throw new Error(`CDN upload failed: ${errMsg}`);
  }
  const downloadParam = cdnRes.headers.get("x-encrypted-param");
  if (!downloadParam) {
    throw new Error("CDN response missing x-encrypted-param header");
  }

  log(`image upload: CDN upload success`);
  return {
    downloadParam,
    aeskey: aeskey.toString("hex"),
    fileSize: rawsize,
    fileSizeCiphertext: filesize,
  };
}

async function sendImageMessage(
  baseUrl: string,
  token: string,
  to: string,
  imageSource: string,
  contextToken: string,
): Promise<string> {
  const clientId = generateClientId();

  try {
    // Upload to WeChat CDN with AES encryption
    const uploaded = await uploadImageToCdn(baseUrl, token, to, imageSource);

    await apiFetch({
      baseUrl,
      endpoint: "ilink/bot/sendmessage",
      body: JSON.stringify({
        msg: {
          from_user_id: "",
          to_user_id: to,
          client_id: clientId,
          message_type: MSG_TYPE_BOT,
          message_state: MSG_STATE_FINISH,
          item_list: [{
            type: MSG_ITEM_IMAGE,
            image_item: {
              media: {
                encrypt_query_param: uploaded.downloadParam,
                aes_key: Buffer.from(uploaded.aeskey, "hex").toString("base64"),
              },
              aeskey: uploaded.aeskey,
              hd_size: uploaded.fileSizeCiphertext,
              mid_size: uploaded.fileSizeCiphertext,
            },
          }],
          context_token: contextToken,
        },
        base_info: { channel_version: CHANNEL_VERSION },
      }),
      token,
      timeoutMs: 15_000,
    });
    log(`image sent via CDN to ${to}`);
  } catch (err) {
    logError(`CDN image upload failed: ${String(err)}, falling back to URL mode`);
    // Fallback: try sending URL directly (may not work)
    await apiFetch({
      baseUrl,
      endpoint: "ilink/bot/sendmessage",
      body: JSON.stringify({
        msg: {
          from_user_id: "",
          to_user_id: to,
          client_id: clientId,
          message_type: MSG_TYPE_BOT,
          message_state: MSG_STATE_FINISH,
          item_list: [{ type: MSG_ITEM_IMAGE, image_item: { url: imageSource } }],
          context_token: contextToken,
        },
        base_info: { channel_version: CHANNEL_VERSION },
      }),
      token,
      timeoutMs: 15_000,
    });
  }
  return clientId;
}

// ── MCP Channel Server ──────────────────────────────────────────────────────

const mcp = new Server(
  { name: CHANNEL_NAME, version: CHANNEL_VERSION },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: [
      `Messages from WeChat users arrive as <channel source="wechat" sender="..." sender_id="...">`,
      "Reply using the wechat_reply tool for text, or wechat_reply_image for images.",
      "You MUST pass the sender_id from the inbound tag.",
      "Messages are from real WeChat users via the WeChat ClawBot interface.",
      "When a user sends an image, the message will contain the image URL. You can analyze it or reference it.",
      "Respond naturally in Chinese unless the user writes in another language.",
      "Keep replies concise — WeChat is a chat app, not an essay platform.",
      "Strip markdown formatting (WeChat doesn't render it). Use plain text.",
    ].join("\n"),
  },
);

// Tools: reply to WeChat (text + image)
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "wechat_reply",
      description: "Send a text reply back to the WeChat user",
      inputSchema: {
        type: "object" as const,
        properties: {
          sender_id: {
            type: "string",
            description:
              "The sender_id from the inbound <channel> tag (xxx@im.wechat format)",
          },
          text: {
            type: "string",
            description: "The plain-text message to send (no markdown)",
          },
        },
        required: ["sender_id", "text"],
      },
    },
    {
      name: "wechat_reply_image",
      description: "Send an image reply back to the WeChat user. Provide a publicly accessible image URL.",
      inputSchema: {
        type: "object" as const,
        properties: {
          sender_id: {
            type: "string",
            description:
              "The sender_id from the inbound <channel> tag (xxx@im.wechat format)",
          },
          image_url: {
            type: "string",
            description: "The publicly accessible URL of the image to send",
          },
        },
        required: ["sender_id", "image_url"],
      },
    },
  ],
}));

let activeAccount: AccountData | null = null;

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "wechat_reply") {
    const { sender_id, text } = req.params.arguments as {
      sender_id: string;
      text: string;
    };
    if (!activeAccount) {
      return {
        content: [{ type: "text" as const, text: "error: not logged in" }],
      };
    }
    const contextToken = getCachedContextToken(sender_id);
    if (!contextToken) {
      return {
        content: [
          {
            type: "text" as const,
            text: `error: no context_token for ${sender_id}. The user may need to send a message first.`,
          },
        ],
      };
    }
    try {
      await sendTextMessage(
        activeAccount.baseUrl,
        activeAccount.token,
        sender_id,
        text,
        contextToken,
      );
      return { content: [{ type: "text" as const, text: "sent" }] };
    } catch (err) {
      return {
        content: [
          { type: "text" as const, text: `send failed: ${String(err)}` },
        ],
      };
    }
  }
  if (req.params.name === "wechat_reply_image") {
    const { sender_id, image_url } = req.params.arguments as {
      sender_id: string;
      image_url: string;
    };
    if (!activeAccount) {
      return {
        content: [{ type: "text" as const, text: "error: not logged in" }],
      };
    }
    const contextToken = getCachedContextToken(sender_id);
    if (!contextToken) {
      return {
        content: [
          {
            type: "text" as const,
            text: `error: no context_token for ${sender_id}. The user may need to send a message first.`,
          },
        ],
      };
    }
    try {
      await sendImageMessage(
        activeAccount.baseUrl,
        activeAccount.token,
        sender_id,
        image_url,
        contextToken,
      );
      return { content: [{ type: "text" as const, text: "image sent" }] };
    } catch (err) {
      return {
        content: [
          { type: "text" as const, text: `image send failed: ${String(err)}` },
        ],
      };
    }
  }

  throw new Error(`unknown tool: ${req.params.name}`);
});

// ── Long-poll loop ──────────────────────────────────────────────────────────

async function startPolling(account: AccountData): Promise<never> {
  const { baseUrl, token } = account;
  let getUpdatesBuf = "";
  let consecutiveFailures = 0;

  // Load cached sync buf if available
  const syncBufFile = path.join(CREDENTIALS_DIR, `sync_buf_${WECHAT_ACCOUNT}.txt`);
  try {
    if (fs.existsSync(syncBufFile)) {
      getUpdatesBuf = fs.readFileSync(syncBufFile, "utf-8");
      log(`恢复上次同步状态 (${getUpdatesBuf.length} bytes)`);
    }
  } catch {
    // ignore
  }

  log("开始监听微信消息...");

  while (true) {
    try {
      const resp = await getUpdates(baseUrl, token, getUpdatesBuf);

      // Handle API errors
      const isError =
        (resp.ret !== undefined && resp.ret !== 0) ||
        (resp.errcode !== undefined && resp.errcode !== 0);
      if (isError) {
        consecutiveFailures++;
        logError(
          `getUpdates 失败: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""}`,
        );
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          logError(
            `连续失败 ${MAX_CONSECUTIVE_FAILURES} 次，等待 ${BACKOFF_DELAY_MS / 1000}s`,
          );
          consecutiveFailures = 0;
          await new Promise((r) => setTimeout(r, BACKOFF_DELAY_MS));
        } else {
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        }
        continue;
      }

      consecutiveFailures = 0;

      // Save sync buf
      if (resp.get_updates_buf) {
        getUpdatesBuf = resp.get_updates_buf;
        try {
          fs.writeFileSync(syncBufFile, getUpdatesBuf, "utf-8");
        } catch {
          // ignore
        }
      }

      // Process messages
      for (const msg of resp.msgs ?? []) {
        // Only process user messages (not bot messages)
        if (msg.message_type !== MSG_TYPE_USER) continue;

        const senderId = msg.from_user_id ?? "unknown";

        // Cache context token for reply
        if (msg.context_token) {
          cacheContextToken(senderId, msg.context_token);
        }

        // Download images if present
        const imagePaths: string[] = [];
        for (const item of msg.item_list ?? []) {
          if (item.type === MSG_ITEM_IMAGE && item.image_item) {
            const localPath = await downloadAndDecryptImage(item.image_item);
            if (localPath) imagePaths.push(localPath);
          }
        }

        // Build message content
        let content = "";
        const { text } = extractContentFromMessage(msg);

        if (imagePaths.length > 0 && text) {
          content = `${text}\n${imagePaths.map(p => `[用户发送了图片，已保存到: ${p}]`).join("\n")}`;
        } else if (imagePaths.length > 0) {
          content = imagePaths.map(p => `[用户发送了图片，已保存到: ${p}]`).join("\n");
        } else if (text) {
          content = text;
        } else {
          continue;
        }

        log(`收到消息: from=${senderId} text=${content.slice(0, 80)}...`);

        // Push to Claude Code session
        await mcp.notification({
          method: "notifications/claude/channel",
          params: {
            content,
            meta: {
              sender: senderId.split("@")[0] || senderId,
              sender_id: senderId,
            },
          },
        });
      }
    } catch (err) {
      consecutiveFailures++;
      logError(`轮询异常: ${String(err)}`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        consecutiveFailures = 0;
        await new Promise((r) => setTimeout(r, BACKOFF_DELAY_MS));
      } else {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // Connect MCP transport first (Claude Code expects stdio handshake)
  await mcp.connect(new StdioServerTransport());
  log("MCP 连接就绪");

  // Check for saved credentials
  let account = loadCredentials();

  if (!account) {
    log("未找到已保存的凭据，启动微信扫码登录...");
    account = await doQRLogin(DEFAULT_BASE_URL);
    if (!account) {
      logError("登录失败，退出。");
      process.exit(1);
    }
  } else {
    log(`使用已保存账号 [${WECHAT_ACCOUNT}]: ${account.accountId} (${CREDENTIALS_FILE})`);
  }

  activeAccount = account;

  // Start long-poll (runs forever)
  await startPolling(account);
}

main().catch((err) => {
  logError(`Fatal: ${String(err)}`);
  process.exit(1);
});
