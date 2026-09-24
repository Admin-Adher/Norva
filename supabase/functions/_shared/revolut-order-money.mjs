// Revolut's legacy order endpoint can return either the older flat amount and
// currency fields or the nested order_amount object. Require provider fields;
// checkout metadata is only a claim to compare against them.
export function revolutOrderMoney(order) {
  const nested = order?.order_amount && typeof order.order_amount === 'object'
    && !Array.isArray(order.order_amount) ? order.order_amount : null;
  const parseAmount = (value) => {
    if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  };
  const parseCurrency = (value) => {
    const parsed = typeof value === 'string' ? value.toUpperCase() : '';
    return /^[A-Z]{3}$/.test(parsed) ? parsed : null;
  };
  const amountCents = parseAmount(nested ? nested.value : order?.amount);
  const currency = parseCurrency(nested ? nested.currency : order?.currency);
  if (nested && order?.amount != null && parseAmount(order.amount) !== amountCents) {
    return { amountCents: null, currency: null };
  }
  if (nested && order?.currency != null && parseCurrency(order.currency) !== currency) {
    return { amountCents: null, currency: null };
  }
  return { amountCents, currency };
}
