import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { adminApi, takeRateLimit } from './backend/admin-api.mjs';
import { openAdminStore } from './backend/admin-store.mjs';
import { createEnquiry, normalizedEnquiry } from './backend/enquiry-repository.mjs';

const project=fileURLToPath(new URL('./',import.meta.url));
const root=resolve(project,'northgo-site');
const inbox=resolve(process.env.NORTHGO_INBOX_DIR||resolve(project,'.northgo-inbox'));
const port=Number(process.env.PORT||4180);
const db=openAdminStore(project);
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.woff2':'font/woff2','.otf':'font/otf','.xml':'application/xml','.txt':'text/plain; charset=utf-8'};
const routes={'/about':'/en/about/','/contact':'/en/contact/','/services/freight-logistics':'/en/freight/','/services/project-logistics':'/en/project/','/services/warehouse-logistics':'/en/warehouse/','/services/shipping-agency':'/en/shipping/','/legal/privacy-policy':'/en/privacy/','/legal/terms':'/en/terms/','/legal/cookie-policy':'/en/cookies/','/legal/disclaimer':'/en/disclaimer/'};
const build=spawnSync(process.execPath,[resolve(project,'build-northgo.mjs')],{stdio:'inherit',env:{...process.env,NORTHGO_STATIC_HOSTING:'0',NORTHGO_SITE_URL:process.env.NORTHGO_SITE_URL||'http://127.0.0.1:'+port}});
if(build.status!==0)process.exit(1);
function json(response,status,value){
  response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  response.end(JSON.stringify(value));
}
async function receive(request,response){
  if(!takeRateLimit('enquiry:'+request.socket.remoteAddress,30,60*1000))
    return json(response,429,{error:'Too many enquiries. Please retry later.'});
  if(!/^application\/json(?:;|$)/i.test(request.headers['content-type']||''))return json(response,415,{error:'Expected JSON'});
  const chunks=[];
  let size=0;
  for await(const chunk of request){
    size+=chunk.length;
    if(size>16000)return json(response,413,{error:'Request too large'});
    chunks.push(chunk);
  }
  let input;
  try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return json(response,400,{error:'Invalid JSON'});}
  const fields=normalizedEnquiry(input);
  if(!fields)return json(response,400,{error:'Invalid enquiry'});
  const saved=await createEnquiry(inbox,fields);
  if(!saved)return json(response,409,{error:'Reference already in use'});
  json(response,201,{reference:fields.reference});
}
function enquiryOrigin(request,response){
  const origin=request.headers.origin;
  if(!origin)return true;
  const allowed=(process.env.NORTHGO_FRONTEND_ORIGINS||'').split(',').map(value=>value.trim()).filter(Boolean);
  try{
    if(new URL(origin).host===request.headers.host)return true;
    if(!allowed.includes(origin))return false;
    response.setHeader('Access-Control-Allow-Origin',origin);
    response.setHeader('Vary','Origin');
    response.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers','Content-Type');
    return true;
  }catch{return false;}
}
const server=createServer(async(request,response)=>{
  response.setHeader('X-Content-Type-Options','nosniff');
  response.setHeader('X-Frame-Options','DENY');
  response.setHeader('Referrer-Policy','same-origin');
  try{
    const url=new URL(request.url,'http://localhost');
    if(url.pathname==='/api/enquiries'){
      if(!enquiryOrigin(request,response))return json(response,403,{error:'Invalid origin'});
      if(request.method==='OPTIONS'){response.writeHead(204);return response.end();}
      if(request.method==='POST')return await receive(request,response);
    }
    if(url.pathname==='/api/admin'||url.pathname.startsWith('/api/admin/')){
      response.setHeader('Cache-Control','no-store');
      return await adminApi(request,response,url,{db,inbox,json});
    }
    if(url.pathname==='/api/version'&&request.method==='GET'){
      return json(response,200,{version:(await readFile(resolve(project,'VERSION'),'utf8')).trim()});
    }
    if(!['GET','HEAD'].includes(request.method))return json(response,405,{error:'Method not allowed'});
    const adminFiles={
      '/admin':'index.html','/admin/':'index.html','/admin/index.html':'index.html',
      '/admin/admin.css':'admin.css','/admin/admin.js':'admin.js'
    };
    if(Object.hasOwn(adminFiles,url.pathname)){
      const file=resolve(project,'admin',adminFiles[url.pathname]);
      response.setHeader('Cache-Control','no-store');
      response.setHeader('X-Robots-Tag','noindex, nofollow');
      response.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
      response.writeHead(200,{'Content-Type':types[extname(file)]});
      if(request.method==='HEAD')return response.end();
      return createReadStream(file).pipe(response);
    }
    const locale=url.pathname.match(/^\/(zh-tw|en|ja|vi)(?=\/|$)/)?.[1];
    const oldPath=(locale?url.pathname.slice(locale.length+1):url.pathname).replace(/\/$/,'');
    if(routes[oldPath]){
      response.writeHead(301,{Location:routes[oldPath].replace('/en/','/'+(locale||'en')+'/')+url.search});return response.end();
    }
    let file=resolve(root,'.'+decodeURIComponent(url.pathname));
    if(file!==root&&!file.startsWith(root+sep))return json(response,404,{error:'Not found'});
    if((await stat(file)).isDirectory())file=resolve(file,'index.html');
    const info=await stat(file);
    response.writeHead(200,{'Content-Type':types[extname(file)]||'application/octet-stream','Content-Length':info.size});
    if(request.method==='HEAD')return response.end();
    createReadStream(file).pipe(response);
  }catch(error){
    if(!response.headersSent)json(response,error.code==='ENOENT'?404:500,{error:error.code==='ENOENT'?'Not found':'Server error'});
    else response.end();
    if(error.code!=='ENOENT')console.error(error.code||error.name);
  }
});
server.listen(port,process.env.NORTHGO_HOST||'127.0.0.1',()=>{
  const actualPort=server.address().port;
  console.log('Northgo: http://127.0.0.1:'+actualPort);
  console.log('Admin: http://127.0.0.1:'+actualPort+'/admin/');
});
