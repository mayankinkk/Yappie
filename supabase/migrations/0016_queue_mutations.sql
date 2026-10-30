-- 0016: server-authoritative queue add/remove.
-- Apply after 0015 (`supabase db push` or paste into the SQL editor).
--
-- Adds and removes used to route through the host's browser: guests
-- broadcast queue-add/queue-remove and the host client decided what to
-- apply — a modified client could forge `by` and delete anyone's item, and
-- every mutation was lost while the host was offline (the guest still saw
-- "Requested to add to queue"). Both now run through SECURITY DEFINER RPCs
-- in the shape of vote_queue_item (0009): member-gated, serialized by the
-- row lock, authorization checked server-side (addedBy = auth.uid();
-- removal by host or adder only), queue_version bumped so the realtime
-- rooms UPDATE echoes the result to every member — no host client required.
--
-- Contract (client maps errors in rooms-api.ts mapError):
--   add_queue_item    → { queue, queueVersion } | not_authenticated,
--                       not_member, not_found, invalid_item, invalid_video,
--                       already_queued, queue_full
--   remove_queue_item → { queue, queueVersion } | not_authenticated,
--                       not_member, not_found, not_allowed

create or replace function public.add_queue_item(
  p_code text,
  p_item_id text,
  p_video_id text,
  p_title text default null,
  p_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_code text := upper(trim(coalesce(p_code, '')));
  v_queue jsonb;
  v_version integer;
  v_member_name text;
  v_item jsonb;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  if not public.is_member(v_code) then
    raise exception 'not_member';
  end if;
  if coalesce(p_item_id, '') !~ '^[\w-]{1,64}$' then
    raise exception 'invalid_item';
  end if;
  if coalesce(p_video_id, '') !~ '^[\w-]{11}$' then
    raise exception 'invalid_video';
  end if;

  select queue, queue_version into v_queue, v_version
  from public.rooms
  where code = v_code
  for update;

  if not found then
    raise exception 'not_found';
  end if;

  v_queue := coalesce(v_queue, '[]'::jsonb);

  if exists (
    select 1 from jsonb_array_elements(v_queue) as t(elem)
    where t.elem ->> 'videoId' = p_video_id
  ) then
    raise exception 'already_queued';
  end if;

  if jsonb_array_length(v_queue) >= 50 then
    raise exception 'queue_full';
  end if;

  -- Display name: the sender's current profile wins, membership row is the
  -- fallback. Purely cosmetic (the security-relevant addedBy is auth.uid()).
  select left(nullif(trim(m.display_name), ''), 24) into v_member_name
  from public.room_members m
  where m.room_code = v_code and m.user_id = v_uid;

  v_item := jsonb_build_object(
    'id', p_item_id,
    'videoId', p_video_id,
    'title', nullif(coalesce(p_title, ''), ''),
    'addedBy', v_uid,
    'addedByName', left(coalesce(nullif(trim(p_name), ''), v_member_name, 'Guest'), 24),
    'addedAt', floor(extract(epoch from now()) * 1000),
    'votes', '{}'::jsonb
  );

  update public.rooms
  set queue = v_queue || jsonb_build_array(v_item),
      queue_version = v_version + 1
  where code = v_code
  returning queue, queue_version into v_queue, v_version;

  return jsonb_build_object('queue', v_queue, 'queueVersion', v_version);
end;
$$;

create or replace function public.remove_queue_item(p_code text, p_item_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_code text := upper(trim(coalesce(p_code, '')));
  v_room public.rooms%rowtype;
  v_queue jsonb;
  v_elem jsonb;
  v_added_by text;
  v_version integer;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  if not public.is_member(v_code) then
    raise exception 'not_member';
  end if;

  select * into v_room
  from public.rooms
  where code = v_code
  for update;

  if not found then
    raise exception 'not_found';
  end if;

  v_queue := coalesce(v_room.queue, '[]'::jsonb);

  select t.elem into v_elem
  from jsonb_array_elements(v_queue) as t(elem)
  where t.elem ->> 'id' = p_item_id
  limit 1;

  if v_elem is null then
    raise exception 'not_found';
  end if;

  -- Authorization: the host may remove anything, a member only what they
  -- added. Compared against the stored row — the caller can't forge it.
  v_added_by := v_elem ->> 'addedBy';
  if v_room.host_id is distinct from v_uid and v_added_by is distinct from v_uid::text then
    raise exception 'not_allowed';
  end if;

  update public.rooms
  set queue = (
        select coalesce(jsonb_agg(t.elem), '[]'::jsonb)
        from jsonb_array_elements(v_queue) as t(elem)
        where t.elem ->> 'id' <> p_item_id
      ),
      queue_version = queue_version + 1
  where code = v_code
  returning queue, queue_version into v_queue, v_version;

  return jsonb_build_object('queue', v_queue, 'queueVersion', v_version);
end;
$$;

grant execute on function public.add_queue_item(text, text, text, text, text) to authenticated;
grant execute on function public.remove_queue_item(text, text) to authenticated;
