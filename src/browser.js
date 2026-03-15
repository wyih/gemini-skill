/**
 * browser.js — 浏览器生命周期管理（内部模块，不对外暴露）
 *
 * 设计思路：
 *   Skill 内部自己管理 Chrome 进程，对外只暴露 getSession()。
 *   调用方不需要关心 launch/connect/端口/CDP 等细节。
 *
 * 流程：
 *   1. 先检查指定端口是否已有 Chrome 在跑 → 有就 connect
 *   2. 没有 → 启动新 Chrome（需要 executablePath）
 *   3. 找到 / 新开 Gemini 标签页
 *   4. 返回 { browser, page }
 */
import puppeteerCore from 'puppeteer-core';
import { addExtra } from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';

// ── 用 puppeteer-extra 包装 puppeteer-core，注入 stealth 插件 ──
const puppeteer = addExtra(puppeteerCore);
puppeteer.use(StealthPlugin());

// ── 模块级单例：跨调用复用同一个浏览器 ──
let _browser = null;

/** 默认配置 */
const DEFAULTS = {
  port: 9222,
  userDataDir: join(homedir(), '.gemini-skill', 'chrome-data'),
  headless: false,
  protocolTimeout: 60_000,
};

/**
 * 探测指定端口是否有 Chrome 在监听
 * @param {number} port
 * @param {string} [host='127.0.0.1']
 * @param {number} [timeout=1500]
 * @returns {Promise<boolean>}
 */
function isPortAlive(port, host = '127.0.0.1', timeout = 1500) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeout);
    socket.on('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/** Chrome 启动参数 */
const CHROME_ARGS = [
  // ── 基础 ──
  '--no-first-run',
  '--disable-default-apps',
  '--disable-popup-blocking',

  // ── 渲染稳定性（无头 / 无显卡服务器） ──
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',

  // ── 反检测（配合 stealth 插件 + ignoreDefaultArgs） ──
  '--disable-blink-features=AutomationControlled',

  // ── 网络 / 性能 ──
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',

  // ── UI 纯净度 ──
  '--disable-features=Translate',
  '--no-default-browser-check',
  '--disable-crash-reporter',
  '--hide-crash-restore-bubble',
];

/**
 * 连接到已运行的 Chrome
 * @param {number} port
 * @returns {Promise<import('puppeteer-core').Browser>}
 */
async function connectToChrome(port) {
  const browserURL = `http://127.0.0.1:${port}`;
  const browser = await puppeteer.connect({
    browserURL,
    defaultViewport: null,
    protocolTimeout: DEFAULTS.protocolTimeout,
  });
  console.log('[browser] connected to existing Chrome on port', port);
  return browser;
}

/**
 * 启动新的 Chrome 实例
 * @param {object} opts
 * @param {string} opts.executablePath
 * @param {number} opts.port
 * @param {string} opts.userDataDir
 * @param {boolean} opts.headless
 * @returns {Promise<import('puppeteer-core').Browser>}
 */
async function launchChrome({ executablePath, port, userDataDir, headless }) {
  const browser = await puppeteer.launch({
    executablePath,
    headless,
    userDataDir,
    defaultViewport: null,
    args: [
      ...CHROME_ARGS,
      `--remote-debugging-port=${port}`,
    ],
    ignoreDefaultArgs: ['--enable-automation'],
    protocolTimeout: DEFAULTS.protocolTimeout,
  });
  console.log('[browser] launched Chrome, pid:', browser.process()?.pid, 'port:', port, 'dataDir:', userDataDir);
  return browser;
}

/**
 * 在浏览器中找到 Gemini 标签页，或新开一个
 * @param {import('puppeteer-core').Browser} browser
 * @returns {Promise<import('puppeteer-core').Page>}
 */
async function findOrCreateGeminiPage(browser) {
  const pages = await browser.pages();

  // 优先复用已有的 Gemini 标签页
  for (const page of pages) {
    const url = page.url();
    if (url.includes('gemini.google.com')) {
      console.log('[browser] reusing existing Gemini tab:', url);
      await page.bringToFront();
      return page;
    }
  }

  // 没找到，新开一个
  const page = pages.length > 0 ? pages[0] : await browser.newPage();
  await page.goto('https://gemini.google.com/app', {
    waitUntil: 'networkidle2',
    timeout: 30_000,
  });
  console.log('[browser] opened new Gemini tab');
  return page;
}

/**
 * 确保浏览器可用 — Skill 唯一的对外浏览器管理入口
 *
 * 逻辑：
 *   1. 如果已有 _browser 且未断开 → 直接复用
 *   2. 检查端口是否有 Chrome → connect
 *   3. 否则 launch 新 Chrome（需要 executablePath）
 *
 * @param {object} [opts]
 * @param {string} [opts.executablePath] - Chrome 路径（仅 launch 时需要）
 * @param {number} [opts.port=9222] - 调试端口
 * @param {string} [opts.userDataDir] - 用户数据目录
 * @param {boolean} [opts.headless=false]
 * @returns {Promise<{browser: import('puppeteer-core').Browser, page: import('puppeteer-core').Page}>}
 */
export async function ensureBrowser(opts = {}) {
  const {
    executablePath,
    port = DEFAULTS.port,
    userDataDir = DEFAULTS.userDataDir,
    headless = DEFAULTS.headless,
  } = opts;

  // 1. 复用已有连接
  if (_browser && _browser.isConnected()) {
    console.log('[browser] reusing existing connection');
    const page = await findOrCreateGeminiPage(_browser);
    return { browser: _browser, page };
  }

  // 2. 尝试连接已在运行的 Chrome
  const alive = await isPortAlive(port);
  if (alive) {
    try {
      _browser = await connectToChrome(port);
      const page = await findOrCreateGeminiPage(_browser);
      return { browser: _browser, page };
    } catch (err) {
      console.warn('[browser] connect failed, will try launch:', err.message);
    }
  }

  // 3. 启动新 Chrome
  if (!executablePath) {
    throw new Error(
      `[browser] 端口 ${port} 无可用 Chrome，且未提供 executablePath。\n` +
      `请先手动启动 Chrome：chrome --remote-debugging-port=${port} --user-data-dir="${userDataDir}"\n` +
      `或传入 executablePath 让 skill 自动启动。`
    );
  }

  _browser = await launchChrome({ executablePath, port, userDataDir, headless });
  const page = await findOrCreateGeminiPage(_browser);
  return { browser: _browser, page };
}

/**
 * 断开浏览器连接（不杀 Chrome 进程，方便下次复用）
 */
export function disconnect() {
  if (_browser) {
    _browser.disconnect();
    _browser = null;
    console.log('[browser] disconnected');
  }
}

/**
 * 关闭浏览器（杀 Chrome 进程）
 */
export async function close() {
  if (_browser) {
    await _browser.close();
    _browser = null;
    console.log('[browser] closed');
  }
}
