// 多模态 content 处理：把客户端发来的 OpenAI 风格 content（string 或 parts 数组）
// 归一化成上游可接受的形态，**绝不丢弃任何一个 part**。
//
// 设计原则：
// - 纯文本保持 string（不包装成数组），纯聊天上游兼容性最好；
// - 数组保序透传：text / image_url / input_image / file / input_audio 原样保留，只做形态归一；
// - 不认识的部分一律 fail-open（原样透传）+ 计数 + warn，杜绝"静默丢弃"；
// - 日志只允许出现 MIME、字节数、http(s) 的 host，data URL 一律不打印内容。
import { logger as defaultLogger } from './logger.mjs';

/** 识别出来的媒体 part 类型 → 计数字段 */
export const MEDIA_KINDS = Object.freeze({
  image_url: 'images',
  input_image: 'images',
  file: 'files',
  input_audio: 'audios',
});

/** placeholder 模式下的占位文本 */
export function placeholderText(part) {
  const type = String(part?.type ?? '');
  if (type === 'image_url' || type === 'input_image') return '[图片]';
  if (type === 'file') {
    const name = part?.file?.filename ?? part?.filename ?? '';
    return name ? `[文件: ${name}]` : '[文件]';
  }
  if (type === 'input_audio') return '[音频]';
  return `[${type || '媒体'}]`;
}

const DATA_URL_RE = /^data:([^;,]*)((?:;[^,]*)*),/i;

/** 解析 data URL 的 MIME 与 payload 字节数（不返回内容本身） */
function describeDataUrl(url) {
  const m = DATA_URL_RE.exec(url);
  if (!m) return { kind: 'data', mime: '', bytes: url.length };
  const mime = m[1] || 'application/octet-stream';
  const base64 = /;base64/i.test(m[2] ?? '');
  const payload = url.slice(m[0].length);
  const bytes = base64 ? Math.floor((payload.length * 3) / 4) : Buffer.byteLength(payload, 'utf8');
  return { kind: 'data', mime, bytes };
}

/** 从 part 里取出"媒体本体"字符串（data URL / http URL / file id），不透明处理 */
export function mediaPayload(part) {
  if (!part || typeof part !== 'object') return '';
  const t = String(part.type ?? '');
  if (t === 'image_url') {
    if (typeof part.image_url === 'string') return part.image_url;
    if (part.image_url && typeof part.image_url.url === 'string') return part.image_url.url;
    return '';
  }
  if (t === 'input_image') {
    if (typeof part.image_url === 'string') return part.image_url;
    if (part.image_url && typeof part.image_url.url === 'string') return part.image_url.url;
    if (typeof part.image_data === 'string') return part.image_data;
    if (typeof part.data === 'string') return part.data;
    return '';
  }
  if (t === 'file') {
    if (typeof part.file?.file_data === 'string') return part.file.file_data;
    if (typeof part.file?.file_id === 'string') return `file_id:${part.file.file_id}`;
    if (typeof part.file_id === 'string') return `file_id:${part.file_id}`;
    return '';
  }
  if (t === 'input_audio') {
    if (typeof part.input_audio?.data === 'string') return part.input_audio.data;
    if (typeof part.data === 'string') return part.data;
    return '';
  }
  return '';
}

/**
 * 给日志/自检用的安全描述：只有 type / mime / 字节数 / host。
 * data URL 永远只输出 `<inline data URL, N bytes>`。
 */
export function describeMediaPart(part) {
  const type = String(part?.type ?? '');
  const kind = MEDIA_KINDS[type] ?? 'unknown';
  const payload = mediaPayload(part);
  let urlKind = 'none';
  let mime = '';
  let bytes = 0;
  let host = '';
  if (payload.startsWith('file_id:')) {
    urlKind = 'file_id';
  } else if (/^data:/i.test(payload)) {
    const info = describeDataUrl(payload);
    urlKind = 'data';
    mime = info.mime;
    bytes = info.bytes;
  } else if (/^https?:\/\//i.test(payload)) {
    urlKind = 'http';
    bytes = Buffer.byteLength(payload, 'utf8');
    try {
      host = new URL(payload).host;
    } catch {
      host = '';
    }
  } else if (payload) {
    urlKind = 'other';
    bytes = Buffer.byteLength(payload, 'utf8');
  }
  return { type, kind, mime, bytes, urlKind, host };
}

/** 日志安全的文本描述（绝不包含 payload 内容） */
export function mediaLogLabel(part) {
  const d = describeMediaPart(part);
  if (d.urlKind === 'data') return `<inline data URL, ${d.bytes} bytes>` + (d.mime ? ` ${d.mime}` : '');
  if (d.urlKind === 'http') return `${d.host || 'http'}`;
  if (d.urlKind === 'file_id') return 'file_id';
  return 'empty';
}

/**
 * 归一化一个 part。
 * @returns {object|string} 永远返回一个可放回数组的值（不返回 undefined，避免误删）
 */
function normalizePart(part, { imageMode, logger, seenUnknown }) {
  if (typeof part === 'string') return part; // 非标准但无歧义：原样保留
  if (!part || typeof part !== 'object' || Array.isArray(part)) {
    if (!seenUnknown.has(typeof part)) {
      seenUnknown.add(typeof part);
      logger?.warn?.('unrecognized content part forwarded as-is', { kind: typeof part });
    }
    return part;
  }

  const type = String(part.type ?? '');

  if (type === 'text') return part;

  if (type === 'image_url') {
    const raw = part.image_url;
    if (typeof raw === 'string') return { ...part, image_url: { url: raw } };
    if (raw && typeof raw === 'object' && typeof raw.url === 'string') return part;
    logger?.warn?.('image_url part without usable url, forwarded as-is', {});
    return part;
  }

  if (type === 'input_image' || type === 'file' || type === 'input_audio') {
    return part; // 上游变体：原样保留（image_url / image_data / file_data / data 都不动）
  }

  // 未识别类型：fail-open + 只告警 type 名
  if (!seenUnknown.has(type)) {
    seenUnknown.add(type);
    logger?.warn?.('unknown content part type, forwarded as-is', { type });
  }
  return part;
}

/**
 * 归一化 message.content。
 * - string / null / 普通对象 → 原样返回（不包装成数组）
 * - 数组 → 逐 part 保序处理，不丢、不重排、不合并
 * @param {string|Array|object|null|undefined} content
 * @param {{imageMode?:'pass'|'placeholder'|'reject', logger?:object}} [options]
 */
export function normalizeContent(content, options = {}) {
  const imageMode = options.imageMode ?? 'pass';
  const logger = options.logger === undefined ? defaultLogger : options.logger;
  if (content === null || content === undefined) return content ?? null;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content;

  const seenUnknown = new Set();
  const out = [];
  for (const part of content) {
    const normalized = normalizePart(part, { imageMode, logger, seenUnknown });
    const kind = normalized && typeof normalized === 'object' ? MEDIA_KINDS[String(normalized.type ?? '')] : null;
    if (kind && imageMode === 'placeholder') {
      out.push({ type: 'text', text: placeholderText(normalized) });
      continue;
    }
    out.push(normalized);
  }
  return out;
}

/**
 * 统计媒体数量。用于日志、响应头与 /admin 自检。
 * @returns {{images:number, files:number, audios:number, unknownParts:number}}
 */
export function countMedia(content) {
  const counts = { images: 0, files: 0, audios: 0, unknownParts: 0 };
  if (!Array.isArray(content)) return counts;
  for (const part of content) {
    if (typeof part === 'string') continue;
    if (!part || typeof part !== 'object') {
      counts.unknownParts += 1;
      continue;
    }
    const type = String(part.type ?? '');
    const kind = MEDIA_KINDS[type];
    if (kind) {
      counts[kind] += 1;
      continue;
    }
    if (type !== 'text') counts.unknownParts += 1;
  }
  return counts;
}

/** 整个请求是否含媒体 */
export function hasMedia(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (const m of messages) {
    const c = countMedia(m?.content);
    if (c.images || c.files || c.audios) return true;
  }
  return false;
}

/** 汇总整个请求的媒体统计 */
export function countMediaInBody(body) {
  const total = { images: 0, files: 0, audios: 0, unknownParts: 0 };
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (const m of messages) {
    const c = countMedia(m?.content);
    total.images += c.images;
    total.files += c.files;
    total.audios += c.audios;
    total.unknownParts += c.unknownParts;
  }
  return total;
}

/** 体积统计：总量 + 单 part 最大值（用于 OOM 防护） */
export function mediaSizeStats(body, { maxParts = 500 } = {}) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  let totalBytes = 0;
  let maxPartBytes = 0;
  let maxPart = null;
  let scanned = 0;
  for (const m of messages) {
    if (!Array.isArray(m?.content)) continue;
    for (const part of m.content) {
      if (scanned++ > maxParts) return { totalBytes, maxPartBytes, maxPart };
      const d = describeMediaPart(part);
      if (!d.bytes) continue;
      totalBytes += d.bytes;
      if (d.bytes > maxPartBytes) {
        maxPartBytes = d.bytes;
        maxPart = d;
      }
    }
  }
  return { totalBytes, maxPartBytes, maxPart };
}

/**
 * 安全地把请求里所有媒体列成"可打印"的描述（不含内容）。
 * @returns {Array<{type:string,kind:string,mime:string,bytes:number,urlKind:string,host:string}>}
 */
export function listMedia(body, { limit = 20 } = {}) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const out = [];
  for (const m of messages) {
    if (!Array.isArray(m?.content)) continue;
    for (const part of m.content) {
      const d = describeMediaPart(part);
      if (d.kind === 'unknown' && !d.bytes) continue;
      out.push(d);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** 只取文本部分；与旧实现语义一致（供 placeholder 与文本抽取使用） */
export function contentToText(content) {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts = [];
    for (const part of content) {
      if (typeof part === 'string') {
        if (part) texts.push(part);
        continue;
      }
      if (!part || typeof part !== 'object') continue;
      if (typeof part.text === 'string' && part.text) texts.push(part.text);
      else if (typeof part.content === 'string' && part.content) texts.push(part.content);
    }
    return texts.join('\n');
  }
  if (typeof content === 'object') return content.text ?? JSON.stringify(content);
  return String(content);
}
