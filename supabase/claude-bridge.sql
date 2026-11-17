-- Fast Edit <-> Claude connector relay. Run once in Supabase: SQL Editor -> New query -> paste -> Run.
-- Claude's connector (Vercel function api/mcp.mjs) queues commands; the user's open Fast Edit tab
-- takes them, runs them and posts results. Everything is keyed by a secret session code
-- (>= 32 chars) that only the user's tab and their connector URL know. Tables live in a
-- schema the API doesn't expose; only the functions below can touch them.
create schema if not exists fe_bridge;
revoke all on schema fe_bridge from public, anon, authenticated;

create table if not exists fe_bridge.cmd (
  id bigint generated always as identity primary key,
  session text not null,
  tool text not null,
  args jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending','taken','done')),
  result jsonb,
  created_at timestamptz not null default now(),
  done_at timestamptz
);
create index if not exists cmd_session_status_id on fe_bridge.cmd (session, status, id);
create index if not exists cmd_created_at on fe_bridge.cmd (created_at);

create table if not exists fe_bridge.tab (
  session text primary key,
  last_seen timestamptz not null default now(),
  info jsonb not null default '{}'::jsonb
);
alter table fe_bridge.cmd enable row level security;
alter table fe_bridge.tab enable row level security;

create or replace function fe_bridge.check_session(p text) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if p is null or length(p) < 32 or length(p) > 100 or p !~ '^[A-Za-z0-9_-]+$' then
    raise exception 'invalid session' using errcode = '22023';
  end if;
end $$;

-- connector: queue a command, returns its id (also clears anything older than an hour)
create or replace function public.fe_push(p_session text, p_tool text, p_args jsonb)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_id bigint;
begin
  perform fe_bridge.check_session(p_session);
  if p_tool !~ '^[a-z_]{1,40}$' or pg_column_size(p_args) > 20000 then raise exception 'bad command' using errcode = '22023'; end if;
  delete from fe_bridge.cmd where created_at < now() - interval '1 hour';
  delete from fe_bridge.tab where last_seen < now() - interval '1 day';
  if (select count(*) from fe_bridge.cmd c where c.session = p_session and c.status <> 'done') >= 20 then
    raise exception 'too many waiting commands' using errcode = '54000';
  end if;
  insert into fe_bridge.cmd (session, tool, args) values (p_session, p_tool, coalesce(p_args, '{}'::jsonb)) returning id into v_id;
  return v_id;
end $$;

-- connector: read a command's state
create or replace function public.fe_result(p_session text, p_id bigint)
returns table (status text, result jsonb) language plpgsql security definer set search_path = '' as $$
begin
  perform fe_bridge.check_session(p_session);
  return query select c.status, c.result from fe_bridge.cmd c where c.session = p_session and c.id = p_id;
end $$;

-- connector: when was the tab last seen, and what's open in it
create or replace function public.fe_tab(p_session text)
returns table (last_seen timestamptz, info jsonb) language plpgsql security definer set search_path = '' as $$
begin
  perform fe_bridge.check_session(p_session);
  return query select t.last_seen, t.info from fe_bridge.tab t where t.session = p_session;
end $$;

-- tab: heartbeat + take waiting commands
create or replace function public.fe_take(p_session text, p_info jsonb)
returns table (id bigint, tool text, args jsonb) language plpgsql security definer set search_path = '' as $$
begin
  perform fe_bridge.check_session(p_session);
  if pg_column_size(p_info) > 4000 then p_info := '{}'::jsonb; end if;
  insert into fe_bridge.tab as t (session, last_seen, info) values (p_session, now(), coalesce(p_info, '{}'::jsonb))
    on conflict (session) do update set last_seen = now(), info = excluded.info;
  return query
    update fe_bridge.cmd c set status = 'taken'
    where c.session = p_session and c.status = 'pending' and c.created_at > now() - interval '2 minutes'
    returning c.id, c.tool, c.args;
end $$;

-- tab: post a command's result (results may carry one JPEG for Claude to look at)
create or replace function public.fe_done(p_session text, p_id bigint, p_result jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform fe_bridge.check_session(p_session);
  if pg_column_size(p_result) > 1500000 then raise exception 'result too large' using errcode = '54000'; end if;
  update fe_bridge.cmd c set status = 'done', result = p_result, done_at = now()
    where c.session = p_session and c.id = p_id and c.status = 'taken';
end $$;

revoke all on function public.fe_push(text, text, jsonb), public.fe_result(text, bigint), public.fe_tab(text),
  public.fe_take(text, jsonb), public.fe_done(text, bigint, jsonb) from public;
grant execute on function public.fe_push(text, text, jsonb), public.fe_result(text, bigint), public.fe_tab(text),
  public.fe_take(text, jsonb), public.fe_done(text, bigint, jsonb) to anon, authenticated;
revoke all on all functions in schema fe_bridge from public, anon, authenticated;
