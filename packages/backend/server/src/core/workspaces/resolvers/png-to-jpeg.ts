// fork: transparently store fully opaque PNG uploads as JPEG.
//
// Screenshots / exported artwork are usually opaque PNGs that are many times
// larger than an equivalent high quality JPEG. The blob key stays the one the
// client computed (docs reference blobs by key), only the stored bytes and
// therefore the served content type change.
//
// `sharp` is not a dependency of the upstream server; the fork's overlay image
// installs it separately (AFFINE_EXTRA_MODULES). If it cannot be loaded the
// upload is stored unchanged.
import { Logger } from '@nestjs/common';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const logger = new Logger('PngToJpeg');

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

type SharpFactory = (
  input: Buffer,
  options?: Record<string, unknown>
) => {
  metadata(): Promise<{
    hasAlpha?: boolean;
    pages?: number;
    width?: number;
    height?: number;
  }>;
  stats(): Promise<{ isOpaque: boolean }>;
  flatten(options: { background: string }): any;
};

let sharpLoaded = false;
let sharpFactory: SharpFactory | null = null;

function loadSharp(): SharpFactory | null {
  if (sharpLoaded) return sharpFactory;
  sharpLoaded = true;
  const base = process.env.AFFINE_EXTRA_MODULES ?? '/opt/affine-extra';
  try {
    const require = createRequire(join(base, 'package.json'));
    sharpFactory = require('sharp') as SharpFactory;
    logger.log(`PNG→JPEG upload conversion enabled (sharp from ${base})`);
  } catch (error) {
    logger.warn(
      `sharp not available (${base}), PNG uploads are stored unchanged: ${
        error instanceof Error ? error.message : error
      }`
    );
  }
  return sharpFactory;
}

function enabled() {
  const flag = process.env.AFFINE_PNG_TO_JPEG?.toLowerCase();
  return flag !== 'false' && flag !== '0' && flag !== 'off';
}

function quality() {
  const q = Number(process.env.AFFINE_PNG_TO_JPEG_QUALITY);
  return Number.isInteger(q) && q >= 50 && q <= 100 ? q : 90;
}

export function isPng(buffer: Buffer) {
  return (
    buffer.length > PNG_SIGNATURE.length &&
    buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  );
}

/** APNG files carry an `acTL` chunk before the first `IDAT`. */
export function isAnimatedPng(buffer: Buffer) {
  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    if (type === 'acTL') return true;
    if (type === 'IDAT' || type === 'IEND') return false;
    offset += 12 + length;
  }
  return false;
}

export type PngConversionResult = {
  buffer: Buffer;
  converted: boolean;
  reason: string;
};

/**
 * Convert a PNG without any transparent pixel to JPEG. Returns the original
 * buffer when it is not a PNG, is animated, has transparency, conversion fails
 * or the JPEG would not be meaningfully smaller.
 */
export async function convertOpaquePngToJpeg(
  buffer: Buffer
): Promise<PngConversionResult> {
  const keep = (reason: string) => ({ buffer, converted: false, reason });

  if (!enabled()) return keep('disabled');
  if (!isPng(buffer)) return keep('not png');
  if (isAnimatedPng(buffer)) return keep('animated png');

  const sharp = loadSharp();
  if (!sharp) return keep('sharp unavailable');

  try {
    const options = { limitInputPixels: 100_000_000 };
    const image = sharp(buffer, options);
    const meta = await image.metadata();
    if ((meta.pages ?? 1) > 1) return keep('multi-page');
    if (meta.hasAlpha) {
      const stats = await sharp(buffer, options).stats();
      if (!stats.isOpaque) return keep('has transparency');
    }

    const jpeg: Buffer = await sharp(buffer, options)
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: quality(), mozjpeg: true, chromaSubsampling: '4:4:4' })
      .withMetadata()
      .toBuffer();

    if (jpeg.length >= buffer.length * 0.9) {
      return keep('jpeg not smaller');
    }
    logger.log(
      `stored opaque PNG as JPEG ${meta.width}x${meta.height}: ${buffer.length} -> ${jpeg.length} bytes`
    );
    return { buffer: jpeg, converted: true, reason: 'converted' };
  } catch (error) {
    logger.warn(
      `PNG→JPEG conversion failed, storing original: ${
        error instanceof Error ? error.message : error
      }`
    );
    return keep('error');
  }
}
