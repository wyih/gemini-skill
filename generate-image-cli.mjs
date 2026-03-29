#!/usr/bin/env node
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeWatermarkFromFile } from './src/watermark-remover.js';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

async function verifyWatermarkFree(filePath, { maxPasses = 2 } = {}) {
  const target = path.resolve(filePath);
  const ext = path.extname(target);
  const base = target.slice(0, target.length - ext.length);

  for (let round = 1; round <= maxPasses; round++) {
    const probePath = `${base}.wm-verify-${round}${ext}`;
    fs.copyFileSync(target, probePath);

    const result = await removeWatermarkFromFile(probePath);
    if (!result?.ok) {
      fs.rmSync(probePath, { force: true });
      return { ok: false, error: result?.error || 'verify_failed', round };
    }

    if (result.skipped) {
      fs.rmSync(probePath, { force: true });
      return { ok: true, verified: true, round: round - 1 };
    }

    fs.renameSync(probePath, target);
  }

  return { ok: false, error: 'watermark_verification_failed', round: maxPasses };
}

function extractText(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  return content
    .filter(item => item?.type === 'text' && typeof item?.text === 'string')
    .map(item => item.text)
    .join('\n')
    .trim();
}

function extractPath(text) {
  if (!text) return null;
  const match = text.match(/已保存至[:：]\s*(.+)$/m);
  return match?.[1]?.trim() || null;
}

function moveFile(source, target) {
  if (!source || !target) return source;
  const from = path.resolve(source);
  const to = path.resolve(target);
  if (from === to) return to;

  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch {
    fs.copyFileSync(from, to);
    fs.rmSync(from, { force: true });
  }
  return to;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillDir = __dirname;
const prompt = arg('--prompt');
const filename = arg('--filename');
const timeoutRaw = arg('--timeout', '240000');
const timeout = Number(timeoutRaw);
const newSession = hasFlag('--new-session');
const allowPreviewFallback = hasFlag('--allow-preview-fallback');

if (!prompt) fail('Error: --prompt is required');
if (!Number.isFinite(timeout) || timeout < 1000) fail('Error: --timeout must be a number >= 1000');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(skillDir, 'src/mcp-server.js')],
  cwd: skillDir,
  stderr: 'pipe',
});
transport.stderr?.on?.('data', (chunk) => process.stderr.write(chunk));

const client = new Client({ name: 'img-gemini-wrapper', version: '0.1.0' });

async function callGenerate(fullSize) {
  const requestTimeout = Math.max(timeout + 120_000, 240_000);
  return client.callTool({
    name: 'gemini_generate_image',
    arguments: {
      prompt,
      newSession,
      fullSize,
      timeout,
    },
  }, undefined, {
    timeout: requestTimeout,
  });
}

try {
  await client.connect(transport);

  let result = await callGenerate(true);
  let text = extractText(result);

  if (result?.isError) {
    console.error(`gemini_generate_image fullSize=true failed: ${text || 'unknown error'}`);
    if (!allowPreviewFallback) {
      fail(text || 'gemini_generate_image fullSize=true failed', 2);
    }
    result = await callGenerate(false);
    text = extractText(result);
  }

  if (result?.isError) {
    fail(text || 'gemini_generate_image failed', 2);
  }

  let filePath = extractPath(text);
  if (!filePath) fail(`gemini_generate_image returned no file path: ${text || 'empty response'}`, 3);

  if (filename) {
    filePath = moveFile(filePath, filename);
  } else {
    filePath = path.resolve(filePath);
  }

  if (!fs.existsSync(filePath)) fail(`output file not found: ${filePath}`, 4);

  const verify = await verifyWatermarkFree(filePath);
  if (!verify.ok) {
    fail(`watermark verification failed: ${verify.error}`, 6);
  }

  console.log(`MEDIA: ${filePath}`);
} catch (err) {
  fail(err?.message || String(err), 5);
} finally {
  try { await client.close(); } catch {}
}
