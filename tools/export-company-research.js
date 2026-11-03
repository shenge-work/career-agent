#!/usr/bin/env node
'use strict';
/*
 * 公司情报汇总导出（沉淀管线）
 *
 *   node tools/export-company-research.js            生成可入库的脱敏快照 docs/公司调研/公司情报汇总.md
 *   node tools/export-company-research.js --check   校验快照是否与事实源一致（过期返回 exit 1）
 *   node tools/export-company-research.js --private 生成不脱敏完整版 data/公司情报汇总-完整版.md（不入库）
 *
 * 事实源只有一个：data/companies/companies.json（data/ 整体被 .gitignore 排除）。
 * 本脚本产出的 Markdown 是「可读快照」，请勿手工编辑；改数据请在应用内录入或直接改事实源后重跑。
 * 边界铁律：公司侧不出现投递状态 / IM 聊天正文，本快照严格遵守（聊天记录归投递板块）。
 */

var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
var SRC = path.join(ROOT, 'data', 'companies', 'companies.json');
var OUT_PUBLIC = path.join(ROOT, 'docs', '公司调研', '公司情报汇总.md');
var OUT_PRIVATE = path.join(ROOT, 'data', '公司情报汇总-完整版.md');

/* 与 js/store/company-store.js 的 DIMS / DIM_ORDER 保持一致 */
var DIMS = ['公司简介', '团队情况', '盈利情况', '融资情况', '竞品分析', '风险与挑战', '其他'];
var CORE_DIMS = DIMS.slice(0, 6);

var args = process.argv.slice(2);
var isPrivate = args.indexOf('--private') >= 0;
var isCheck = args.indexOf('--check') >= 0;

function pad(n) { return n < 10 ? '0' + n : '' + n; }
function fmtDate(ms) {
  if (!ms || isNaN(Number(ms))) return '—';
  var d = new Date(Number(ms));
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
function fmtDateTime(ms) {
  if (!ms || isNaN(Number(ms))) return '—';
  var d = new Date(Number(ms));
  return fmtDate(ms) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
function t(v) { return v == null ? '' : String(v); }
function cell(v) { return t(v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim(); }
function line(v) { return t(v).replace(/\r?\n+/g, ' ').trim(); }

/* 招聘者姓名脱敏：已带称谓（先生/女士/同学）原样保留；其余保留姓氏 + 掩码。
   「刘女士·HRBP」→「刘女士」；「闫冰·招聘者」→「闫*」。 */
function maskRecruiter(s) {
  var raw = t(s).trim();
  if (!raw) return '';
  var name = raw.split('·')[0].trim();
  if (!name) return '';
  if (/(先生|女士|同学|老师|HR|招聘者)/.test(name)) return name;
  return name.length <= 1 ? name : name.charAt(0) + '*';
}

/* 从全库 JD 收集「完整姓名 → 姓*」映射，用于脱敏调研正文里出现的招聘者姓名。 */
function collectNameMap(list) {
  var map = {};
  list.forEach(function (c) {
    arr(c.jds).forEach(function (j) {
      var name = t(j.recruiter).split('·')[0].trim();
      if (name.length >= 2 && !/(先生|女士|同学|老师|HR|招聘者)/.test(name)) {
        map[name] = name.charAt(0) + '*';
      }
    });
  });
  return map;
}
function maskText(s, nameMap) {
  var out = t(s);
  Object.keys(nameMap).forEach(function (k) {
    out = out.split(k).join(nameMap[k]);
  });
  return out;
}

/* 历史导入条目：早期从「BOSS直聘求职记录」整段粘进 research（dim=其他），
   含「投递岗位 / 联系人 / 求职记录」等投递上下文。按公司档案边界铁律，
   不并入六维调研主体，单独放附注区，资料不丢但语义不越界。 */
function isLegacyEntry(r) {
  return (r.dim || '其他') === '其他' && /(投递岗位|求职记录|联系人：)/.test(t(r.content));
}

function arr(v) { return Array.isArray(v) ? v : []; }
function joined(v, sep) {
  var a = arr(v).map(function (x) { return t(x).trim(); }).filter(Boolean);
  return a.length ? a.join(sep || ' / ') : '—';
}

function renderCompany(c, idx, privateMode, nameMap) {
  var out = [];
  var allResearch = arr(c.research);
  var research = allResearch.filter(function (r) { return !isLegacyEntry(r); });
  var legacy = allResearch.filter(isLegacyEntry);
  var jds = arr(c.jds);
  out.push('### ' + idx + '. ' + line(c.name || '未命名公司'));
  out.push('');
  out.push('| 字段 | 内容 |');
  out.push('|---|---|');
  out.push('| 行业 | ' + cell(c.industry || '—') + ' |');
  out.push('| 规模 | ' + cell(c.scale || '—') + ' |');
  out.push('| 地点 | ' + cell(c.location || '—') + ' |');
  out.push('| 官网 | ' + cell(c.website || '—') + ' |');
  out.push('| 档案建立 | ' + fmtDate(c.createdAt) + ' |');
  out.push('| 最近更新 | ' + fmtDate(c.updatedAt) + ' |');
  out.push('');
  if (t(c.note).trim()) {
    out.push('**备注**：' + (privateMode ? line(c.note) : maskText(line(c.note), nameMap)));
    out.push('');
  }
  out.push('#### 六维调研（' + research.length + ' 条' + (legacy.length ? '，另有 ' + legacy.length + ' 条历史导入条目见附注' : '') + '）');
  out.push('');
  var used = {};
  DIMS.forEach(function (dim) {
    var items = research.filter(function (r) { return (r.dim || '其他') === dim; });
    if (!items.length) return;
    used[dim] = true;
    out.push('##### ' + dim + '（' + items.length + '）');
    out.push('');
    items.forEach(function (r) {
      var meta = [];
      if (t(r.platform).trim()) meta.push('来源：' + line(r.platform));
      if (t(r.date).trim()) meta.push(line(r.date));
      if (t(r.url).trim()) meta.push('[原文](' + line(r.url) + ')');
      var body = privateMode ? line(r.content) : maskText(line(r.content), nameMap);
      out.push('- ' + body + (meta.length ? '　〔' + meta.join(' · ') + '〕' : ''));
    });
    out.push('');
  });
  var missing = CORE_DIMS.filter(function (d) { return !used[d]; });
  if (missing.length) {
    out.push('> 尚无资料维度：' + missing.join('、') + '（' + CORE_DIMS.filter(function (d) { return used[d]; }).length + '/6 已覆盖）');
    out.push('');
  }
  if (legacy.length) {
    out.push('#### 附：历史导入条目（' + legacy.length + ' 条，含投递上下文）');
    out.push('');
    out.push('> 以下条目是早期从「BOSS直聘求职记录」整段导入的，含投递岗位 / 联系人等上下文。按公司档案边界铁律，**不计入六维调研、不作为公司背景资料**；完整原文仍保留在事实源 `companies.json`，后续建议迁往投递板块。');
    out.push('');
    legacy.forEach(function (r) {
      var meta = [];
      if (t(r.platform).trim()) meta.push('来源：' + line(r.platform));
      if (t(r.date).trim()) meta.push(line(r.date));
      var body = privateMode ? line(r.content) : maskText(line(r.content), nameMap);
      out.push('- ' + body + (meta.length ? '　〔' + meta.join(' · ') + '〕' : ''));
    });
    out.push('');
  }
  out.push('#### 岗位 / JD（' + jds.length + ' 份）');
  out.push('');
  if (!jds.length) {
    out.push('（暂无 JD）');
    out.push('');
    return out.join('\n');
  }
  jds.forEach(function (j, i) {
    var recruiter = privateMode ? t(j.recruiter).trim() : maskRecruiter(j.recruiter);
    var head = '**' + (i + 1) + '. ' + line(j.title || '未命名岗位') + '**';
    if (t(j.salary).trim()) head += ' · ' + line(j.salary);
    out.push(head);
    out.push('');
    var meta = [j.city, j.experience, j.education, recruiter ? '招聘者 ' + recruiter : '', j.source].filter(function (x) { return t(x).trim(); });
    out.push('- 基本信息：' + (meta.length ? meta.map(line).join(' · ') : '—'));
    out.push('- 记录于：' + fmtDateTime(j.appliedAt) + (t(j.companyInfo).trim() ? '　·　' + line(j.companyInfo) : ''));
    out.push('- 技能要求：' + joined(j.skills));
    out.push('- 福利待遇：' + joined(j.benefits));
    if (t(j.url).trim()) out.push('- 岗位链接：[' + line(j.url) + '](' + line(j.url) + ')');
    if (arr(j.duties).length) {
      out.push('- 岗位职责：');
      arr(j.duties).forEach(function (x, k) { out.push('  ' + (k + 1) + '. ' + line(x)); });
    }
    if (arr(j.requirements).length) {
      out.push('- 任职要求：');
      arr(j.requirements).forEach(function (x, k) { out.push('  ' + (k + 1) + '. ' + line(x)); });
    }
    out.push('');
  });
  return out.join('\n');
}

function build(privateMode) {
  var list = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  if (!Array.isArray(list)) throw new Error('companies.json 应为数组');
  var totalResearch = 0, totalJd = 0, totalLegacy = 0, maxUpdated = 0;
  var nameMap = collectNameMap(list);
  list.forEach(function (c) {
    totalResearch += arr(c.research).length;
    totalLegacy += arr(c.research).filter(isLegacyEntry).length;
    totalJd += arr(c.jds).length;
    var u = Number(c.updatedAt) || 0;
    if (u > maxUpdated) maxUpdated = u;
  });
  var out = [];
  out.push('# 公司情报汇总（只读快照）');
  out.push('');
  out.push('> 本文件由 `tools/export-company-research.js` 从 `data/companies/companies.json` 自动生成，**请勿手工编辑**。');
  out.push('> 数据截至：**' + fmtDate(maxUpdated) + '** · 公司 **' + list.length + '** 家 · 调研条目 **' + totalResearch + '** 条（其中 ' + totalLegacy + ' 条为含投递上下文的历史导入条目，单列附注）· 岗位 JD **' + totalJd + '** 份。');
  out.push('> 事实源：`data/companies/companies.json`（私有目录，`.gitignore` 排除，不入库）；投递平台与 IM 聊天记录归投递板块，见 `data/tracker/seed.json`。');
  if (!privateMode) {
    out.push('> 脱敏：招聘者姓名按「姓 + 称谓 / 掩码」处理；完整版执行 `npm run research:export -- --private`，输出到 `data/`（同样不入库）。');
  } else {
    out.push('> ⚠️ 完整版含未脱敏姓名，仅本地查阅，**不要复制进可入库文档或对外分享**。');
  }
  out.push('');
  out.push('## 一、速览');
  out.push('');
  out.push('| # | 公司 | 行业 | 地点 | 规模 | 调研 | JD | 六维覆盖 |');
  out.push('|---|---|---|---|---|---|---|---|');
  list.forEach(function (c, i) {
    var dims = {};
    arr(c.research).forEach(function (r) { dims[r.dim || '其他'] = true; });
    var covered = CORE_DIMS.filter(function (d) { return dims[d]; }).length;
    out.push('| ' + (i + 1) + ' | ' + cell(c.name) + ' | ' + cell(c.industry || '—') + ' | ' + cell(c.location || '—') + ' | ' + cell(c.scale || '—') +
      ' | ' + arr(c.research).length + ' | ' + arr(c.jds).length + ' | ' + covered + '/6 |');
  });
  out.push('');
  out.push('## 二、逐家公司档案');
  out.push('');
  list.forEach(function (c, i) {
    out.push(renderCompany(c, i + 1, privateMode, nameMap));
    out.push('---');
    out.push('');
  });
  out.push('## 三、维度覆盖度统计');
  out.push('');
  out.push('| 维度 | 覆盖公司数 | 条目数 |');
  out.push('|---|---|---|');
  DIMS.forEach(function (d) {
    var companies = 0, items = 0;
    list.forEach(function (c) {
      var n = arr(c.research).filter(function (r) { return (r.dim || '其他') === d && !isLegacyEntry(r); }).length;
      if (n) companies++;
      items += n;
    });
    out.push('| ' + d + ' | ' + companies + ' / ' + list.length + ' | ' + items + ' |');
  });
  out.push('');
  out.push('> 统计口径：上表仅计六维正式调研，历史导入条目（' + totalLegacy + ' 条）不计入。');
  out.push('');
  out.push('---');
  out.push('');
  out.push('更新方式：在应用「公司档案」中录入或编辑后，执行 `npm run research:export` 重新生成本快照；提交前可用 `npm run research:check` 校验是否过期。');
  out.push('');
  return out.join('\n');
}

function main() {
  if (!fs.existsSync(SRC)) {
    console.error('[research] 找不到事实源：' + SRC);
    process.exit(1);
  }
  var dest = isPrivate ? OUT_PRIVATE : OUT_PUBLIC;
  var content = build(isPrivate);
  if (isCheck) {
    var current = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : '';
    if (current !== content) {
      console.error('[research] 快照已过期，请执行 npm run research:export 重新生成：' + path.relative(ROOT, dest));
      process.exit(1);
    }
    console.log('[research] 快照与事实源一致：' + path.relative(ROOT, dest));
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content, 'utf8');
  console.log('[research] 已生成 ' + path.relative(ROOT, dest) + '（' + content.length + ' 字符' + (isPrivate ? '，未脱敏' : '，已脱敏') + '）');
}

main();
