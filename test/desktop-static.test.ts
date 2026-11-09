import 'reflect-metadata';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { registerStaticRoutes } from '../desktop/src/static';

let app: ReturnType<typeof Fastify>;
let root: string;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-desktop-static-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<h1>SPA</h1>');
  fs.mkdirSync(path.join(root, 'assets'));
  fs.writeFileSync(path.join(root, 'assets', 'app.js'), 'console.log(1)');
  fs.writeFileSync(path.join(root, 'setup.html'), '<h1>SETUP</h1>');

  app = Fastify();
  registerStaticRoutes(app, { webDir: root, setupHtml: path.join(root, 'setup.html') });
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('桌面端 · 同源静态路由', () => {
  it('根路径返回 SPA 入口', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<h1>SPA</h1>');
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('带哈希的静态资源按正确 MIME 返回', async () => {
    const res = await app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('console.log(1)');
    expect(res.headers['content-type']).toContain('javascript');
  });

  it('SPA 深链回落到 index.html', async () => {
    const res = await app.inject({ method: 'GET', url: '/some/deep/route' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<h1>SPA</h1>');
  });

  it('未匹配的 /api/* 返回 JSON 404，而不是吞成 HTML', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/not-exist' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('Not Found');
    expect(res.headers['content-type']).toContain('application/json');
  });

  it('首次运行向导由同一端口提供，保证同源可写 cookie', async () => {
    const res = await app.inject({ method: 'GET', url: '/__desktop/setup' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<h1>SETUP</h1>');
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
