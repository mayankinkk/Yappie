-- pgcrypto ships in the `extensions` schema on new Supabase projects, but
-- create_room / join_room run with `set search_path = public`, so crypt(),
-- gen_salt(), and gen_random_bytes() didn't resolve (created rooms failed
-- with "function gen_random_bytes(integer) does not exist").
-- Widen those functions' search path instead of relocating the extension.
alter function public.create_room(text, text) set search_path = public, extensions;
alter function public.join_room(text, text, text) set search_path = public, extensions;
