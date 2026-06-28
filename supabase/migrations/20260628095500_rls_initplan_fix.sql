-- A3 (free perf lever): fix the 26 `auth_rls_initplan` advisor warnings.
--
-- Every hot-table RLS policy used `auth.uid()` (or `auth.role()`/`auth.jwt()`)
-- bare, so Postgres re-evaluated it ONCE PER ROW scanned. Wrapping the call in a
-- scalar subquery `(SELECT auth.uid())` makes the planner evaluate it ONCE per
-- query (an InitPlan) — a pure speedup on every authenticated read/write, biggest
-- on the high-row-count owner (the 272k-item provider). The predicate is
-- logically identical, so access control is unchanged and the change is fully
-- reversible. Statements were generated from the live pg_policies definitions
-- (exact expressions preserved, only the auth.* calls wrapped).
--
-- Ref: https://supabase.com/docs/guides/database/database-linter?lint=0003_auth_rls_initplan

ALTER POLICY cloud_account_profiles_owner_all ON public.cloud_account_profiles USING ((user_id = (SELECT auth.uid()))) WITH CHECK ((user_id = (SELECT auth.uid())));
ALTER POLICY cloud_cast_commands_owner_all ON public.cloud_cast_commands USING ((user_id = (SELECT auth.uid()))) WITH CHECK (((user_id = (SELECT auth.uid())) AND ((source_device_id IS NULL) OR (EXISTS ( SELECT 1
   FROM cloud_devices d
  WHERE ((d.id = cloud_cast_commands.source_device_id) AND (d.user_id = (SELECT auth.uid())))))) AND ((target_device_id IS NULL) OR (EXISTS ( SELECT 1
   FROM cloud_devices d
  WHERE ((d.id = cloud_cast_commands.target_device_id) AND (d.user_id = (SELECT auth.uid()))))))));
ALTER POLICY cloud_devices_owner_all ON public.cloud_devices USING ((user_id = (SELECT auth.uid()))) WITH CHECK ((user_id = (SELECT auth.uid())));
ALTER POLICY "Users can read own entitlement events" ON public.cloud_entitlement_events USING (((SELECT auth.uid()) = user_id));
ALTER POLICY "Users can read own entitlement projection" ON public.cloud_entitlement_projection USING (((SELECT auth.uid()) = user_id));
ALTER POLICY cloud_favorites_owner_all ON public.cloud_favorites USING ((user_id = (SELECT auth.uid()))) WITH CHECK (((user_id = (SELECT auth.uid())) AND (EXISTS ( SELECT 1
   FROM cloud_sources s
  WHERE ((s.id = cloud_favorites.source_id) AND (s.user_id = (SELECT auth.uid())))))));
ALTER POLICY cloud_gateway_sessions_select_own ON public.cloud_gateway_sessions USING ((user_id = (SELECT auth.uid())));
ALTER POLICY cloud_gateway_sessions_update_own ON public.cloud_gateway_sessions USING ((user_id = (SELECT auth.uid()))) WITH CHECK ((user_id = (SELECT auth.uid())));
ALTER POLICY cloud_live_logical_channels_select_own ON public.cloud_live_logical_channels USING ((user_id = (SELECT auth.uid())));
ALTER POLICY cloud_live_variants_select_own ON public.cloud_live_variants USING ((user_id = (SELECT auth.uid())));
ALTER POLICY cloud_media_items_owner_all ON public.cloud_media_items USING ((user_id = (SELECT auth.uid()))) WITH CHECK (((user_id = (SELECT auth.uid())) AND (EXISTS ( SELECT 1
   FROM cloud_sources s
  WHERE ((s.id = cloud_media_items.source_id) AND (s.user_id = (SELECT auth.uid())))))));
ALTER POLICY cloud_pairing_sessions_select_own ON public.cloud_pairing_sessions USING ((user_id = (SELECT auth.uid())));
ALTER POLICY cloud_pairing_sessions_update_own ON public.cloud_pairing_sessions USING ((user_id = (SELECT auth.uid()))) WITH CHECK ((user_id = (SELECT auth.uid())));
ALTER POLICY cloud_playback_events_insert_own ON public.cloud_playback_events WITH CHECK (((user_id = (SELECT auth.uid())) AND ((source_id IS NULL) OR (EXISTS ( SELECT 1
   FROM cloud_sources s
  WHERE ((s.id = cloud_playback_events.source_id) AND (s.user_id = (SELECT auth.uid())))))) AND ((device_id IS NULL) OR (EXISTS ( SELECT 1
   FROM cloud_devices d
  WHERE ((d.id = cloud_playback_events.device_id) AND (d.user_id = (SELECT auth.uid())) AND (d.revoked = false))))) AND ((playback_session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM cloud_playback_sessions p
  WHERE ((p.id = cloud_playback_events.playback_session_id) AND (p.user_id = (SELECT auth.uid()))))))));
ALTER POLICY cloud_playback_events_select_own ON public.cloud_playback_events USING ((user_id = (SELECT auth.uid())));
ALTER POLICY cloud_playback_sessions_select_own ON public.cloud_playback_sessions USING ((user_id = (SELECT auth.uid())));
ALTER POLICY cloud_playback_sessions_update_own ON public.cloud_playback_sessions USING ((user_id = (SELECT auth.uid()))) WITH CHECK ((user_id = (SELECT auth.uid())));
ALTER POLICY cloud_profiles_insert_own ON public.cloud_profiles WITH CHECK ((id = (SELECT auth.uid())));
ALTER POLICY cloud_profiles_select_own ON public.cloud_profiles USING ((id = (SELECT auth.uid())));
ALTER POLICY cloud_profiles_update_own ON public.cloud_profiles USING ((id = (SELECT auth.uid()))) WITH CHECK ((id = (SELECT auth.uid())));
ALTER POLICY cloud_relay_tokens_select_own ON public.cloud_relay_tokens USING ((user_id = (SELECT auth.uid())));
ALTER POLICY cloud_sources_owner_all ON public.cloud_sources USING ((user_id = (SELECT auth.uid()))) WITH CHECK ((user_id = (SELECT auth.uid())));
ALTER POLICY cloud_title_overrides_owner_all ON public.cloud_title_overrides USING (((SELECT auth.uid()) = user_id)) WITH CHECK (((SELECT auth.uid()) = user_id));
ALTER POLICY cloud_title_variants_owner_select ON public.cloud_title_variants USING (((SELECT auth.uid()) = user_id));
ALTER POLICY cloud_titles_owner_select ON public.cloud_titles USING (((SELECT auth.uid()) = user_id));
ALTER POLICY cloud_watch_history_owner_all ON public.cloud_watch_history USING ((user_id = (SELECT auth.uid()))) WITH CHECK (((user_id = (SELECT auth.uid())) AND ((source_id IS NULL) OR (EXISTS ( SELECT 1
   FROM cloud_sources s
  WHERE ((s.id = cloud_watch_history.source_id) AND (s.user_id = (SELECT auth.uid()))))))));
