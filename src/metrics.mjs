// 运行时可观测：内存环形缓冲，只存"请求形状"，绝不存提示词/图片/密钥。
//
// 目的：/admin 的概览与最近请求列表需要真实数据，而网关本身是无状态的
// —— 所以这里只是"进程内计数器 + 最近 N 条请求摘要"，重启即清零，不落盘。
import { countMediaInBody } from './content.mjs';

const DEFAULT_CAPACITY = 100;

/** 把毫秒数换算成人类可读时长 */
export function formatDuration(ms) {
  const n = Math.max(0, Number(ms) || 0);
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(1)}s`;
  const m = Math.floor(n / 60_000);
  const s = Math.round((n % 60_000) / 1000);
  if (m < 60) return `${m}m${s ? `${s}s` : ''}`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? `${m % 60}m` : ''}`;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/**
 * @param {{capacity?:number, now?:() => number}} [options]
 */
export function createMetrics({ capacity = DEFAULT_CAPACITY, now = () => Date.now() } = {}) {
  const recent = [];
  const startedAt = now();
  const totals = {
    requests: 0,
    ok: 0, // 2xx
    clientErrors: 0, // 4xx
    serverErrors: 0, // 5xx
    simulated: 0,
    toolCalls: 0,
    toolHit: 0,
    images: 0,
    files: 0,
    audios: 0,
    unknownParts: 0,
    bytesIn: 0,
  };
  const byType = new Map();

  return {
    startedAt,
    /** 记一条请求摘要（只放可公开的字段） */
    record(entry = {}) {
      const ts = entry.ts ?? now();
      const row = {
        ts,
        method: entry.method ?? 'POST',
        path: entry.path ?? '',
        status: Number(entry.status) || 0,
        ms: Math.max(0, Math.round(Number(entry.ms) || 0)),
        model: entry.model ? String(entry.model) : '',
        stream: entry.stream === true,
        simulated: entry.simulated === true,
        toolCalls: Number(entry.toolCalls) || 0,
        finish: entry.finish ? String(entry.finish) : '',
        images: Number(entry.images) || 0,
        files: Number(entry.files) || 0,
        audios: Number(entry.audios) || 0,
        unknownParts: Number(entry.unknownParts) || 0,
        errorType: entry.errorType ? String(entry.errorType) : '',
      };
      recent.push(row);
      while (recent.length > capacity) recent.shift();

      totals.requests += 1;
      if (row.status >= 200 && row.status < 300) totals.ok += 1;
      else if (row.status >= 400 && row.status < 500) totals.clientErrors += 1;
      else if (row.status >= 500) totals.serverErrors += 1;
      if (row.simulated) totals.simulated += 1;
      totals.toolCalls += row.toolCalls;
      if (row.toolCalls > 0) totals.toolHit += 1;
      totals.images += row.images;
      totals.files += row.files;
      totals.audios += row.audios;
      totals.unknownParts += row.unknownParts;
      if (row.errorType) byType.set(row.errorType, (byType.get(row.errorType) ?? 0) + 1);
      return row;
    },
    /** 聚合视图（给 /admin 概览） */
    summary() {
      const latencies = recent.map((r) => r.ms).sort((a, b) => a - b);
      const errorRate = totals.requests ? (totals.clientErrors + totals.serverErrors) / totals.requests : 0;
      const toolHitRate = totals.simulated ? totals.toolHit / totals.simulated : 0;
      return {
        startedAt,
        uptimeMs: now() - startedAt,
        uptime: formatDuration(now() - startedAt),
        ...totals,
        errorRate: Number(errorRate.toFixed(4)),
        toolHitRate: Number(toolHitRate.toFixed(4)),
        p50Ms: percentile(latencies, 50),
        p95Ms: percentile(latencies, 95),
        errorsByType: Object.fromEntries([...byType.entries()].sort((a, b) => b[1] - a[1])),
        window: recent.length,
        capacity,
      };
    },
    /** 最近 N 条（新的在前） */
    list({ limit = 20 } = {}) {
      const n = Math.max(1, Math.min(capacity, Number(limit) || 20));
      return recent.slice(-n).reverse();
    },
    reset() {
      recent.length = 0;
      for (const key of Object.keys(totals)) totals[key] = 0;
      byType.clear();
      return this.summary();
    },
  };
}

/** 从请求体里提取媒体计数（供 server 记录用，避免重复解析逻辑） */
export function mediaCountsOf(body) {
  return countMediaInBody(body);
}
