/**
 * watermark-remover.js — Gemini 图片水印移除
 *
 * 这一版保留原来的反向 Alpha 混合核心，
 * 但把水印定位升级成“候选搜索 + 验证后再动手”。
 *
 * 算法来源：
 * - reverse alpha blending 改编自 journey-ad / Jad 的 gemini-watermark-remover
 * - 候选搜索、验证、官方尺寸目录改编自 GargantuaX 的 gemini-watermark-remover
 */
import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { interpolateAlphaMap } from './watermark-vendor/core/adaptiveDetector.js';
import { processWatermarkImageData } from './watermark-vendor/core/watermarkProcessor.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_ALPHA_SIZES = new Set([48, 96]);
const alphaMapCache = new Map();

async function calculateAlphaMap(pngBuffer, size) {
  const { data, info } = await sharp(pngBuffer)
    .resize(size, size)
    .raw()
    .ensureAlpha()
    .toBuffer({ resolveWithObject: true });

  const pixelCount = info.width * info.height;
  const alphaMap = new Float32Array(pixelCount);
  const channels = info.channels;

  for (let i = 0; i < pixelCount; i++) {
    const idx = i * channels;
    const r = data[idx];
    const g = data[idx + 1];
    const b = data[idx + 2];
    alphaMap[i] = Math.max(r, g, b) / 255.0;
  }

  return alphaMap;
}

async function loadBaseAlphaMap(size) {
  if (!BASE_ALPHA_SIZES.has(size)) {
    throw new Error(`unsupported_base_alpha_size:${size}`);
  }
  if (alphaMapCache.has(size)) {
    return alphaMapCache.get(size);
  }

  const bgFile = size === 48 ? 'bg_48.png' : 'bg_96.png';
  const bgPath = join(__dirname, 'assets', bgFile);
  const alphaMap = await calculateAlphaMap(readFileSync(bgPath), size);
  alphaMapCache.set(size, alphaMap);
  return alphaMap;
}

async function prepareAlphaMaps() {
  const alpha48 = await loadBaseAlphaMap(48);
  const alpha96 = await loadBaseAlphaMap(96);

  const getAlphaMap = (size) => {
    if (!Number.isFinite(size) || size <= 0) return null;
    const normalized = Math.round(size);
    if (alphaMapCache.has(normalized)) {
      return alphaMapCache.get(normalized);
    }
    const interpolated = interpolateAlphaMap(alpha96, 96, normalized);
    alphaMapCache.set(normalized, interpolated);
    return interpolated;
  };

  return { alpha48, alpha96, getAlphaMap };
}

function normalizeExtFromFilePath(filePath) {
  const ext = String(filePath.match(/\.(\w+)$/)?.[1] || 'png').toLowerCase();
  if (ext === 'jpg') return 'jpeg';
  return ext;
}

function normalizeExtFromMime(mime) {
  const ext = String(mime || '').split('/')[1] || 'png';
  if (ext === 'jpg') return 'jpeg';
  return ext.toLowerCase();
}

async function decodeToImageData(input) {
  const { data, info } = await sharp(input)
    .raw()
    .ensureAlpha()
    .toBuffer({ resolveWithObject: true });

  return {
    imageData: {
      width: info.width,
      height: info.height,
      data: new Uint8ClampedArray(data),
    },
    info,
  };
}

async function encodeImageData(imageData, ext) {
  let pipeline = sharp(Buffer.from(imageData.data), {
    raw: {
      width: imageData.width,
      height: imageData.height,
      channels: 4,
    },
  });

  switch (ext) {
    case 'jpeg':
      pipeline = pipeline.jpeg({ quality: 95 });
      break;
    case 'webp':
      pipeline = pipeline.webp({ quality: 95 });
      break;
    default:
      pipeline = pipeline.png();
      break;
  }

  return pipeline.toBuffer();
}

async function removeWatermarkFromImageInput(input, { ext }) {
  const { imageData, info } = await decodeToImageData(input);
  if (!info.width || !info.height) {
    return { ok: false, error: 'invalid_image_metadata' };
  }

  const { alpha48, alpha96, getAlphaMap } = await prepareAlphaMaps();
  const result = processWatermarkImageData(imageData, {
    alpha48,
    alpha96,
    getAlphaMap,
    adaptiveMode: 'auto',
    maxPasses: 4,
  });

  const meta = result.meta || null;
  const applied = meta?.applied !== false;

  if (!applied) {
    return {
      ok: true,
      width: info.width,
      height: info.height,
      skipped: true,
      reason: meta?.skipReason || 'no_watermark_detected',
      meta,
    };
  }

  const outputBuffer = await encodeImageData(result.imageData, ext);
  return {
    ok: true,
    width: info.width,
    height: info.height,
    logoSize: meta?.size || null,
    outputBuffer,
    meta,
  };
}

export async function removeWatermarkFromFile(filePath) {
  try {
    console.log(`[watermark-remover] 开始处理: ${filePath}`);
    const ext = normalizeExtFromFilePath(filePath);
    const result = await removeWatermarkFromImageInput(filePath, { ext });

    if (!result.ok) {
      return result;
    }

    if (result.skipped) {
      console.log(`[watermark-remover] 跳过去水印: ${result.width}×${result.height}, reason=${result.reason}`);
      return result;
    }

    await sharp(result.outputBuffer).toFile(filePath);
    console.log(
      `[watermark-remover] ✅ 去水印完成: ${result.width}×${result.height}, logo=${result.logoSize}px, tier=${result.meta?.decisionTier || 'unknown'}`
    );
    return result;
  } catch (err) {
    console.error(`[watermark-remover] ❌ 去水印失败: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

export async function removeWatermarkFromDataUrl(dataUrl) {
  try {
    console.log('[watermark-remover] 开始处理 base64 图片');

    const mimeMatch = dataUrl.match(/^data:(image\/\w+);base64,/);
    if (!mimeMatch) {
      return { ok: false, error: 'invalid_data_url' };
    }

    const mime = mimeMatch[1];
    const ext = normalizeExtFromMime(mime);
    const base64Data = dataUrl.slice(mimeMatch[0].length);
    const inputBuffer = Buffer.from(base64Data, 'base64');
    const result = await removeWatermarkFromImageInput(inputBuffer, { ext });

    if (!result.ok) {
      return result;
    }

    if (result.skipped) {
      console.log(`[watermark-remover] 跳过 base64 去水印: ${result.width}×${result.height}, reason=${result.reason}`);
      return {
        ...result,
        dataUrl,
      };
    }

    const outputBase64 = result.outputBuffer.toString('base64');
    const outputDataUrl = `data:${mime};base64,${outputBase64}`;
    console.log(
      `[watermark-remover] ✅ base64 去水印完成: ${result.width}×${result.height}, logo=${result.logoSize}px, tier=${result.meta?.decisionTier || 'unknown'}`
    );

    return {
      ...result,
      dataUrl: outputDataUrl,
    };
  } catch (err) {
    console.error(`[watermark-remover] ❌ base64 去水印失败: ${err.message}`);
    return { ok: false, error: err.message };
  }
}
