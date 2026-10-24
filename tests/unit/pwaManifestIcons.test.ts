import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const PUBLIC_DIR = join(__dirname, '../../public');
const PNG_SIGNATURE = '89504e470d0a1a0a';
const PNG_IHDR_WIDTH_OFFSET = 16;
const PNG_IHDR_HEIGHT_OFFSET = 20;

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
}

function readPngSize(file: Buffer): string {
  expect(file.subarray(0, 8).toString('hex')).toBe(PNG_SIGNATURE);
  return `${file.readUInt32BE(PNG_IHDR_WIDTH_OFFSET)}x${file.readUInt32BE(PNG_IHDR_HEIGHT_OFFSET)}`;
}

describe('PWA manifest 圖示', () => {
  const manifest = JSON.parse(readFileSync(join(PUBLIC_DIR, 'manifest.webmanifest'), 'utf8')) as {
    icons: ManifestIcon[];
  };

  it('Given_manifest 列出的圖示_When_讀取 public 下的檔案_Then_每個檔案都存在且尺寸與宣告相同', () => {
    expect(manifest.icons.length).toBeGreaterThan(0);

    for (const icon of manifest.icons) {
      expect(icon.type).toBe('image/png');
      const file = readFileSync(join(PUBLIC_DIR, icon.src));
      expect(readPngSize(file), icon.src).toBe(icon.sizes);
    }
  });
});
