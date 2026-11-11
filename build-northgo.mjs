import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { runInContext, createContext } from 'node:vm';

const root = new URL('./', import.meta.url);
const dist = new URL('northgo-site/', root);
const scripts = ['sitemap-data.js', 'site-assets/content.js', 'site-assets/offices.js', 'site-assets/site.js'];
const slugs = {zh:'zh-tw',en:'en',ja:'ja',vi:'vi'};
const legalPaths = ['privacy', 'terms', 'cookies', 'disclaimer'];
const origin = process.env.NORTHGO_SITE_URL ? new URL(process.env.NORTHGO_SITE_URL).href.replace(/\/+$/, '') : '';
const version = (await readFile(new URL('VERSION', root), 'utf8')).trim();
const staticHosting = process.env.NORTHGO_STATIC_HOSTING === '1';
const template = await readFile(new URL('northgo-new.html', root), 'utf8');
await mkdir(dist, {recursive:true});
for (const dir of ['site-assets', 'office-assets']) {
  await cp(new URL(dir+'/', root), new URL(dir+'/', dist), {
    recursive:true, filter:path=>!path.endsWith('countries.geojson')
  });
}
await cp(new URL('sitemap-data.js', root), new URL('sitemap-data.js', dist));
const urls = [];
for (const [language, slug] of Object.entries(slugs)) {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id,{innerHTML:'',classList:{remove(){}},setAttribute(){},addEventListener(){}});
    return nodes.get(id);
  };
  const document = {
    getElementById:node, querySelector:node, documentElement:{}, body:{dataset:{}},
    addEventListener(){}
  };
  const context = createContext({window:null,document,URLSearchParams,location:{search:'?lang='+language,hash:''}});
  context.window=context;
  context.addEventListener=()=>{};
  for (const file of scripts) {
    const source = await readFile(new URL(file, root),'utf8');
    runInContext(file.endsWith('/site.js') ? source.split('const builtPage=')[0] : source,context);
  }
  const pages = ['home','services','freight','project','warehouse','shipping','about','offices','contact','sitemap',...legalPaths];
  for (const route of pages) {
    const relative = route==='home' ? slug+'/' : slug+'/'+route+'/';
    const base = route==='home' ? '../' : '../../';
    context.location.hash='#/'+route;
    runInContext('render(false, false)',context);
    const html = template
      .replace('<head>','<head><base href="'+base+'"><meta name="version" content="'+version+'">')
      .replace(/<html lang="[^"]+"/,'<html lang="'+document.documentElement.lang+'"')
      .replace('<body>','<body data-route="'+route+'" data-locale="'+language+'"'+(staticHosting?' data-static-hosting="true"':'')+'>')
      .replace(/<title>.*?<\/title>/,'<title>'+document.title+'</title>')
      .replace(/(<meta name="description" content=")[^"]*/,(_,tag)=>tag+String(node('meta[name=description]').content).replaceAll('&','&amp;').replaceAll('"','&quot;'))
      .replace('<nav id="nav" aria-label="Main navigation"></nav>', '<nav id="nav" aria-label="Main navigation">'+node('nav').innerHTML+'</nav>')
      .replace('<main id="main" tabindex="-1"></main>','<main id="main" tabindex="-1">'+node('main').innerHTML+'</main>')
      .replace('<footer id="footer"></footer>','<footer id="footer">'+node('footer').innerHTML.replace('{{VERSION}}',version)+'</footer>')
      .replace('</head>',Object.entries(slugs).map(([key, value])=>{
        const href=value+(route==='home'?'':'/'+route)+'/';
        return '<link rel="alternate" hreflang="'+({zh:'zh-TW'}[key]||key)+'" href="'+(origin?origin+'/':'')+href+'index.html">';
      }).join('')+(origin?'<link rel="canonical" href="'+origin+'/'+relative+'index.html">':'')+'</head>')
      .replaceAll(/#\/([a-z]+)(?:\?([^"']*))?/g,(_,page,query)=>slug+(page==='home'?'':'/'+page)+'/index.html'+(query?'?'+query:''))
      .replace('href="#main"','href="'+relative+'index.html#main"');
    await mkdir(new URL(relative,dist),{recursive:true});
    await writeFile(new URL(relative+'index.html',dist),html);
    urls.push(relative+'index.html');
  }
}
await writeFile(new URL('index.html',dist),'<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><title>Northgo</title><meta http-equiv="refresh" content="0; url=zh-tw/index.html"><a href="zh-tw/index.html">Northgo</a></html>');
await writeFile(new URL('robots.txt',dist),'User-agent: *\nAllow: /\n'+(origin?'Sitemap: '+origin+'/sitemap.xml\n':''));
if(origin) await writeFile(new URL('sitemap.xml',dist),'<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'+urls.map(path=>'<url><loc>'+origin+'/'+path+'</loc></url>').join('')+'</urlset>');
console.log('Built '+urls.length+' pages in northgo-site/');
