-- Per-message chat reactions. Shape: { "👍": ["uuid", ...], "❤️": [...] }
-- The toggle is a single SECURITY DEFINER RPC with FOR UPDATE row locking so
-- concurrent toggles from different members serialize instead of clobbering
-- each other's jsonb writes. Direct client UPDATEs stay impossible: chat RLS
-- has no UPDATE policy.

alter table public.chat_messages
  add column if not exists reactions jsonb not null default '{}';

create or replace function public.toggle_chat_reaction(
  p_code text,
  p_message_id text,
  p_emoji text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_code text := upper(trim(coalesce(p_code, '')));
  v_emoji text := left(coalesce(p_emoji, ''), 8);
  v_reactions jsonb;
  v_ids jsonb;
  v_has boolean;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  if v_emoji = '' then
    raise exception 'invalid_emoji';
  end if;
  if not public.is_member(v_code) then
    raise exception 'not_member';
  end if;

  select reactions into v_reactions
  from public.chat_messages
  where room_code = v_code and id = p_message_id
  for update;

  if not found then
    raise exception 'not_found';
  end if;

  v_ids := coalesce(v_reactions -> v_emoji, '[]'::jsonb);
  v_has := v_ids ? v_uid::text;

  if v_has then
    v_ids := (
      select coalesce(jsonb_agg(x), '[]'::jsonb)
      from jsonb_array_elements_text(v_ids) x
      where x <> v_uid::text
    );
  else
    v_ids := v_ids || to_jsonb(v_uid::text);
  end if;

  if jsonb_array_length(v_ids) = 0 then
    v_reactions := v_reactions - v_emoji;
  else
    v_reactions := jsonb_set(v_reactions, array[v_emoji], v_ids);
  end if;

  update public.chat_messages
  set reactions = v_reactions
  where room_code = v_code and id = p_message_id;

  return v_reactions;
end;
$$;

grant execute on function public.toggle_chat_reaction(text, text, text) to authenticated;
