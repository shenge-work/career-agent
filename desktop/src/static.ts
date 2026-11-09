import fs from 'node:fs';
import path from 'node:path';

/**
 * 同一个回环端口上同时提供 API 与编译后的 React SPA。
 * 必须与 API 同源：会话 cookie、回环 Origin 守卫、相对路径 /api 都依赖于此。
 *
 * 这里不用 @fastify/static：安装包里多一个插件依赖就多一处路径/版本风险，
 * 且需求只有「读文件 + SPA fallback」两件事。
 */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

export function mimeFor(file: string): string {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/**
 * 把 URL 路径解析成 webDir 下的真实文件路径。
 * 返回 null = 越界/非法（路径穿越、%00、坏编码），调用方一律 403。
 */
export function resolveStaticFile(webDir: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(String(urlPath || '/').split('?')[0]);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;

  // Windows 上把反斜杠也当分隔符，避免 "..\\..\\secret" 绕过检查。
  const normalized = decoded.replace(/\\/g, '/');
  const rel = normalized.replace(/^\/+/, '');
  const root = path.resolve(webDir);
  const candidate = path.resolve(root, rel || 'index.html');
  if (candidate !== root && !candidate.startsWith(root + path.sep)) return null;
  return candidate;
}

export interface StaticRouteOptions {
  webDir: string;
  setupHtml: string;
}

/**
 * 在 Nest 的 Fastify 实例上注册通配 GET。
 * find-my-way 中具体路由（/api/...）优先于 /*，所以 API 不会被静态托管抢走；
 * 未匹配到的 /api/* 由这里返回 JSON 404，而不是 SPA 的 index.html。
 */
export function registerStaticRoutes(fastify: any, opts: StaticRouteOptions): void {
  const handler = async (req: any, reply: any): Promise<any> => {
    const rawUrl = String(req?.raw?.url || req?.url || '/');
    const pathname = rawUrl.split('?')[0];

    if (pathname === '/api' || pathname.startsWith('/api/')) {
      return reply.code(404).send({
        statusCode: 404,
        message: `Cannot ${String(req?.method || 'GET')} ${pathname}`,
        error: 'Not Found',
      });
    }

    if (pathname === '/__desktop/setup') {
      try {
        const html = fs.readFileSync(opts.setupHtml, 'utf8');
        return reply
          .code(200)
          .header('Content-Type', 'text/html; charset=utf-8')
          .header('Cache-Control', 'no-store')
          .send(html);
      } catch {
        return reply.code(500).send('首次运行向导页面缺失');
      }
    }

    const resolved = resolveStaticFile(opts.webDir, pathname);
    if (!resolved) return reply.code(403).send('Forbidden');

    let file = resolved;
    try {
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        file = path.join(path.resolve(opts.webDir), 'index.html');
      }
    } catch {
      file = path.join(path.resolve(opts.webDir), 'index.html');
    }
    if (!fs.existsSync(file)) return reply.code(404).send('前端资源缺失，请重新构建（npm run build）');

    return reply
      .header('Content-Type', mimeFor(file))
      .header('Cache-Control', 'no-cache')
      .send(fs.createReadStream(file));
  };

  fastify.get('/', handler);
  fastify.get('/*', handler);
}
