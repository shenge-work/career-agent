/* =============================================================
 * 图片版 PDF「导出专用页」生成器 —— 复用 v1 真实截图导出管线
 * -------------------------------------------------------------
 * 为什么必须是一个能跑脚本的独立 HTML，而不是在服务端 vm 沙箱里算：
 *   v1 的 buildImagePdf() 依赖实时 DOM 布局 —— makeCaptureClone 三条铁律、
 *   getPageMetrics(offsetWidth/offsetHeight)、collectInkBoxes 用 Range 量文本行盒、
 *   html2canvas 截图、computePageBreaks(cap.clone) 的「不切行吸附」。
 *   这些在 Node 里没有布局引擎，只能交给真实浏览器跑一遍。
 *
 * 与 preview 的区别：preview 是 CSP script-src 'none' 的只读 A4 HTML；
 * 本页要执行脚本，因此所有脚本都来自**本仓库已审核的源码**（v1 js/ + 本地 vendor），
 * 且 payload 在嵌入 <script> 前做 </script> 转义，杜绝用户数据变成可执行代码。
 *
 * ⚠️ 三个踩过的坑，改这里前务必保留：
 *   1) applyImported() 里有 confirm()/alert() —— headless Chrome 会挂起主线程
 *      等 CDP 处理对话框，必须桩掉，否则整页永久卡死；
 *   2) pdfFrame 不能是真 iframe —— 它会加载 blob: PDF，headless 里会卡住；
 *      交给 DOM 兜底当哑元素，靠读 .src 感知「导出完成」；
 *   3) 生成完不要试图把 5MB base64 通过 CDP 回传（超大值必超时），
 *      而是调 downloadPDFNow() 让 Chrome 把文件落到 downloadPath。
 * ============================================================= */
import { findLegacyRoot, loadSources, loadVendor } from './legacy-renderer';

export interface ImageExportHtml {
  html: string;
  legacyRoot: string;
}

/**
 * v1 bundle 顶层 boot 里有 `getElementById(x).addEventListener(...)` 不判空的写法。
 * vm 沙箱的 document 桩对任何 id 都返回元素，所以静态渲染能跑通；真实浏览器返回 null。
 * 这里把「不存在的 id」映射成哑元素，等价于沙箱环境。
 * 只有 #preview / #out 是真实 DOM，其余（pdfFrame / pdfModal / pdfPageInfo）刻意交给它。
 */
const DOM_STUB_SCRIPT = `
(function(){
  var real = document.getElementById.bind(document);
  var cache = {};
  function stub(id){
    return {
      id:id, innerHTML:'', textContent:'', value:'', disabled:false, checked:false, src:'',
      style:{cssText:'', setProperty:function(){}}, dataset:{}, files:[],
      classList:{add:function(){},remove:function(){},toggle:function(){},contains:function(){return false;}},
      addEventListener:function(){}, removeEventListener:function(){}, appendChild:function(){},
      removeChild:function(){}, remove:function(){}, click:function(){}, focus:function(){},
      setAttribute:function(){}, getAttribute:function(){return null;}, removeAttribute:function(){},
      querySelectorAll:function(){return [];}, querySelector:function(){return null;},
      closest:function(){return null;},
      getBoundingClientRect:function(){return {left:0,top:0,right:0,bottom:0,width:0,height:0};},
      offsetWidth:0, offsetHeight:0,
      getContext:function(){return {drawImage:function(){}};}, toDataURL:function(){return '';}
    };
  }
  document.getElementById = function(id){
    var el = real(id);
    if(el) return el;
    if(!cache[id]) cache[id] = stub(id);
    return cache[id];
  };
})();
`;

/** payload 进 <script> 前必须转义：把 < 变 Unicode 转义，顺带处理行分隔符。 */
export function safeJsonForScript(payload: unknown): string {
  return JSON.stringify(payload)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function buildDriver(payloadJson: string): string {
  return `
(function(){
  var out = document.getElementById('out');
  window.__RESULT__ = { status:'pending' };
  window.__ALERTS__ = [];
  window.__PAGING__ = null;
  function fail(m){
    window.__RESULT__ = { status:'error', error:String(m && (m.stack||m.message||m)) };
    out.textContent = 'ERROR ' + window.__RESULT__.error;
  }
  /* 坑 1：headless 的 confirm/alert 会挂起主线程等 CDP 处理对话框 */
  window.confirm = function(){ return true; };
  window.alert = function(m){
    window.__ALERTS__.push(String(m));
    if(String(m).indexOf('失败') >= 0) fail('alert: ' + m);
  };
  window.addEventListener('error', function(e){
    fail('window.error: ' + (e.message||'') + ' @' + (e.filename||'') + ':' + (e.lineno||''));
  });
  try{
    if(typeof ResumeEditor !== 'object' || typeof ResumeExport !== 'object' || typeof RB !== 'object'){
      throw new Error('v1 导出管线未就绪');
    }
    ResumeEditor.applyImported(${payloadJson});
    var live = document.getElementById('preview').querySelector('.resume');
    if(!live) throw new Error('预览未渲染出 .resume');
    window.__LIVE__ = { w: live.offsetWidth, h: live.offsetHeight };

    /* 契约探针：钉住「分页点必须量被截图的那个克隆」与「克隆与预览同高」两条铁律。
       buildImagePdf 里调的是 RB.computePageBreaks(cap.clone)，这里包一层记录入参。 */
    var origBreaks = RB.computePageBreaks;
    RB.computePageBreaks = function(root){
      var b = origBreaks(root);
      if(root && root !== live && typeof root.offsetHeight === 'number'){
        window.__PAGING__ = {
          rootIsClone: true,
          rootW: root.offsetWidth,
          rootH: root.offsetHeight,
          breaks: b
        };
      }
      return b;
    };

    ResumeExport.exportPDF();
    /* 坑 2：pdfFrame 是 DOM 兜底给的哑元素，不会真去加载 blob: PDF */
    var frame = document.getElementById('pdfFrame');
    var t0 = Date.now();
    var poll = setInterval(function(){
      if(window.__RESULT__.status === 'error'){ clearInterval(poll); return; }
      var src = frame.src || '';
      if(typeof src === 'string' && src.indexOf('blob:') === 0){
        clearInterval(poll);
        try{
          /* 坑 3：不回传 base64，直接让 Chrome 下载落盘 */
          ResumeExport.downloadPDFNow();
          window.__RESULT__ = {
            status:'downloaded',
            pages: document.getElementById('pdfPageInfo').textContent || '',
            live: window.__LIVE__,
            paging: window.__PAGING__,
            alerts: window.__ALERTS__
          };
          out.textContent = 'DOWNLOADED';
        }catch(e){ fail(e); }
      } else if(Date.now() - t0 > 90000){
        clearInterval(poll);
        fail('图片版 PDF 生成超时（未拿到 blob，可能缺少 Chrome 或截图库）');
      }
    }, 250);
  }catch(e){ fail(e); }
})();
`;
}

/**
 * 生成自执行导出页。返回 HTML 字符串，由 image-pdf.service 交给 headless Chrome，
 * 也可通过 /api/resumes/:id/export-page 在用户浏览器里直接打开。
 */
export function buildImagePdfHtml(payload: any, explicitRoot?: string): ImageExportHtml {
  if (!payload || !payload.data || !Array.isArray(payload.data.sections)) {
    throw new Error('JSON 缺少 data.sections，无法导出图片版 PDF');
  }
  const root = findLegacyRoot(explicitRoot || process.env.LEGACY_ROOT);
  const { bundle, css } = loadSources(root);
  const vendors = loadVendor(root);

  // 所有脚本都是本地源码内联，不加载任何外部资源；payload 已做 </script> 转义。
  // connect-src 'none' 让简历正文不可能被脚本外发；blob: 仅供下载与 canvas 使用。
  const csp = [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "connect-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');

  const style = `
${css}
html,body{height:auto;overflow:visible;background:#fff;margin:0;padding:0;}
.preview-frame{display:block;width:900px;padding:0;overflow:visible;position:relative;}
.resume{margin:0 auto;transform:none !important;}
@media print{ .reorder-btns{display:none !important;} }
`;

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>图片版 PDF 导出中…</title>
<style>${style}</style>
</head>
<body>
<div class="preview-frame" id="preview"></div>
<pre id="out">pending</pre>
${vendors.map((s) => '<script>' + s + '</script>').join('\n')}
<script>${DOM_STUB_SCRIPT}</script>
<script>${bundle}</script>
<script>${buildDriver(safeJsonForScript(payload))}</script>
</body>
</html>
`;
  return { html, legacyRoot: root };
}
