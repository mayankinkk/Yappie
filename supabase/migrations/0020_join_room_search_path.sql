-- 0020: fix join_room search_path so crypt() resolves on hosted Supabase.
--
-- Root cause: pgcrypto lives in the `extensions` schema. 0005/0013 set
-- `join_room` to `search_path = public, extensions`, but 0017_room_settings.sql
-- redefined the function with `set search_path = public` (no `extensions`),
-- overwriting that fix. `join_room` is the only crypt-calling function with the
-- broken path, so every password-verified join raised
-- `42883: function crypt(text, text) does not exist` — the client mapped that
-- to the `unknown` branch ("Something went wrong") instead of the wrong-password
-- error.
--
-- Idempotent: the DO block only issues the ALTER when the path is actually
-- missing `extensions`, so re-running is safe.
DO $$
DECLARE
  v_proconfig text[];
BEGIN
  SELECT proconfig INTO v_proconfig
  FROM pg_proc
  WHERE proname = 'join_room'
    AND pronamespace = 'public'::regnamespace
    AND pg_get_function_identity_arguments(oid) = 'p_code text, p_password text, p_name text';

  IF v_proconfig IS NULL OR NOT EXISTS (
    SELECT 1 FROM unnest(v_proconfig) AS cfg WHERE cfg LIKE '%extensions%'
  ) THEN
    EXECUTE 'alter function public.join_room(text, text, text) set search_path = public, extensions';
  END IF;
END $$;

-- create_room already has the correct path (public, extensions) — verified live
-- during diagnosis. Leave it untouched unless a re-run shows it degraded.
DO $$
DECLARE
  v_proconfig text[];
BEGIN
  SELECT proconfig INTO v_proconfig
  FROM pg_proc
  WHERE proname = 'create_room'
    AND pronamespace = 'public'::regnamespace
    AND pg_get_function_identity_arguments(oid) = 'p_password text, p_name text';

  IF v_proconfig IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM unnest(v_proconfig) AS cfg WHERE cfg LIKE '%extensions%'
  ) THEN
    EXECUTE 'alter function public.create_room(text, text) set search_path = public, extensions';
  END IF;
END $$;
