/**
 * lifecycle.js — 生命周期控制器
 *
 * 职责：
 *   管理"惰性销毁"定时器。每次收到请求就 resetHeartbeat()（续命）；
 *   超时未活动则触发浏览器优雅关闭，释放系统资源。
 *
 * 关键设计：
 *   - _idleTimer.unref()：定时器不阻止 Node 进程退出，
 *     否则 SIGINT 时进程会因为未执行完的定时器而挂住。
 */
import { terminateBrowser } from './engine.js';

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 分钟

let _idleTimer = null;
let _ttlMs = DEFAULT_TTL_MS;
let _lastHeartbeat = 0;

/**
 * 设置 TTL（可通过环境变量覆盖）
 * @param {number} ms
 */
export function setTTL(ms) {
  _ttlMs = ms > 0 ? ms : DEFAULT_TTL_MS;
}

/**
 * 重置心跳定时器 — 每次 API 调用时执行
 */
export function resetHeartbeat() {
  if (_idleTimer) clearTimeout(_idleTimer);
  _lastHeartbeat = Date.now();

  _idleTimer = setTimeout(async () => {
    console.log(`[lifecycle] 💤 ${(_ttlMs / 60000).toFixed(0)} 分钟未活动，终止浏览器进程`);
    await terminateBrowser();
    _idleTimer = null;
  }, _ttlMs);

  // 极度关键：unref 后定时器不会阻止进程退出
  _idleTimer.unref();
}

/**
 * 取消定时器（用于 Daemon 关闭时清理）
 */
export function cancelHeartbeat() {
  if (_idleTimer) {
    clearTimeout(_idleTimer);
    _idleTimer = null;
  }
}

/**
 * 获取生命周期状态
 */
export function getLifecycleInfo() {
  const now = Date.now();
  const idleSec = _lastHeartbeat > 0 ? Math.round((now - _lastHeartbeat) / 1000) : -1;
  const remainingSec = _lastHeartbeat > 0
    ? Math.max(0, Math.round((_lastHeartbeat + _ttlMs - now) / 1000))
    : -1;

  return {
    ttlMs: _ttlMs,
    lastHeartbeat: _lastHeartbeat > 0 ? new Date(_lastHeartbeat).toISOString() : null,
    idleSeconds: idleSec,
    remainingSeconds: remainingSec,
  };
}
