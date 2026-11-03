/**
 * Screenshot real ReqHub components at wide (900px) and narrow (400px) viewports,
 * in both light and dark themes.
 * 
 * Uses the real built preview-bundle.js (IIFE) which exposes window.__ReqHubPreview__.
 */
import { chromium } from 'playwright';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const outDir = resolve(root, 'docs');
await mkdir(outDir, { recursive: true });

const previewJs = await readFile(resolve(root, 'lib/preview-entry.iife.js'), 'utf8');
const styleCss = await readFile(resolve(root, 'lib/style.css'), 'utf8');

// ── CSS variable sets ──
const lightTokens = `:root,[data-theme="light"]{
  --dsw-alias-brand-primary-new-colorprimary-new-color:#2563eb;
  --dsw-alias-label-primary:#1a1a1a;--dsw-alias-label-secondary:#6b7280;
  --dsw-alias-label-tertiary:#9ca3af;--dsw-alias-label-primary-foreground:#fff;
  --dsw-alias-bg-base:#f7f8fa;--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#f3f4f6;
  --dsw-alias-bg-mask-1:rgba(0,0,0,.35);
  --dsw-alias-border-l1:#e5e7eb;--dsw-alias-border-l3:#d1d5db;
  --dsw-alias-interactive-bg-hover:rgba(37,99,235,.08);
  --dsw-alias-interactive-bg-active:rgba(37,99,235,.14);
  --dsw-alias-button-elevated-fill:#fff;--dsw-alias-button-floating-hover:#f3f4f6;
  --dsw-alias-button-primary-fill:#2563eb;--dsw-alias-button-primary-hover:#1d4ed8;
  --dsw-alias-button-tool-bar-fill:#f9fafb;--dsw-alias-button-tool-bar-hover:#f3f4f6;
  --dsw-alias-state-success-primary:#16a34a;--dsw-alias-state-success-bg:#f0fdf4;
  --dsw-alias-state-error-primary:#dc2626;--dsw-alias-state-error-bg:#fef2f2;
  --dsw-alias-state-warn-primary:#d97706;--dsw-alias-state-business-primary:#2563eb;
  --dsw-alias-toast-bg:#1f2937;--dsw-alias-toast-label:#fff;
  --dsw-elevation-soft:0 1px 2px rgba(0,0,0,.05);
  --dsw-elevation-prominent:0 8px 24px rgba(0,0,0,.18);
  --dsw-elevation-panel:0 4px 16px rgba(0,0,0,.14);
  --dsw-radius-xs:4px;--dsw-radius-sm:6px;--dsw-radius-md:8px;
  --dsw-radius-lg:12px;--dsw-radius-panel:12px;
  --dsw-font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  --ds-font-family-code:"SF Mono",Menlo,Consolas,monospace;
  --dsw-menu-surface-fill:#fff;--dsw-menu-backdrop-filter:none;
  --dsw-static-neutral-bluish-00:#fff;
  --dsh-frame-overlay-top:24px;--dsh-frame-chrome-top:0px;
}`;

const darkTokens = `:root,[data-theme="dark"]{
  --dsw-alias-brand-primary-new-colorprimary-new-color:#3b82f6;
  --dsw-alias-label-primary:#e5e7eb;--dsw-alias-label-secondary:#9ca3af;
  --dsw-alias-label-tertiary:#6b7280;--dsw-alias-label-primary-foreground:#fff;
  --dsw-alias-bg-base:#0f1117;--dsw-alias-bg-layer-1:#1a1d26;--dsw-alias-bg-layer-2:#252830;
  --dsw-alias-bg-mask-1:rgba(0,0,0,.6);
  --dsw-alias-border-l1:#2d3039;--dsw-alias-border-l3:#3d4049;
  --dsw-alias-interactive-bg-hover:rgba(59,130,246,.12);
  --dsw-alias-interactive-bg-active:rgba(59,130,246,.2);
  --dsw-alias-button-elevated-fill:#252830;--dsw-alias-button-floating-hover:#2d3039;
  --dsw-alias-button-primary-fill:#3b82f6;--dsw-alias-button-primary-hover:#2563eb;
  --dsw-alias-button-tool-bar-fill:#1a1d26;--dsw-alias-button-tool-bar-hover:#252830;
  --dsw-alias-state-success-primary:#22c55e;--dsw-alias-state-success-bg:rgba(34,197,94,.1);
  --dsw-alias-state-error-primary:#ef4444;--dsw-alias-state-error-bg:rgba(239,68,68,.1);
  --dsw-alias-state-warn-primary:#f59e0b;--dsw-alias-state-business-primary:#3b82f6;
  --dsw-alias-toast-bg:#252830;--dsw-alias-toast-label:#e5e7eb;
  --dsw-elevation-soft:0 1px 2px rgba(0,0,0,.3);
  --dsw-elevation-prominent:0 8px 24px rgba(0,0,0,.5);
  --dsw-elevation-panel:0 4px 16px rgba(0,0,0,.4);
  --dsw-menu-surface-fill:#252830;
  --dsw-static-neutral-bluish-00:#fff;
  --dsw-font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  --ds-font-family-code:"SF Mono",Menlo,Consolas,monospace;
  --dsw-radius-xs:4px;--dsw-radius-sm:6px;--dsw-radius-md:8px;
  --dsw-radius-lg:12px;--dsw-radius-panel:12px;
  --dsh-frame-overlay-top:24px;--dsh-frame-chrome-top:0px;
}`;

// ── Mock fetch ──
const mockFetch = `
window.fetch = function(url, opts) {
  if (url.includes('/create-status')) {
    return Promise.resolve({ok:true,status:200,json:()=>Promise.resolve({
      branch:'feature/zhangsan/2026-03-20-报表导出',
      head:'abc123def456789012345678901234567890abcd',
      dirty:false,inProgress:false,canUpdateMain:false,existingRequirement:null
    })});
  }
  if (url.includes('/tree')) {
    return Promise.resolve({ok:true,status:200,json:()=>Promise.resolve({
      tree:{developers:[
        {name:'zhangsan',requirementCount:3,requirements:[
          {id:'2026-03-15-报价单导出',date:'2026-03-15',title:'报价单导出',path:'zhangsan/2026-03-15-报价单导出',fileCount:4},
          {id:'2026-03-18-审批流程优化',date:'2026-03-18',title:'审批流程优化',path:'zhangsan/2026-03-18-审批流程优化',fileCount:2},
          {id:'2026-03-20-报表导出',date:'2026-03-20',title:'报表导出',path:'zhangsan/2026-03-20-报表导出',fileCount:0},
        ]},
        {name:'lisi',requirementCount:1,requirements:[
          {id:'2026-03-10-用户管理',date:'2026-03-10',title:'用户管理',path:'lisi/2026-03-10-用户管理',fileCount:3},
        ]},
      ]}
    })});
  }
  return Promise.resolve({ok:true,status:200,json:()=>Promise.resolve({})});
};`;

// ── Scene renderers ──
const scenes = {
  'create-form': `
    const {CreateDirForm, DocsViewerContext, h} = window.__ReqHubPreview__;
    ReactDOM.createRoot(document.getElementById('root')).render(
      h(DocsViewerContext.Provider, {value:{refreshTree:()=>{},refreshSelectedReq:()=>{}}},
        h('div', {style:{padding:'20px',maxWidth:'600px',margin:'0 auto'}},
          h(CreateDirForm, {
            workspaceId:'ws-1', docsDir:'docs',
            onClose:()=>{}, initialCreateBranch:false, refreshVersion:0
          })
        )
      )
    );`,
  'req-modal': `
    const {RequirementDirModal, h} = window.__ReqHubPreview__;
    ReactDOM.createRoot(document.getElementById('root')).render(
      h('div', {style:{position:'relative',height:'100vh',display:'flex',alignItems:'center',justifyContent:'center',background:'var(--dsw-alias-bg-base)'}},
        h('div', {style:{position:'absolute',inset:0,background:'var(--dsw-alias-bg-mask-1)'}}),
        h(RequirementDirModal, {
          workspaceId:'ws-1',
          selectedReqId:'2026-03-15-报价单导出',
          onSelect:()=>{}, onClose:()=>{}
        })
      )
    );`,
  'ws-modal': `
    const {WorkspaceModal, h} = window.__ReqHubPreview__;
    const workspaces=[
      {id:'ws-1',title:'报价管理系统'},
      {id:'ws-2',title:'订单中心重构'},
      {id:'ws-3',title:'用户权限平台'},
      {id:'ws-4',title:'数据同步中间件'}
    ];
    ReactDOM.createRoot(document.getElementById('root')).render(
      h('div', {style:{position:'relative',height:'100vh',display:'flex',alignItems:'center',justifyContent:'center',background:'var(--dsw-alias-bg-base)'}},
        h('div', {style:{position:'absolute',inset:0,background:'var(--dsw-alias-bg-mask-1)'}}),
        h(WorkspaceModal, {workspaces, selectedId:'ws-1', onSelect:()=>{}, onClose:()=>{}})
      )
    );`,
};

// ── Build HTML page ──
function buildHtml(theme, sceneCode) {
  const tokens = theme === 'dark' ? darkTokens : lightTokens;
  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="${theme}">
<head><meta charset="utf-8"/>
<style>${tokens}</style>
<style>${styleCss}</style>
<style>
* { box-sizing: border-box; }
body { margin:0; padding:0; font-family:var(--dsw-font-family); background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); }
#root { width:100%; height:100vh; overflow:hidden; }
</style>
</head>
<body>
<div id="root"></div>
<script crossorigin src="https://unpkg.com/react@18.3.1/umd/react.production.min.js"><\/script>
<script crossorigin src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js"><\/script>
<script>${mockFetch}<\/script>
<script>${previewJs}<\/script>
<script>${scenes[sceneCode]}<\/script>
</body></html>`;
}

// ── Screenshot all scenes ──
const viewports = [
  { name: 'wide', width: 900, height: 600 },
  { name: 'narrow', width: 400, height: 700 },
];

const browser = await chromium.launch({ headless: true });

for (const [sceneKey, sceneCode] of Object.entries(scenes)) {
  for (const theme of ['light', 'dark']) {
    for (const vp of viewports) {
      const html = buildHtml(theme, sceneCode);
      const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
      
      const errors = [];
      page.on('pageerror', err => errors.push(err.message));
      page.on('console', msg => {
        if (msg.type() === 'error') errors.push(msg.text());
      });
      
      await page.setContent(html, { waitUntil: 'networkidle', timeout: 15000 });
      await page.waitForTimeout(1000);
      
      if (errors.length > 0) {
        console.log(`⚠ ${sceneKey}-${theme}-${vp.name}: ${errors.join('; ')}`);
      }
      
      const filename = `${sceneKey}-${theme}-${vp.name}.png`;
      await page.screenshot({ path: resolve(outDir, filename), fullPage: false });
      console.log(`✓ ${filename}`);
      await page.close();
    }
  }
}

await browser.close();
console.log('Done.');
