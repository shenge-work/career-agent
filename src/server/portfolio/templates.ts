/* =============================================================
 * 作品集模板库：3 套内置模板
 * -------------------------------------------------------------
 * minimal   极简 —— 单栏、大留白、黑白，居中排版
 * magazine  杂志 —— 多栏、强排版、衬线标题，适合文字型作品
 * dark-tech 深色科技 —— 暗色 + 代码风 + 高对比，适合技术岗
 *
 * 每套模板是纯函数 (content, layout) => 完整 HTML 文档，
 * 输出确定性、零外部依赖、可直接被 GitHub Pages 托管。
 * ============================================================= */

import type { PortfolioContent, PortfolioLayout, PortfolioTemplate, TemplateMeta } from './types';

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isVisible(layout: PortfolioLayout, key: string): boolean {
  if (layout.visible && typeof layout.visible[key] === 'boolean') return layout.visible[key];
  return true;
}

/** 按 layout.order 排序板块键，未在 order 里的排最后（保持默认顺序）。 */
function orderedSections(layout: PortfolioLayout, defaults: string[]): string[] {
  const order = layout.order || defaults;
  const seen = new Set<string>();
  const out: string[] = [];
  order.forEach((k) => {
    if (!seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  });
  defaults.forEach((k) => {
    if (!seen.has(k)) out.push(k);
  });
  return out;
}

function renderLinks(links: PortfolioContent['links']): string {
  if (!links || !links.length) return '';
  return links.map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>`).join('\n');
}

function renderProjects(projects: PortfolioContent['projects']): string {
  if (!projects || !projects.length) return '';
  return projects
    .map((p) => {
      const tags = p.tags && p.tags.length ? `<div class="tags">${p.tags.map((t) => `<span>${esc(t)}</span>`).join('')}</div>` : '';
      const metrics =
        p.metrics && p.metrics.length
          ? `<div class="metrics">${p.metrics.map((m) => `<div class="metric"><b>${esc(m.value)}</b><span>${esc(m.label)}</span></div>`).join('')}</div>`
          : '';
      const title = p.link ? `<a href="${esc(p.link)}" target="_blank" rel="noopener">${esc(p.name)}</a>` : esc(p.name);
      return `<article class="project"><h4>${title}</h4><p>${esc(p.desc)}</p>${metrics}${tags}</article>`;
    })
    .join('\n');
}

function renderExperience(items: PortfolioContent['experience']): string {
  if (!items || !items.length) return '';
  return items
    .map(
      (e) =>
        `<div class="exp"><div class="exp-head"><b>${esc(e.role)}</b><span>${esc(e.org)}</span><time>${esc(e.period)}</time></div><p>${esc(e.desc)}</p></div>`
    )
    .join('\n');
}

function renderSkills(skills: PortfolioContent['skills']): string {
  if (!skills || !skills.length) return '';
  return `<div class="skills">${skills.map((s) => `<span>${esc(s)}</span>`).join('')}</div>`;
}

/* ============================================================ 极简 ============================================================ */

const minimal: PortfolioTemplate = {
  meta: { id: 'minimal', name: '极简', description: '单栏 · 大留白 · 黑白，居中排版' },
  render(content, layout) {
    const sections = orderedSections(layout, ['bio', 'projects', 'experience', 'skills', 'education', 'custom']);
    let body = '';
    const c = content as PortfolioContent;

    if (isVisible(layout, 'bio') && c.bio) {
      body += `<section class="bio"><p>${esc(c.bio)}</p></section>`;
    }
    if (isVisible(layout, 'projects') && c.projects?.length) {
      body += `<section><h2>项目</h2>${renderProjects(c.projects)}</section>`;
    }
    if (isVisible(layout, 'experience') && c.experience?.length) {
      body += `<section><h2>经历</h2>${renderExperience(c.experience)}</section>`;
    }
    if (isVisible(layout, 'skills') && c.skills?.length) {
      body += `<section><h2>技能</h2>${renderSkills(c.skills)}</section>`;
    }
    if (isVisible(layout, 'education') && c.education?.length) {
      body += `<section><h2>教育</h2>${renderExperience(c.education)}</section>`;
    }
    if (isVisible(layout, 'custom') && c.custom?.length) {
      body += c.custom.map((x) => `<section><h2>${esc(x.title)}</h2><p>${esc(x.body)}</p></section>`).join('\n');
    }

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(c.name)} · ${esc(c.title)}</title>
<style>
  :root{--bg:#fafafa;--ink:#1a1a1a;--muted:#888;}
  *{box-sizing:border-box;margin:0;padding:0;}
  body{background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif;line-height:1.7;padding:0 24px;}
  .wrap{max-width:720px;margin:0 auto;padding:96px 0;}
  header{text-align:center;margin-bottom:64px;}
  h1{font-size:40px;font-weight:700;letter-spacing:-0.02em;}
  .headline{color:var(--muted);margin-top:8px;font-size:18px;}
  .links{margin-top:20px;display:flex;gap:16px;justify-content:center;flex-wrap:wrap;}
  .links a{color:var(--ink);text-decoration:none;border-bottom:1px solid #ccc;}
  section{margin-bottom:56px;}
  h2{font-size:20px;font-weight:600;margin-bottom:20px;letter-spacing:0.08em;}
  .bio p{font-size:17px;color:#333;}
  .project{margin-bottom:28px;}
  .project h4{font-size:17px;margin-bottom:6px;}
  .project h4 a{color:var(--ink);text-decoration:none;}
  .project p{color:#444;font-size:15px;}
  .metrics{display:flex;gap:24px;margin-top:10px;}
  .metric b{font-size:22px;display:block;}
  .metric span{color:var(--muted);font-size:12px;}
  .tags{margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;}
  .tags span{font-size:12px;color:#555;border:1px solid #ddd;padding:2px 10px;border-radius:999px;}
  .exp{margin-bottom:20px;}
  .exp-head{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;}
  .exp-head b{font-size:16px;}
  .exp-head span{color:var(--muted);font-size:14px;}
  .exp-head time{color:#aaa;font-size:13px;margin-left:auto;}
  .exp p{color:#444;font-size:14px;margin-top:4px;}
  .skills{display:flex;gap:10px;flex-wrap:wrap;}
  .skills span{font-size:14px;border:1px solid #ddd;padding:4px 14px;border-radius:6px;}
  footer{text-align:center;color:#bbb;font-size:13px;padding:48px 0;}
  @media(max-width:640px){h1{font-size:32px;}.wrap{padding:64px 0;}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>${esc(c.name)}</h1>
    <div class="headline">${esc(c.headline || c.title)}</div>
    ${c.location ? `<div class="headline" style="font-size:14px">${esc(c.location)}</div>` : ''}
    <div class="links">${renderLinks(c.links)}</div>
  </header>
  ${body}
  <footer>© ${new Date().getFullYear()} ${esc(c.name)}</footer>
</div>
</body>
</html>`;
  },
};

/* ============================================================ 杂志 ============================================================ */

const magazine: PortfolioTemplate = {
  meta: { id: 'magazine', name: '杂志', description: '多栏 · 衬线标题 · 强排版，适合文字型作品' },
  render(content, layout) {
    const c = content as PortfolioContent;
    const sections = orderedSections(layout, ['bio', 'projects', 'experience', 'skills', 'education', 'custom']);
    let main = '';

    if (isVisible(layout, 'bio') && c.bio) {
      main += `<section class="lead"><p>${esc(c.bio)}</p></section>`;
    }
    if (isVisible(layout, 'projects') && c.projects?.length) {
      main += `<section><h2 class="num">01</h2><h2>项目</h2>${renderProjects(c.projects)}</section>`;
    }
    if (isVisible(layout, 'experience') && c.experience?.length) {
      main += `<section><h2 class="num">02</h2><h2>经历</h2>${renderExperience(c.experience)}</section>`;
    }
    if (isVisible(layout, 'education') && c.education?.length) {
      main += `<section><h2 class="num">03</h2><h2>教育</h2>${renderExperience(c.education)}</section>`;
    }
    if (isVisible(layout, 'custom') && c.custom?.length) {
      main += c.custom.map((x, i) => `<section><h2 class="num">${String(i + 4).padStart(2, '0')}</h2><h2>${esc(x.title)}</h2><p>${esc(x.body)}</p></section>`).join('\n');
    }

    const aside = isVisible(layout, 'skills') && c.skills?.length ? `<aside><h3>技能</h3>${renderSkills(c.skills)}</aside>` : '';

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(c.name)} · ${esc(c.title)}</title>
<style>
  :root{--ink:#111;--accent:#c0392b;--paper:#fffdf8;}
  *{box-sizing:border-box;margin:0;padding:0;}
  body{background:var(--paper);color:var(--ink);font-family:Georgia,"Times New Roman","Songti SC","SimSun",serif;}
  .masthead{border-bottom:3px solid var(--ink);padding:40px 0 20px;margin:0 6vw;}
  .masthead h1{font-size:64px;font-weight:900;letter-spacing:-0.02em;line-height:1;}
  .masthead .sub{font-family:-apple-system,"PingFang SC",sans-serif;color:#666;margin-top:12px;font-size:15px;letter-spacing:0.2em;text-transform:uppercase;}
  .grid{display:grid;grid-template-columns:1fr 280px;gap:0;margin:0 6vw;padding:40px 0;}
  .lead{font-size:21px;line-height:1.8;margin-bottom:48px;}
  .lead p::first-letter{font-size:56px;float:left;line-height:1;margin:4px 10px 0 0;color:var(--accent);font-weight:900;}
  section{margin-bottom:48px;}
  h2{font-size:28px;font-weight:900;display:inline-block;}
  h2.num{color:var(--accent);font-size:20px;margin-right:10px;vertical-align:top;position:relative;top:8px;}
  .project{margin:24px 0;padding-left:16px;border-left:2px solid #eee;}
  .project h4{font-size:19px;}
  .project p{font-family:-apple-system,"PingFang SC",sans-serif;font-size:14px;color:#444;margin-top:6px;}
  .metrics{display:flex;gap:20px;margin-top:10px;font-family:-apple-system,sans-serif;}
  .metric b{font-size:20px;color:var(--accent);}
  .metric span{font-size:11px;color:#999;}
  .tags{margin-top:8px;font-family:-apple-system,sans-serif;}
  .tags span{font-size:11px;color:#777;margin-right:10px;}
  .exp{margin:20px 0;padding-bottom:20px;border-bottom:1px dashed #ddd;}
  .exp-head{font-family:-apple-system,"PingFang SC",sans-serif;}
  .exp-head b{font-size:16px;}
  .exp-head span{color:#888;font-size:13px;margin:0 8px;}
  .exp-head time{color:#bbb;font-size:12px;}
  .exp p{font-family:-apple-system,sans-serif;font-size:13px;color:#555;margin-top:6px;}
  aside{border-left:1px solid #eee;padding-left:32px;}
  aside h3{font-family:-apple-system,sans-serif;font-size:13px;letter-spacing:0.2em;text-transform:uppercase;color:#999;margin-bottom:16px;}
  .skills{display:flex;flex-direction:column;gap:8px;}
  .skills span{font-family:-apple-system,sans-serif;font-size:14px;}
  footer{margin:0 6vw;padding:20px 0 40px;border-top:1px solid #ddd;color:#aaa;font-family:-apple-system,sans-serif;font-size:12px;}
  @media(max-width:820px){.grid{grid-template-columns:1fr;}aside{border-left:none;padding-left:0;margin-top:40px;}.masthead h1{font-size:44px;}}
</style>
</head>
<body>
<header class="masthead"><h1>${esc(c.name)}</h1><div class="sub">${esc(c.headline || c.title)}</div></header>
<div class="grid">
  <main>${main}</main>
  ${aside}
</div>
<footer>${esc(c.name)} · ${esc(c.title)} — ${new Date().getFullYear()}</footer>
</body>
</html>`;
  },
};

/* ============================================================ 深色科技 ============================================================ */

const darkTech: PortfolioTemplate = {
  meta: { id: 'dark-tech', name: '深色科技', description: '暗色 · 代码风 · 高对比，适合技术岗' },
  render(content, layout) {
    const c = content as PortfolioContent;
    const sections = orderedSections(layout, ['bio', 'projects', 'experience', 'skills', 'education', 'custom']);
    let body = '';

    if (isVisible(layout, 'bio') && c.bio) {
      body += `<section><div class="term">$ whoami</div><p>${esc(c.bio)}</p></section>`;
    }
    if (isVisible(layout, 'projects') && c.projects?.length) {
      body += `<section><div class="term">$ ls projects/</div>${renderProjects(c.projects)}</section>`;
    }
    if (isVisible(layout, 'skills') && c.skills?.length) {
      body += `<section><div class="term">$ tech --stack</div>${renderSkills(c.skills)}</section>`;
    }
    if (isVisible(layout, 'experience') && c.experience?.length) {
      body += `<section><div class="term">$ cat experience.log</div>${renderExperience(c.experience)}</section>`;
    }
    if (isVisible(layout, 'education') && c.education?.length) {
      body += `<section><div class="term">$ cat education.log</div>${renderExperience(c.education)}</section>`;
    }
    if (isVisible(layout, 'custom') && c.custom?.length) {
      body += c.custom.map((x) => `<section><div class="term">$ cat ${esc(x.title)}.md</div><p>${esc(x.body)}</p></section>`).join('\n');
    }

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(c.name)} · ${esc(c.title)}</title>
<style>
  :root{--bg:#0d1117;--surface:#161b22;--ink:#e6edf3;--muted:#8b949e;--accent:#58a6ff;--green:#3fb950;}
  *{box-sizing:border-box;margin:0;padding:0;}
  body{background:var(--bg);color:var(--ink);font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;line-height:1.7;}
  .wrap{max-width:820px;margin:0 auto;padding:80px 24px;}
  header{margin-bottom:64px;border:1px solid #30363d;border-radius:10px;overflow:hidden;}
  .titlebar{background:var(--surface);padding:10px 16px;display:flex;gap:8px;border-bottom:1px solid #30363d;}
  .dot{width:12px;height:12px;border-radius:50%;}
  .dot.r{background:#ff5f56;}.dot.y{background:#ffbd2e;}.dot.g{background:#27c93f;}
  .titlebar span{color:var(--muted);font-size:12px;margin-left:8px;}
  .hero{padding:32px;}
  .hero h1{font-size:34px;color:var(--green);}
  .hero h1::before{content:"> ";color:var(--muted);}
  .headline{color:var(--muted);margin-top:10px;font-size:15px;}
  .links{margin-top:18px;display:flex;gap:14px;flex-wrap:wrap;}
  .links a{color:var(--accent);text-decoration:none;font-size:14px;}
  .links a:hover{text-decoration:underline;}
  section{margin-bottom:48px;}
  .term{color:var(--green);margin-bottom:16px;font-size:14px;}
  .term::before{content:"$ ";color:var(--muted);}
  section p{color:#c9d1d9;font-size:15px;}
  .project{background:var(--surface);border:1px solid #30363d;border-radius:8px;padding:20px;margin-bottom:16px;}
  .project h4{font-size:16px;color:var(--accent);margin-bottom:8px;}
  .project h4 a{color:var(--accent);text-decoration:none;}
  .project p{font-size:14px;color:#8b949e;}
  .metrics{display:flex;gap:24px;margin-top:12px;}
  .metric b{font-size:20px;color:var(--green);display:block;}
  .metric span{font-size:11px;color:var(--muted);}
  .tags{margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;}
  .tags span{font-size:12px;color:var(--accent);background:#1f6feb22;border:1px solid #30363d;padding:2px 10px;border-radius:4px;}
  .exp{margin-bottom:16px;padding:16px;border-left:2px solid var(--green);background:var(--surface);}
  .exp-head{display:flex;gap:10px;flex-wrap:wrap;align-items:baseline;}
  .exp-head b{color:var(--ink);font-size:15px;}
  .exp-head span{color:var(--accent);font-size:13px;}
  .exp-head time{color:var(--muted);font-size:12px;margin-left:auto;}
  .exp p{font-size:13px;margin-top:6px;}
  .skills{display:flex;gap:8px;flex-wrap:wrap;}
  .skills span{font-size:13px;color:var(--ink);background:var(--surface);border:1px solid #30363d;padding:4px 12px;border-radius:4px;}
  footer{margin-top:64px;padding-top:20px;border-top:1px solid #30363d;color:var(--muted);font-size:12px;}
  @media(max-width:640px){.hero h1{font-size:26px;}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="titlebar"><div class="dot r"></div><div class="dot y"></div><div class="dot g"></div><span>${esc(c.name)}@portfolio: ~</span></div>
    <div class="hero">
      <h1>${esc(c.name)}</h1>
      <div class="headline">${esc(c.headline || c.title)}</div>
      <div class="links">${renderLinks(c.links)}</div>
    </div>
  </header>
  ${body}
  <footer>${esc(c.name)} · ${esc(c.title)} · ${new Date().getFullYear()}</footer>
</div>
</body>
</html>`;
  },
};

/* ============================================================ 导出 ============================================================ */

const templates: Record<string, PortfolioTemplate> = {
  minimal,
  magazine,
  'dark-tech': darkTech,
};

export function getTemplate(id: string): PortfolioTemplate | undefined {
  return templates[id];
}

export function listTemplates(): TemplateMeta[] {
  return ['minimal', 'magazine', 'dark-tech'].map((id) => templates[id].meta);
}

export { templates };
