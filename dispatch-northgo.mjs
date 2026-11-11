import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const project=fileURLToPath(new URL('./',import.meta.url));
const inbox=resolve(process.env.NORTHGO_INBOX_DIR||resolve(project,'.northgo-inbox'));
const endpoint=new URL(process.env.NORTHGO_ENQUIRY_WEBHOOK||'https://example.invalid');
if(!process.env.NORTHGO_ENQUIRY_WEBHOOK||endpoint.protocol!=='https:'||endpoint.username||endpoint.password){
  console.error('Set NORTHGO_ENQUIRY_WEBHOOK to the approved HTTPS receipt endpoint.');
  process.exit(1);
}
const token=process.env.NORTHGO_ENQUIRY_TOKEN;
const files=await readdir(inbox).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
let sent=0,failed=0;
for(const name of files.filter(name=>/^[a-f0-9]{32}\.json$/.test(name))){
  const file=resolve(inbox,name);
  const record=JSON.parse(await readFile(file,'utf8'));
  if(record.status==='delivered')continue;
  const headers={'Content-Type':'application/json','Idempotency-Key':record.reference};
  if(token)headers.Authorization='Bearer '+token;
  const {attempts=[],status,...enquiry}=record;
  const attempt={at:new Date().toISOString(),result:'network_error'};
  try{
    const response=await fetch(endpoint,{method:'POST',headers,body:JSON.stringify(enquiry),redirect:'error',signal:AbortSignal.timeout(10000)});
    attempt.result=response.status;
    if(response.ok){record.status='delivered';sent++;}
    else{record.status='delivery_failed';failed++;}
    await response.body?.cancel();
  }catch{
    record.status='delivery_failed';
    failed++;
  }
  record.attempts=[...attempts,attempt];
  const pending=resolve(inbox,randomUUID()+'.tmp');
  await writeFile(pending,JSON.stringify(record,null,2),{flag:'wx',mode:0o600});
  await rename(pending,file);
}
console.log('Delivered '+sent+'; pending retry '+failed+'.');
if(failed)process.exitCode=1;
