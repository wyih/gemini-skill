/**
 * demo.js — 使用示例
 *
 * 两种启动方式：
 *
 * 方式 1（推荐）：先手动启动 Chrome，再运行 demo
 *   chrome --remote-debugging-port=9222 --user-data-dir="~/.gemini-skill/chrome-data"
 *   node src/demo.js
 *
 * 方式 2：让 skill 自动启动 Chrome
 *   CHROME_PATH="C:/Program Files/Google/Chrome/Application/chrome.exe" node src/demo.js
 */
import { createGeminiSession, disconnect } from './index.js';

async function main() {
  console.log('=== Gemini Skill Demo ===\n');

  // 创建会话（自动 connect 或 launch）
  const { ops } = await createGeminiSession({
    executablePath: process.env.CHROME_PATH || undefined,
  });

  try {
    // 1. 探测页面状态
    console.log('[1] 探测页面元素...');
    const probe = await ops.probe();
    console.log('probe:', JSON.stringify(probe, null, 2));

    // 2. 发送一句话
    console.log('\n[2] 发送提示词...');
    const result = await ops.sendAndWait('Hello Gemini!', {
      timeout: 60_000,
      onPoll(poll) {
        console.log(`  polling... status=${poll.status}`);
      },
    });
    console.log('result:', JSON.stringify(result, null, 2));

  } catch (err) {
    console.error('Error:', err);
  } finally {
    disconnect();
    console.log('\n[done]');
  }
}

main().catch(console.error);
