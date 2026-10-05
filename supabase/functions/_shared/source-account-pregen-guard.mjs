/** A false, authenticated SQL result is the only permission to pass this gate. */
export async function sourceAccountPregenActive(db, userId, sourceId) {
    if (!userId || !sourceId) return true;
    try {
        const { data, error } = await db.rpc('catalog_source_account_pregen_active', {
            p_user_id: userId,
            p_source_id: sourceId,
        });
        return Boolean(error) || data !== false;
    } catch (_) {
        return true;
    }
}
