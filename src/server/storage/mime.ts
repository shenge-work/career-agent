/**
 * 文件类型白名单（magic number 判定）。
 *
 * 铁律：mime 只由文件头决定，绝不采信客户端声明的 content-type 或扩展名。
 * inline=false 的类型一律强制 Content-Disposition: attachment + CSP sandbox，
 * 避免用户上传的 SVG / HTML 在同源下变成存储型 XSS。
 */
export interface DetectedMime {
  mime: string;
  inline: boolean;
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function printableText(head: Buffer): boolean {
  if (!head.length) return false;
  for (const b of head) {
    if (b === 0x00) return false;
    if (b < 0x09 || (b > 0x0d && b < 0x20)) return false;
  }
  return true;
}

export function detectMime(head: Buffer): DetectedMime | null {
  if (!head || head.length === 0) return null;

  if (head.length >= 8 && head.subarray(0, 8).equals(PNG)) {
    return { mime: 'image/png', inline: true };
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return { mime: 'image/jpeg', inline: true };
  }
  const ascii6 = head.subarray(0, 6).toString('ascii');
  if (ascii6 === 'GIF87a' || ascii6 === 'GIF89a') {
    return { mime: 'image/gif', inline: true };
  }
  if (
    head.length >= 12 &&
    head.subarray(0, 4).toString('ascii') === 'RIFF' &&
    head.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { mime: 'image/webp', inline: true };
  }
  if (head.length >= 5 && head.subarray(0, 5).toString('ascii') === '%PDF-') {
    return { mime: 'application/pdf', inline: true };
  }
  // docx / xlsx / pptx / zip 都是 PK\x03\x04，统一按压缩包强制下载
  if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) {
    return { mime: 'application/zip', inline: false };
  }
  const text = head.toString('utf8', 0, Math.min(head.length, 512)).trimStart();
  if ((text.startsWith('<svg') || (text.startsWith('<?xml') && text.includes('<svg'))) && text.includes('<svg')) {
    return { mime: 'image/svg+xml', inline: false };
  }
  if (printableText(head)) {
    return { mime: 'text/plain', inline: false };
  }
  return null;
}

/** 只做展示的文件名净化：绝不参与拼路径。 */
export function safeOriginalName(raw: unknown): string {
  const name = String(raw ?? '')
    .replace(/[\\/\r\n\t]/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '_')
    .slice(0, 180)
    .trim();
  return name || 'attachment';
}
