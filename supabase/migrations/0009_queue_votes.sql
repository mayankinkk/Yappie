-- Guest voting on queue items. Votes live inside rooms.queue jsonb
-- ({ userId: true } per item) so they ride the existing queue_version /
-- applyRoomRow delivery path — no extra table or subscription. SECURITY
-- DEFINER + FOR UPDATE serializes concurrent voters; returns the updated
-- queue and version so the caller can apply state without waiting for the
-- realtime echo.

create or replace function public.vote_queue_item(p_code text, p_item_id text)
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
  v_idx integer := -1;
  v_item jsonb;
  v_votes jsonb;
  v_elem jsonb;
  v_ord integer;
  v_new_queue jsonb;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  if not public.is_member(v_code) then
    raise exception 'not_member';
  end if;

  select queue, queue_version into v_queue, v_version
  from public.rooms
  where code = v_code
  for update;

  if not found then
    raise exception 'not_found';
  end if;

  for v_elem, v_ord in
    select elem, ord from jsonb_array_elements(coalesce(v_queue, '[]'::jsonb))
      with ordinality as t(elem, ord)
  loop
    if coalesce(v_elem ->> 'id', '') = p_item_id then
      v_idx := v_ord;
      v_item := v_elem;
      exit;
    end if;
  end loop;

  if v_idx < 0 then
    raise exception 'not_found';
  end if;

  v_votes := coalesce(v_item -> 'votes', '{}'::jsonb);
  if v_votes ? v_uid::text then
    v_votes := v_votes - v_uid::text;
  else
    v_votes := v_votes || jsonb_build_object(v_uid::text, true);
  end if;
  v_item := v_item || jsonb_build_object('votes', v_votes);

  select coalesce(
    jsonb_agg(
      case when t.ord = v_idx then v_item else t.elem end
      order by t.ord
    ),
    '[]'::jsonb
  )
  into v_new_queue
  from jsonb_array_elements(coalesce(v_queue, '[]'::jsonb))
    with ordinality as t(elem, ord);

  update public.rooms
  set queue = v_new_queue,
      queue_version = v_version + 1
  where code = v_code
  returning queue, queue_version into v_queue, v_version;

  return jsonb_build_object('queue', v_queue, 'queueVersion', v_version);
end;
$$;

grant execute on function public.vote_queue_item(text, text) to authenticated;
