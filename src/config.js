/**
 * config.js — 统一配置中心
 *
 * 所有可配置项集中在这里，从环境变量读取，提供合理默认值。
 * 其他模块一律从 config 取值，不自己硬编码。
 *
 * 环境变量来源（优先级从高到低）：
 *   1. 进程环境变量（process.env）
 *   2. .env 文件（需调用方自行加载，如 dotenv）
 *   3. 代码默认值
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const env = process.env;

/** 辅助：读取布尔型环境变量 */
function envBool(key, fallback) {
  const val = env[key];
  if (val === undefined || val === '') return fallback;
  return val === 'true' || val === '1';
}

/** 辅助：读取数字型环境变量 */
function envInt(key, fallback) {
  const val = env[key];
  if (val === undefined || val === '') return fallback;
  const n = parseInt(val, 10);
  return Number.isNaN(n) ? fallback : n;
}

/** 辅助：读取字符串环境变量 */
function envStr(key, fallback) {
  const val = env[key];
  return (val !== undefined && val !== '') ? val : fallback;
}

// ── 导出配置 ──

const config = {
  /** Chrome / Chromium 可执行文件路径（不设则需手动启动 Chrome） */
  chromePath: envStr('CHROME_PATH', undefined),

  /** CDP 远程调试端口 */
  chromeDebugPort: envInt('CHROME_DEBUG_PORT', 9222),

  /** Chrome 用户数据目录 */
  chromeUserDataDir: envStr(
    'CHROME_USER_DATA_DIR',
    join(homedir(), '.gemini-skill', 'chrome-data'),
  ),

  /** 是否无头模式 */
  chromeHeadless: envBool('CHROME_HEADLESS', false),

  /** CDP 协议超时时间（ms） */
  chromeProtocolTimeout: envInt('CHROME_PROTOCOL_TIMEOUT', 60_000),

  /** 截图 / 图片输出目录 */
  outputDir: envStr('OUTPUT_DIR', resolve('output')),
};

export default config;
