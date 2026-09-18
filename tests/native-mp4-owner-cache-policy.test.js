const test = require('node:test');
const assert = require('node:assert/strict');

test('native MP4 owner pilot includes other owned providers without a global source promotion', async () => {
    const { useNativeMp4Gateway } = await import('../supabase/functions/_shared/native-mp4-gateway-policy.mjs');
    const base = { sourceId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', itemType: 'movie', container: 'mp4',
        ownerHash: 'a'.repeat(64), ownerAllowlist: 'a'.repeat(64) };
    assert.equal(useNativeMp4Gateway(base), true);
    for (const override of [{ ownerHash: 'b'.repeat(64) }, { ownerAllowlist: '' },
        { ownerAllowlist: `${base.ownerHash},invalid` }, { container: 'mkv' }, { itemType: 'live' }])
        assert.equal(useNativeMp4Gateway({ ...base, ...override }), false);
});
