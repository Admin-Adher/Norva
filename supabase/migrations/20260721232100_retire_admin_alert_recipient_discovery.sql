-- Operational notifications must never discover recipients from product/Auth
-- accounts. norva-admin now sends email only to the explicit NORVA_OPS_EMAIL
-- environment variable and otherwise remains Telegram-only.

drop function if exists public.admin_alert_recipients();
