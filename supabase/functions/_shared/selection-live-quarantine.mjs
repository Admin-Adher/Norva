// Targeted failures observed in Norva on 2026-09-05 and rechecked upstream on
// 2026-09-06. This list does not classify untested channels or retire a feed.
// Re-admission requires a new playback review; a changed URL has a new identity.
export const SELECTION_LIVE_QUARANTINE = Object.freeze([
  { feedId: 'iptv-org', externalId: 'norva-discovery:live:8c0d371f9734afd7421b764097ae909ab27beee1535e371b8d022c9fa3f1d384', mediaKeySha256: 'd5acc09fdf0679273ef26bc1edb17bf6855beee9db7d315f1e86d459b7bb33d9', targetUrlSha256: 'd5acc09fdf0679273ef26bc1edb17bf6855beee9db7d315f1e86d459b7bb33d9', reason: 'repeated-playback-starvation' },
  { feedId: 'iptv-org', externalId: 'norva-discovery:live:8ef885b5c6375338a80c1e81a6e64283ac98a6c711b512f2c6170501c291d0c2', mediaKeySha256: 'f9e290b2a56507307e3c98dc66647ba6f850eb68b7f0d2c3ed134b1b497761a5', targetUrlSha256: 'f9e290b2a56507307e3c98dc66647ba6f850eb68b7f0d2c3ed134b1b497761a5', reason: 'startup-failed-and-upstream-timeout' },
  { feedId: 'iptv-org', externalId: 'norva-discovery:live:0ae23ca960d38dad3b947953f9b8d2fb93b34dbebfc9419f9fcea59274b9e366', mediaKeySha256: 'ff5d8d0336db439f8580d6c1c63cd18cd20cce6a0ee31a1539eed28c078d6ed8', targetUrlSha256: 'ff5d8d0336db439f8580d6c1c63cd18cd20cce6a0ee31a1539eed28c078d6ed8', reason: 'startup-failed-and-upstream-timeout' },
  { feedId: 'iptv-org', externalId: 'norva-discovery:live:2b310e03831c317d2dec2f489cd086e875a95d692090988b8bfba0cd495b6b3d', mediaKeySha256: 'a13bb107926785f6acf10b4a5b66d084064f5eac99d88dd1e213c67cb20df0dd', targetUrlSha256: 'a13bb107926785f6acf10b4a5b66d084064f5eac99d88dd1e213c67cb20df0dd', reason: 'startup-failed-and-upstream-refused' },
].map(Object.freeze));

export function matchesSelectionLiveQuarantine(identity) {
  return !!identity && SELECTION_LIVE_QUARANTINE.some(entry =>
    ['feedId', 'externalId', 'mediaKeySha256', 'targetUrlSha256'].every(key =>
      typeof identity[key] === 'string' && identity[key] === entry[key]));
}
