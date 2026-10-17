-- Host-only chat moderation: delete any message in their room.
-- Mirrors moderate_member's guard style. RLS keeps direct client DELETEs on
-- chat_messages impossible; removal goes through this SECURITY DEFINER path
-- and reaches everyone else via realtime DELETE events on the room channel.

create or replace function public.delete_chat_message(p_code text, p_message_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_code text := upper(trim(coalesce(p_code, '')));
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  if not exists (select 1 from public.rooms where code = v_code and host_id = v_uid) then
    raise exception 'not_host';
  end if;
  delete from public.chat_messages
  where room_code = v_code and id = p_message_id;
end;
$$;

grant execute on function public.delete_chat_message(text, text) to authenticated;
