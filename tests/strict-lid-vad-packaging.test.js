const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const source = fs.readFileSync('ops/hetzner/media/Dockerfile.strict-lid-vad', 'utf8').replace(/\r\n/g, '\n');
const gateway = fs.readFileSync('services/media-gateway/Dockerfile', 'utf8').replace(/\r\n/g, '\n');

test('standalone VAD uses the gateway pinned source and a bounded static CPU build', () => {
    const commit = /^ARG WHISPER_CPP_COMMIT=([a-f0-9]{40})$/m.exec(gateway)?.[1];
    assert.ok(commit);
    assert.ok(source.includes(`ARG WHISPER_CPP_COMMIT=${commit}`));
    assert.ok(source.includes(`test "\${WHISPER_CPP_COMMIT}" = "${commit}"`));
    assert.match(source, /^FROM debian:bookworm-slim AS build$/m);
    assert.match(source, /--parallel 2 --config Release --target whisper-vad-speech-segments/);
    for (const option of ['BUILD_SHARED_LIBS', 'GGML_NATIVE', 'GGML_BACKEND_DL',
        'GGML_OPENMP', 'GGML_BLAS', 'GGML_VULKAN', 'GGML_CUDA', 'GGML_METAL']) {
        assert.ok(source.includes(`-D${option}=OFF`), option);
    }
    assert.match(source, /CMAKE_EXE_LINKER_FLAGS="-static -static-libgcc -static-libstdc\+\+"/);
    assert.match(source, /! readelf -l build\/bin\/whisper-vad-speech-segments \| grep -q INTERP/);
});

test('VAD artifact exports only the selector binary and its build identity', () => {
    const artifact = source.split('FROM scratch AS artifact\n')[1];
    assert.ok(artifact);
    assert.equal((artifact.match(/^COPY /gm) || []).length, 3);
    assert.ok(artifact.includes('/usr/local/bin/whisper-vad-speech-segments'));
    assert.ok(artifact.includes('/opt/whisper/vad-bin.sha256'));
    assert.ok(artifact.includes('/opt/whisper/vad-commit'));
    assert.match(source, /sha256sum \/artifact\/whisper-vad-speech-segments/);
    assert.doesNotMatch(source, /download-.*model|nvidia|libvulkan|libopenblas|glslc/);
    assert.doesNotMatch(artifact, /^(?:RUN|CMD|ENTRYPOINT|ENV|EXPOSE) /m);
});
