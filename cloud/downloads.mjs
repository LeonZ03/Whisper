import { fail, SECURITY_HEADERS } from './security.mjs';
// Static Assets caps each file at 25 MiB. Stream verified build-time chunks as
// the original ZIP so the existing command installer remains compatible.
export async function serveClientArchive(request,env) {
  if(!['GET','HEAD'].includes(request.method))fail(405,'请求方法不支持。');
  const origin=new URL(request.url).origin;
  const response=await env.ASSETS.fetch(new Request(origin+'/downloads/manifest.json'));
  if(!response.ok)fail(503,'客户端发布包尚未准备好。');
  const manifest=await response.json();
  if(!Array.isArray(manifest.chunks)||manifest.chunks.length>16||!Number.isSafeInteger(manifest.bytes))fail(503,'无效的发布清单。');
  for(const part of manifest.chunks)if(!/^[a-f0-9]{64}\.part$/.test(part))fail(503,'无效的分片路径。');
  const headers={...SECURITY_HEADERS,'Content-Type':'application/zip','Content-Length':String(manifest.bytes),
    'Content-Disposition':'attachment; filename="whisper-cli-windows-x64.zip"','ETag':'"'+manifest.sha256+'"'};
  if(request.method==='HEAD')return new Response(null,{headers});
  let index=0,reader=null;
  const body=new ReadableStream({
    async pull(controller) {
      try { while(true) {
        if(!reader) {
          if(index===manifest.chunks.length){controller.close();return;}
          const r=await env.ASSETS.fetch(new Request(origin+'/downloads/chunks/'+manifest.chunks[index++]));
          if(!r.ok||!r.body)throw new Error('Missing release chunk'); reader=r.body.getReader();
        }
        const next=await reader.read();
        if(next.done){reader.releaseLock();reader=null;continue;}
        controller.enqueue(next.value);return;
      }}catch(error){controller.error(error);}
    }, async cancel(){await reader?.cancel();}
  }); return new Response(body,{headers});
}
