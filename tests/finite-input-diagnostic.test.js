const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
test('finite input diagnostics retain only bounded upstream status and boolean retryability', () => {
    const source = fs.readFileSync(require.resolve('../services/media-gateway/src/index.js'), 'utf8');
    const start = source.indexOf("console.warn('[media-gateway] unable to bound finite MKV input:'");
    const code = source.slice(start, source.indexOf("if (err?.upstreamStatus === 404", start));
    for (const [value, expected] of [[404,404],[503,503],[0,null],[600,null],['https://secret',null],[null,null]]) {
        let captured;
        vm.runInNewContext(code, {err:{upstreamStatus:value,retryable:true,message:'test'},sourceUrl:'',sanitizeLog:()=> 'safe', console:{warn:(...args)=>{captured=args[2];}}});
        assert.equal(captured.upstreamStatus, expected);
        assert.equal(captured.retryable, true);
        assert.deepEqual(Object.keys(captured), ['upstreamStatus','retryable']);
    }
});

test('only an exact provider 404 becomes a public file-unavailable response', () => {
    const source = fs.readFileSync(require.resolve('../services/media-gateway/src/index.js'), 'utf8');
    const start = source.indexOf("if (err?.upstreamStatus === 404");
    const code = source.slice(start, source.indexOf('// Cold playback owns', start));
    const body = code.slice(0, code.lastIndexOf('}'));
    for (const [status, errorCode, expected] of [[404,'PROVIDER_REQUEST_FAILED',404],[403,'PROVIDER_REQUEST_FAILED',502],[503,'PROVIDER_REQUEST_FAILED',502],[404,'PROXY_AUTH_FAILED',502],['404','PROVIDER_REQUEST_FAILED',502]]) {
        let result;
        vm.runInNewContext('(function(){'+body+'})()', {err:{upstreamStatus:status,code:errorCode},res:{status:s=>({json:payload=>{result={status:s,payload};}})}});
        assert.equal(result.status, expected);
        if (expected===404) assert.deepEqual(JSON.parse(JSON.stringify(result.payload)),{error:'Media file not found on the provider (404).',code:'PROVIDER_HTTP_ERROR'});
    }
});

test('Edge preserves the bounded 404 message through both sanitization boundaries', async () => {
    const source=fs.readFileSync(require.resolve('../supabase/functions/norva-playback/index.ts'),'utf8');
    const start=source.indexOf('if (response.status === 404 && gatewayBody.code === "PROVIDER_HTTP_ERROR")');
    const body=source.slice(start,source.indexOf('throw new HttpError(response.status, "Media gateway refused the session"',start));
    class HttpError extends Error {constructor(status,message,details){super(message);this.status=status;this.details=details;}}
    let error;
    try { vm.runInNewContext(body,{response:{status:404},gatewayBody:{code:'PROVIDER_HTTP_ERROR',url:'https://private'},HttpError}); } catch(e){error=e;}
    const {publicEdgeErrorPayload}=await import('../supabase/functions/_shared/catalog-visibility-response.mjs');
    const payload=publicEdgeErrorPayload(error,404);
    assert.match(payload.error,/not found.*404/);
    assert.deepEqual(payload.details,{code:'PROVIDER_HTTP_ERROR'});
    assert.doesNotMatch(JSON.stringify(payload),/private/);
});
