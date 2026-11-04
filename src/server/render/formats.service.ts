/* =============================================================
 * 多格式导出：TXT / Markdown / Word(.doc)
 * -------------------------------------------------------------
 * 直接从结构化 payload.data.sections 生成，而不是解析渲染后的
 * HTML —— 这样内容完整、层级可控、且与「简历渲染引擎」解耦。
 *
 * 富文本约定（与 v1 一致）：
 *   · **文字** 只在个人优势卡 / 技能关键词 / 技能说明里生效；
 *   · 其余字段（履历 summary / 项目 desc / 成果）是纯文本，去掉字面 **。
 * ============================================================= */

const stripMark = (s: unknown): string =>
  String(s == null ? '' : s).replace(/\*\*/g, '');

/** 把 v1 的 **加粗** 转成纯文本 / Markdown / HTML 对应形态。 */
function richText(s: unknown, fmt: 'txt' | 'md' | 'html'): string {
  const str = String(s == null ? '' : s);
  if (fmt === 'txt') return str.replace(/\*\*/g, '');
  if (fmt === 'md') return str; // ** 就是 Markdown 加粗
  // html：**x** -> <strong>x</strong>
  return str.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

type Fmt = 'txt' | 'md' | 'html';

interface Ctx {
  lines: string[];
  fmt: Fmt;
}

function heading(c: Ctx, title: string) {
  const t = stripMark(title);
  if (!t) return;
  if (c.fmt === 'md') c.lines.push('## ' + t);
  else c.lines.push('【' + t + '】');
  c.lines.push('');
}

function bullet(c: Ctx, text: string) {
  const t = stripMark(text);
  if (!t) return;
  if (c.fmt === 'md') c.lines.push('- ' + t);
  else c.lines.push('· ' + t);
}

function para(c: Ctx, text: string) {
  // md 格式保留 ** 加粗（个人优势卡等富文本字段），其余格式剥掉
  const t = c.fmt === 'md' ? String(text ?? '') : stripMark(text);
  if (!t.trim()) return;
  c.lines.push(t);
  c.lines.push('');
}

function contactLine(c: Ctx, text: string) {
  const t = stripMark(text);
  if (!t) return;
  c.lines.push(t);
}

/** 遍历 sections，按 type 分发到各自渲染函数。 */
function renderSections(data: any, c: Ctx) {
  const sections = (data && data.sections) || [];
  for (const sec of sections) {
    switch (sec.type) {
      case 'highlights':
        renderHighlights(sec, c);
        break;
      case 'growth':
        renderGrowth(sec, c);
        break;
      case 'skills':
        renderSkills(sec, c);
        break;
      case 'career':
        renderCareer(sec, c);
        break;
      case 'custom':
        renderCustom(sec, c);
        break;
      case 'projects':
        renderStandaloneProjects(sec, c);
        break;
      default:
        // 未知板块：至少把标题与可读文本倒出来，不静默丢内容
        heading(c, sec.title || sec.id || '');
        if (Array.isArray(sec.items)) {
          for (const it of sec.items) {
            const t = typeof it === 'string' ? it : it && (it.text || it.title || it.name);
            if (t) bullet(c, String(t));
          }
        } else if (typeof sec.text === 'string') {
          para(c, sec.text);
        }
    }
  }
}

function renderHighlights(sec: any, c: Ctx) {
  heading(c, sec.title || '个人优势');
  for (const card of sec.cards || []) {
    para(c, richText(card.text, c.fmt));
  }
}

function renderGrowth(sec: any, c: Ctx) {
  heading(c, sec.title || '技术成长路径');
  for (const p of sec.phases || []) {
    const head = [p.label, p.date, p.title].filter(Boolean).join(' · ');
    if (head) c.lines.push(stripMark(head));
    if (p.desc) para(c, p.desc);
  }
}

function renderSkills(sec: any, c: Ctx) {
  heading(c, sec.title || '专业技能');
  for (const g of sec.groups || []) {
    if (g.name) c.lines.push(stripMark(g.name));
    if (g.keywords) c.lines.push(richText(g.keywords, c.fmt));
    if (g.detail) c.lines.push(richText(g.detail, c.fmt));
    c.lines.push('');
  }
}

function renderCareer(sec: any, c: Ctx) {
  heading(c, sec.title || '职业履历');
  for (const job of sec.items || []) {
    const head = [job.company, job.role, job.date].filter(Boolean).join('  |  ');
    if (head) c.lines.push(stripMark(head));
    if (job.summary) para(c, job.summary);
    for (const prj of job.projects || []) {
      if (prj.name) c.lines.push(c.fmt === 'md' ? '### ' + stripMark(prj.name) : '■ ' + stripMark(prj.name));
      if (prj.desc) para(c, prj.desc);
      for (const r of prj.results || []) {
        bullet(c, r.text || '');
      }
    }
    c.lines.push('');
  }
}

function renderCustom(sec: any, c: Ctx) {
  heading(c, sec.title || '');
  if (typeof sec.text === 'string') para(c, richText(sec.text, c.fmt));
  for (const it of sec.items || []) {
    if (typeof it === 'string') bullet(c, it);
    else if (it && (it.text || it.title)) bullet(c, it.text || it.title);
  }
}

function renderStandaloneProjects(sec: any, c: Ctx) {
  heading(c, sec.title || '项目经历');
  for (const prj of sec.items || []) {
    if (prj.name) c.lines.push(c.fmt === 'md' ? '### ' + stripMark(prj.name) : '■ ' + stripMark(prj.name));
    if (prj.desc) para(c, prj.desc);
    for (const r of prj.results || []) bullet(c, r.text || '');
  }
  c.lines.push('');
}

function buildHeader(data: any, c: Ctx) {
  if (data.name) c.lines.push(data.name);
  if (data.subtitle) c.lines.push(stripMark(data.subtitle));
  if (data.meta) c.lines.push(stripMark(data.meta));
  c.lines.push('');
  const contacts = (data.contact || []).map((x: any) => (typeof x === 'string' ? x : x.text)).filter(Boolean);
  if (contacts.length) {
    c.lines.push(contacts.join('  |  '));
    c.lines.push('');
  }
}

/** 通用结构化转换：data -> {txt, md, html}。 */
export function resumeToFormats(data: any): { txt: string; md: string; html: string } {
  const make = (fmt: Fmt): string => {
    const c: Ctx = { lines: [], fmt };
    buildHeader(data, c);
    renderSections(data, c);
    return c.lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  };

  const txt = make('txt');
  const md = make('md');
  const html = buildWordHtml(data);

  return { txt, md, html };
}

/* ---------------- Word（.doc，HTML 伪装，Word 可直接打开） ---------------- */

function esc(s: unknown): string {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildWordHtml(data: any): string {
  const h: string[] = [];
  const name = esc(data.name || '简历');
  h.push('<h1>' + name + '</h1>');
  if (data.subtitle) h.push('<p class="sub">' + esc(stripMark(data.subtitle)) + '</p>');
  if (data.meta) h.push('<p class="meta">' + esc(stripMark(data.meta)) + '</p>');
  const contacts = (data.contact || []).map((x: any) => esc(typeof x === 'string' ? x : x.text)).filter(Boolean);
  if (contacts.length) h.push('<p class="contact">' + contacts.join(' ｜ ') + '</p>');

  for (const sec of data.sections || []) {
    h.push('<h2>' + esc(sec.title || sec.id || '') + '</h2>');
    switch (sec.type) {
      case 'highlights':
        for (const card of sec.cards || []) {
          h.push('<p>' + richText(card.text, 'html') + '</p>');
        }
        break;
      case 'growth':
        for (const p of sec.phases || []) {
          const head = [p.label, p.date, p.title].filter(Boolean).map(esc).join(' · ');
          if (head) h.push('<p><strong>' + head + '</strong></p>');
          if (p.desc) h.push('<p>' + esc(p.desc) + '</p>');
        }
        break;
      case 'skills':
        for (const g of sec.groups || []) {
          if (g.name) h.push('<p><strong>' + esc(g.name) + '</strong></p>');
          if (g.keywords) h.push('<p>' + richText(g.keywords, 'html') + '</p>');
          if (g.detail) h.push('<p>' + richText(g.detail, 'html') + '</p>');
        }
        break;
      case 'career':
        for (const job of sec.items || []) {
          const head = [job.company, job.role, job.date].filter(Boolean).map(esc).join(' ｜ ');
          if (head) h.push('<h3>' + head + '</h3>');
          if (job.summary) h.push('<p>' + esc(job.summary) + '</p>');
          for (const prj of job.projects || []) {
            if (prj.name) h.push('<p><strong>' + esc(prj.name) + '</strong></p>');
            if (prj.desc) h.push('<p>' + esc(prj.desc) + '</p>');
            for (const r of prj.results || []) {
              if (r.text) h.push('<p>· ' + esc(r.text) + '</p>');
            }
          }
        }
        break;
      case 'projects':
        for (const prj of sec.items || []) {
          if (prj.name) h.push('<p><strong>' + esc(prj.name) + '</strong></p>');
          if (prj.desc) h.push('<p>' + esc(prj.desc) + '</p>');
          for (const r of prj.results || []) {
            if (r.text) h.push('<p>· ' + esc(r.text) + '</p>');
          }
        }
        break;
      default:
        if (typeof sec.text === 'string') h.push('<p>' + richText(sec.text, 'html') + '</p>');
        for (const it of sec.items || []) {
          const t = typeof it === 'string' ? it : it && (it.text || it.title || it.name);
          if (t) h.push('<p>· ' + esc(t) + '</p>');
        }
    }
  }

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>${name} - 简历</title>
<style>
body{font-family:"PingFang SC","Microsoft YaHei",sans-serif;color:#1a1a1a;line-height:1.7;margin:40px;}
h1{font-size:24px;margin:0 0 4px;}
h2{font-size:16px;border-bottom:2px solid #333;padding-bottom:4px;margin:24px 0 12px;}
h3{font-size:14px;margin:16px 0 6px;}
p{margin:4px 0;font-size:12.5px;}
.sub{color:#444;font-size:13px;}
.meta,.contact{color:#555;font-size:12px;}
strong{font-weight:600;}
</style>
</head>
<body>
${h.join('\n')}
</body>
</html>
`;
}
