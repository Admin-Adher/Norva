-- Visuel de campagne : plafond du bucket porté à 10 Mo (2026-07-18).
--
-- Les artworks générés (PNG sans perte) dépassent facilement 2 Mo. Le vrai
-- garde-fou est désormais CÔTÉ ADMIN : l'image est optimisée dans le navigateur
-- avant l'envoi (max 2560 px, WebP qualité ~0.85 → typiquement 150-500 Ko),
-- donc ce plafond n'est qu'un filet pour le cas où l'optimisation échoue.
-- Idempotent. supabase_admin. Pas de NOTIFY (config bucket, pas de schéma REST).

update storage.buckets set file_size_limit = 10485760 where id = 'promo-assets';
