/**
 * server.js — Browser Daemon 入口
 *
 * 一个极简的 HTTP 微服务，管理浏览器进程的生命周期。
 *
 * 启动方式：
 *   node src/daemon/server.js
 *   DAEMON_PORT=40225 node src/daemon/server.js
 *
 * API 端点：
 *   GET  /browser/acquire  — 确保浏览器可用，返回 wsEndpoint（续命）
 *   GET  /browser/status   — 查询浏览器状态（不续命）
 *   POST /browser/release  — 主动销毁浏览器
 *   GET  /health           — Daemon 健康检查
 */
import { createServer } from 'node:http';
import { handleAcquire, handleStatus, handleRelease, handleHealth } from './handlers.js';
import { setTTL, cancelHeartbeat } from './lifecycle.js';
import { terminateBrowser } from './engine.js';

// ── 配置 ──
const PORT = parseInt(process.env.DAEMON_PORT || '40225', 10);
const TTL_MS = parseInt(process.env.DAEMON_TTL_MS || String(30 * 60 * 1000), 10);

setTTL(TTL_MS);

// ── 路由表 ──
const routes = {
  'GET /browser/acquire': handleAcquire,
  'GET /browser/status': handleStatus,
  'POST /browser/release': handleRelease,
  'GET /health': handleHealth,
};

// ── HTTP 服务器 ──
const server = createServer((req, res) => {
  const { method, url } = req;
  // 去掉 query string
  const path = (url || '/').split('?')[0];
  const routeKey = `${method} ${path}`;

  const handler = routes[routeKey];
  if (handler) {
    handler(req, res);
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not_found', path }));
  }
});

server.listen(PORT, () => {
  console.log(`[daemon] 🚀 Browser Daemon 已启动 — http://127.0.0.1:${PORT}`);
  console.log(`[daemon] ⏱  闲置 TTL: ${(TTL_MS / 60000).toFixed(0)} 分钟`);
  console.log(`[daemon]    GET  /browser/acquire  — 获取/启动浏览器`);
  console.log(`[daemon]    GET  /browser/status   — 查询浏览器状态`);
  console.log(`[daemon]    POST /browser/release  — 销毁浏览器`);
  console.log(`[daemon]    GET  /health           — 健康检查`);
});

// ── 优雅退出：系统信号拦截 ──
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

SIGNALS.forEach(sig => {
  process.on(sig, async () => {
    console.log(`\n[daemon] 🛑 收到 ${sig}，开始优雅退出...`);

    // 1. 停止接收新请求
    server.close();

    // 2. 取消闲置定时器
    cancelHeartbeat();

    // 3. 终止浏览器
    await terminateBrowser();

    console.log('[daemon] ✅ 清理完毕，进程退出');
    process.exit(0);
  });
});

// ── 未捕获异常兜底 ──
process.on('uncaughtException', (err) => {
  console.error('[daemon] ❌ 未捕获异常:', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('[daemon] ❌ 未处理的 Promise 拒绝:', reason);
});
