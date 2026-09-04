// Stable domains; never infer routing from translated message text.
export const TELEGRAM_CATEGORIES = Object.freeze(['infrastructure', 'catalogue', 'finance', 'partners', 'support', 'growth']);

export function telegramCredentials(env, category = 'infrastructure') {
  if (!TELEGRAM_CATEGORIES.includes(category)) throw new Error('telegram_invalid_category');
  const prefix = `TELEGRAM_${category.toUpperCase()}`;
  const token = env.get(`${prefix}_BOT_TOKEN`) || '';
  const chatId = env.get(`${prefix}_CHAT_ID`) || '';
  // A partially configured dedicated route must never leak into another bot.
  if (token || chatId) return { token, chatId };
  // Compatibility during staged deployment only. Strict mode is enabled after
  // all six routes have been verified, so a missing route becomes observable.
  if (env.get('TELEGRAM_CATEGORY_ROUTING_STRICT') === '1') return { token: '', chatId: '' };
  return { token: env.get('TELEGRAM_BOT_TOKEN') || '', chatId: env.get('TELEGRAM_CHAT_ID') || '' };
}

export function cronTelegramCategory(name) {
  if (/partners|affiliate|kyc/i.test(name)) return 'partners';
  if (/revolut|stancer|billing|vat/i.test(name)) return 'finance';
  if (/support/i.test(name)) return 'support';
  if (/signup|lifecycle|notification-center|weekly-digest/i.test(name)) return 'growth';
  if (/source|catalog|playback|language|lid|metadata|tmdb|relay/i.test(name)) return 'catalogue';
  return 'infrastructure';
}

export function opsTelegramCategory(key) {
  if (key.startsWith('cron:')) return cronTelegramCategory(key.slice(5));
  if (key.startsWith('partners_')) return 'partners';
  if (/^(sources_|lid_|gateway_|relay_)/.test(key)) return 'catalogue';
  if (/^(billing_|revolut_|vat_)/.test(key)) return 'finance';
  if (key.startsWith('support_')) return 'support';
  if (key.startsWith('growth_')) return 'growth';
  return 'infrastructure';
}

export function groupOpsNotifications(items, categoryFor = (item) => opsTelegramCategory(item.key)) {
  return TELEGRAM_CATEGORIES.map(category => ({category, items: items.filter(item => categoryFor(item) === category)}))
    .filter(group => group.items.length);
}

// Keep each escaped HTML line intact. Oversize messages become explicit plain
// text chunks: no dangling tag/entity and no silently truncated incidents.
export function telegramMessageChunks(text, limit = 3900) {
  if (text.length <= limit) return [{text, parse_mode: 'HTML'}];
  const plain = text.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const points = Array.from(plain), chunks = [];
  while (points.length) chunks.push({text: points.splice(0, Math.floor(limit / 2)).join('')});
  return chunks;
}
