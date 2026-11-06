-- =====================================================================
--  Talap — тренажёр ЕНТ по подписке
--  Схема базы данных (Supabase / Postgres 17)
--  Файл можно запускать повторно: функции пересоздаются, таблицы
--  создаются только если их ещё нет.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------
--  Настройки платформы
-- ---------------------------------------------------------------------
create table if not exists private.secrets (
  id                int primary key default 1 check (id = 1),
  tg_bot_token      text,
  tg_webhook_secret text not null default encode(extensions.gen_random_bytes(24), 'hex'),
  admin_code_hash   text,
  admin_link_code   text not null default encode(extensions.gen_random_bytes(12), 'hex'),
  admin_chat_id     bigint
);
insert into private.secrets (id) values (1) on conflict do nothing;

create table if not exists public.platform_settings (
  id              int primary key default 1 check (id = 1),
  brand           text not null default 'Talap',
  site_url        text,
  kaspi_details   text,
  support_contact text,
  price_month     int not null default 2990 check (price_month >= 0),
  price_quarter   int not null default 7490 check (price_quarter >= 0),
  trial_days      int not null default 3 check (trial_days between 0 and 30),
  free_daily      int not null default 20 check (free_daily between 0 and 500),
  bot_username    text,
  updated_at      timestamptz not null default now()
);
insert into public.platform_settings (id) values (1) on conflict do nothing;

create table if not exists public.platform_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
--  Ученики
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  full_name      text check (length(full_name) <= 80),
  phone          text check (length(phone) <= 20),
  grade          text not null default '11' check (grade in ('9', '10', '11', 'grad')),
  target_score   int check (target_score between 50 and 140),
  plan           text not null default 'trial' check (plan in ('trial', 'month', 'quarter', 'gift')),
  paid_until     timestamptz not null default now(),
  is_blocked     boolean not null default false,
  tg_chat_id     bigint,
  tg_link_code   text not null unique default encode(extensions.gen_random_bytes(9), 'hex'),
  remind_hour    int default 19 check (remind_hour between 0 and 23),
  last_active_at timestamptz,
  created_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------
--  Учебные материалы
-- ---------------------------------------------------------------------
create table if not exists public.subjects (
  id        text primary key,
  title     text not null,
  short     text not null,
  kind      text not null check (kind in ('mandatory', 'profile')),
  ent_count int  not null,          -- заданий на ЕНТ
  ent_multi int  not null default 0, -- из них с несколькими ответами (по 2 балла)
  ent_max   int  not null,          -- максимум баллов
  threshold int  not null,          -- пороговый балл
  minutes   int  not null,          -- время теста по одному предмету
  sort      int  not null default 0,
  is_active boolean not null default true
);

create table if not exists public.topics (
  id         serial primary key,
  subject_id text not null references public.subjects(id) on delete cascade,
  title      text not null check (length(title) between 2 and 120),
  sort       int  not null default 0,
  unique (subject_id, title)
);

create table if not exists public.passages (
  id         serial primary key,
  subject_id text not null references public.subjects(id) on delete cascade,
  title      text not null check (length(title) <= 160),
  body       text not null check (length(body) between 50 and 8000),
  created_at timestamptz not null default now()
);

create table if not exists public.questions (
  id          serial primary key,
  subject_id  text not null references public.subjects(id) on delete cascade,
  topic_id    int  references public.topics(id) on delete set null,
  passage_id  int  references public.passages(id) on delete cascade,
  kind        text not null default 'single' check (kind in ('single', 'multi')),
  body        text not null check (length(body) between 3 and 3000),
  options     jsonb not null,
  correct     int[] not null,
  explanation text check (length(explanation) <= 3000),
  difficulty  smallint not null default 1 check (difficulty between 1 and 3),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists questions_subject_idx on public.questions (subject_id, topic_id) where is_active;
create index if not exists questions_passage_idx on public.questions (passage_id) where passage_id is not null;
create unique index if not exists questions_body_uniq on public.questions (subject_id, md5(body), coalesce(passage_id, 0));

-- ---------------------------------------------------------------------
--  Ответы, пробные тесты, оплаты
-- ---------------------------------------------------------------------
create table if not exists public.mock_attempts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(user_id) on delete cascade,
  kind        text not null,               -- 'full' или id предмета
  status      text not null default 'active' check (status in ('active', 'finished')),
  items       jsonb not null,              -- [{"q": 12, "s": "math"}, ...]
  answers     jsonb not null default '{}', -- {"12": [0, 2]}
  started_at  timestamptz not null default now(),
  deadline    timestamptz not null,
  finished_at timestamptz,
  score       int,
  max_score   int,
  result      jsonb
);
create index if not exists mock_attempts_user_idx on public.mock_attempts (user_id, started_at desc);

create table if not exists public.answers (
  id          bigserial primary key,
  user_id     uuid not null references public.profiles(user_id) on delete cascade,
  question_id int  not null references public.questions(id) on delete cascade,
  chosen      int[] not null default '{}',
  is_correct  boolean not null,
  points      smallint not null,
  mode        text not null check (mode in ('practice', 'review', 'mock')),
  attempt_id  uuid references public.mock_attempts(id) on delete cascade,
  created_at  timestamptz not null default now()
);
create index if not exists answers_user_time_idx on public.answers (user_id, created_at desc);
create index if not exists answers_user_q_idx on public.answers (user_id, question_id, created_at desc);
create index if not exists answers_q_idx on public.answers (question_id);

create table if not exists public.payment_requests (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(user_id) on delete cascade,
  plan         text not null check (plan in ('month', 'quarter')),
  months       int  not null check (months in (1, 3)),
  amount       int  not null,
  payer_note   text check (length(payer_note) <= 200),
  status       text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at   timestamptz not null default now(),
  processed_at timestamptz
);
create index if not exists payment_requests_user_idx on public.payment_requests (user_id, created_at desc);

create table if not exists public.question_reports (
  id          bigserial primary key,
  question_id int  not null references public.questions(id) on delete cascade,
  user_id     uuid references public.profiles(user_id) on delete set null,
  message     text not null check (length(message) between 3 and 1000),
  status      text not null default 'new' check (status in ('new', 'done')),
  created_at  timestamptz not null default now()
);

-- Очередь сообщений в Telegram (отправляются сразу через pg_net)
create table if not exists public.notifications (
  id           bigserial primary key,
  chat_id      bigint not null,
  text         text not null,
  reply_markup jsonb,
  user_id      uuid references public.profiles(user_id) on delete cascade,
  kind         text,
  request_id   bigint,
  error        text,
  sent_at      timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists notifications_user_idx on public.notifications (user_id, kind, created_at desc);

-- ---------------------------------------------------------------------
--  Вспомогательные функции
-- ---------------------------------------------------------------------
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.platform_admins where user_id = auth.uid())
$$;

create or replace function private.h(t text) returns text
language sql immutable as $$
  select replace(replace(replace(coalesce(t, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;')
$$;

create or replace function private.money(n int) returns text
language sql immutable as $$
  select replace(to_char(coalesce(n, 0), 'FM999,999,999'), ',', ' ') || ' ₸'
$$;

create or replace function private.plan_title(p text) returns text
language sql immutable as $$
  select case p when 'month' then '1 месяц' when 'quarter' then '3 месяца' when 'gift' then 'Подарок' else 'Пробный доступ' end
$$;

create or replace function private.local_day(ts timestamptz) returns date
language sql immutable as $$ select (ts at time zone 'Asia/Almaty')::date $$;

create or replace function private.is_premium(p public.profiles) returns boolean
language sql stable as $$ select not p.is_blocked and p.paid_until > now() $$;

create or replace function private.days_word(n int) returns text
language sql immutable as $$
  select n || ' ' || case
    when n % 10 = 1 and n % 100 <> 11 then 'день'
    when n % 10 between 2 and 4 and n % 100 not between 12 and 14 then 'дня'
    else 'дней' end
$$;

-- Нормализация выбранных вариантов: без повторов, по возрастанию
create or replace function private.norm_choice(a int[]) returns int[]
language sql immutable as $$
  select coalesce(array(select distinct x from unnest(coalesce(a, '{}'::int[])) x where x is not null order by x), '{}')
$$;

-- Баллы по правилам ЕНТ: один ответ — 1 балл;
-- несколько ответов — 2 балла без ошибок, 1 балл при одной ошибке, иначе 0
create or replace function private.grade(p_kind text, p_correct int[], p_chosen int[]) returns int
language plpgsql immutable as $$
declare c int[] := private.norm_choice(p_correct); x int[] := private.norm_choice(p_chosen); errs int;
begin
  if cardinality(x) = 0 then return 0; end if;
  if p_kind = 'single' then
    return case when x = c then 1 else 0 end;
  end if;
  select (select count(*) from unnest(x) v where not v = any(c))
       + (select count(*) from unnest(c) v where not v = any(x)) into errs;
  return case when errs = 0 then 2 when errs = 1 then 1 else 0 end;
end $$;

create or replace function private.max_points(p_kind text) returns int
language sql immutable as $$ select case when p_kind = 'multi' then 2 else 1 end $$;

-- Вопрос для ученика — без правильного ответа
create or replace function private.q_public(q public.questions) returns jsonb
language sql stable as $$
  select jsonb_build_object('id', q.id, 'subject_id', q.subject_id, 'topic_id', q.topic_id,
    'passage_id', q.passage_id, 'kind', q.kind, 'body', q.body, 'options', q.options,
    'max_points', private.max_points(q.kind),
    'topic', (select t.title from public.topics t where t.id = q.topic_id))
$$;

create or replace function private.passages_for(p_ids int[]) returns jsonb
language sql stable as $$
  select coalesce(jsonb_object_agg(p.id::text, jsonb_build_object('title', p.title, 'body', p.body)), '{}'::jsonb)
  from public.passages p where p.id = any(coalesce(p_ids, '{}'))
$$;

create or replace function private.me() returns public.profiles
language plpgsql stable security definer set search_path = public as $$
declare p public.profiles;
begin
  if auth.uid() is null then raise exception 'Войдите в аккаунт'; end if;
  select * into p from public.profiles where user_id = auth.uid();
  if not found then raise exception 'Профиль не найден'; end if;
  if p.is_blocked then raise exception 'Аккаунт заблокирован. Напишите в поддержку'; end if;
  return p;
end $$;

-- Сколько бесплатных проверок осталось сегодня (null — без ограничений)
create or replace function private.free_left(p public.profiles) returns int
language sql stable security definer set search_path = public as $$
  select case when private.is_premium(p) then null else greatest(0, s.free_daily - (
    select count(*) from public.answers a
    where a.user_id = p.user_id and a.mode <> 'mock'
      and a.created_at >= ((now() at time zone 'Asia/Almaty')::date)::timestamp at time zone 'Asia/Almaty'))::int end
  from public.platform_settings s where s.id = 1
$$;

create or replace function private.streak(p_user uuid) returns int
language sql stable security definer set search_path = public as $$
  with d as (
    select distinct private.local_day(created_at) as day from public.answers where user_id = p_user
      and created_at > now() - interval '400 days'
  ), g as (
    select day, day - (row_number() over (order by day))::int as grp from d
  ), runs as (
    select max(day) as last_day, count(*) as len from g group by grp
  )
  select coalesce((select len::int from runs
                   where last_day >= private.local_day(now()) - 1 order by last_day desc limit 1), 0)
$$;

-- ---------------------------------------------------------------------
--  Telegram: очередь сообщений
-- ---------------------------------------------------------------------
create or replace function private.notify(p_chat bigint, p_text text, p_markup jsonb, p_user uuid, p_kind text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_chat is null then return; end if;
  insert into public.notifications (chat_id, text, reply_markup, user_id, kind)
  values (p_chat, p_text, p_markup, p_user, p_kind);
end $$;

create or replace function private.notify_admin(p_text text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v_chat bigint;
begin
  select admin_chat_id into v_chat from private.secrets where id = 1;
  perform private.notify(v_chat, p_text, null, null, 'admin');
end $$;

create or replace function private.app_button(p_text text) returns jsonb
language sql stable as $$
  select case when nullif(site_url, '') is null then null
    else jsonb_build_object('inline_keyboard', jsonb_build_array(jsonb_build_array(
      jsonb_build_object('text', p_text, 'url', rtrim(site_url, '/') || '/app.html')))) end
  from public.platform_settings where id = 1
$$;

create or replace function private.trg_notification_send() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare v_token text;
begin
  select tg_bot_token into v_token from private.secrets where id = 1;
  if v_token is null then
    new.error := 'no_bot_token';
    return new;
  end if;
  new.request_id := net.http_post(
    url     := 'https://api.telegram.org/bot' || v_token || '/sendMessage',
    body    := jsonb_strip_nulls(jsonb_build_object(
                 'chat_id', new.chat_id, 'text', new.text, 'parse_mode', 'HTML',
                 'disable_web_page_preview', true, 'reply_markup', new.reply_markup)),
    headers := '{"Content-Type": "application/json"}'::jsonb
  );
  new.sent_at := now();
  return new;
end $$;
drop trigger if exists notification_send on public.notifications;
create trigger notification_send before insert on public.notifications
  for each row execute function private.trg_notification_send();

-- ---------------------------------------------------------------------
--  Триггеры
-- ---------------------------------------------------------------------
-- Новый пользователь → профиль с пробным доступом
create or replace function private.trg_new_user() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare v_trial int; v_name text := left(nullif(trim(new.raw_user_meta_data->>'full_name'), ''), 80);
begin
  select trial_days into v_trial from public.platform_settings where id = 1;
  insert into public.profiles (user_id, full_name, phone, grade, paid_until)
  values (new.id, v_name, left(nullif(trim(new.raw_user_meta_data->>'phone'), ''), 20),
          case when new.raw_user_meta_data->>'grade' in ('9', '10', '11', 'grad') then new.raw_user_meta_data->>'grade' else '11' end,
          now() + make_interval(days => coalesce(v_trial, 0)))
  on conflict (user_id) do nothing;
  perform private.notify_admin('🆕 Новый ученик: ' || private.h(coalesce(v_name, '')) || ' (' || private.h(new.email) || ')');
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.trg_new_user();

-- Проверка вопроса: варианты, правильные ответы, тема того же предмета
create or replace function private.trg_question_check() returns trigger
language plpgsql security definer set search_path = public as $$
declare n int; t_subject text; p_subject text;
begin
  if jsonb_typeof(new.options) <> 'array' then raise exception 'Варианты ответа должны быть списком'; end if;
  n := jsonb_array_length(new.options);
  if n < 2 or n > 8 then raise exception 'Нужно от 2 до 8 вариантов ответа'; end if;
  if exists (select 1 from jsonb_array_elements(new.options) o
             where jsonb_typeof(o) <> 'string' or length(trim(o #>> '{}')) = 0) then
    raise exception 'Пустой вариант ответа';
  end if;
  new.correct := private.norm_choice(new.correct);
  if cardinality(new.correct) = 0 then raise exception 'Отметьте правильный ответ'; end if;
  if exists (select 1 from unnest(new.correct) c where c < 0 or c >= n) then
    raise exception 'Правильный ответ указывает на несуществующий вариант';
  end if;
  if new.kind = 'single' and cardinality(new.correct) <> 1 then
    raise exception 'В задании с одним ответом должен быть ровно один правильный вариант';
  end if;
  if new.topic_id is not null then
    select subject_id into t_subject from public.topics where id = new.topic_id;
    if t_subject is distinct from new.subject_id then raise exception 'Тема относится к другому предмету'; end if;
  end if;
  if new.passage_id is not null then
    select subject_id into p_subject from public.passages where id = new.passage_id;
    if p_subject is distinct from new.subject_id then raise exception 'Текст относится к другому предмету'; end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists question_check on public.questions;
create trigger question_check before insert or update on public.questions
  for each row execute function private.trg_question_check();

-- ---------------------------------------------------------------------
--  Каталог (доступен без входа)
-- ---------------------------------------------------------------------
create or replace function public.get_catalog() returns jsonb
language sql stable security definer set search_path = public as $$
  with last_ans as (
    select distinct on (a.question_id) a.question_id, a.is_correct
    from public.answers a where a.user_id = auth.uid()
    order by a.question_id, a.created_at desc, a.id desc
  ), qs as (
    select q.id, q.subject_id, q.topic_id, l.question_id is not null as done, coalesce(l.is_correct, false) as ok
    from public.questions q left join last_ans l on l.question_id = q.id
    where q.is_active
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', s.id, 'title', s.title, 'short', s.short, 'kind', s.kind, 'ent_count', s.ent_count,
      'ent_multi', s.ent_multi, 'ent_max', s.ent_max, 'threshold', s.threshold, 'minutes', s.minutes,
      'questions', (select count(*) from qs where qs.subject_id = s.id),
      'done', (select count(*) from qs where qs.subject_id = s.id and qs.done),
      'ok', (select count(*) from qs where qs.subject_id = s.id and qs.ok),
      'passages', (select count(*) from public.passages p where p.subject_id = s.id),
      'topics', (select coalesce(jsonb_agg(jsonb_build_object(
          'id', t.id, 'title', t.title,
          'questions', (select count(*) from qs where qs.topic_id = t.id),
          'done', (select count(*) from qs where qs.topic_id = t.id and qs.done),
          'ok', (select count(*) from qs where qs.topic_id = t.id and qs.ok)) order by t.sort, t.id), '[]'::jsonb)
        from public.topics t where t.subject_id = s.id
          and exists (select 1 from qs where qs.topic_id = t.id))
    ) order by s.sort), '[]'::jsonb)
  from public.subjects s where s.is_active
$$;

-- ---------------------------------------------------------------------
--  Ученик: профиль и статистика
-- ---------------------------------------------------------------------
create or replace function public.get_me() returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare p public.profiles; s public.platform_settings; v_email text;
begin
  if auth.uid() is null then return null; end if;
  select * into p from public.profiles where user_id = auth.uid();
  if not found then return null; end if;
  select * into s from public.platform_settings where id = 1;
  select email into v_email from auth.users where id = auth.uid();
  return jsonb_build_object(
    'user_id', p.user_id, 'email', v_email, 'full_name', p.full_name, 'phone', p.phone, 'grade', p.grade,
    'target_score', p.target_score, 'plan', p.plan, 'paid_until', p.paid_until, 'is_blocked', p.is_blocked,
    'premium', private.is_premium(p), 'free_left', private.free_left(p), 'free_daily', s.free_daily,
    'tg_connected', p.tg_chat_id is not null, 'tg_link_code', p.tg_link_code, 'remind_hour', p.remind_hour,
    'is_admin', public.is_admin(), 'streak', private.streak(p.user_id),
    'full_mock_used', exists (select 1 from public.mock_attempts m where m.user_id = p.user_id and m.kind = 'full'),
    'pending_payment', exists (select 1 from public.payment_requests r where r.user_id = p.user_id and r.status = 'pending'));
end $$;

create or replace function public.my_stats() returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare p public.profiles := private.me(); v_today timestamptz;
begin
  v_today := ((now() at time zone 'Asia/Almaty')::date)::timestamp at time zone 'Asia/Almaty';
  return jsonb_build_object(
    'streak', private.streak(p.user_id),
    'today', (select count(*) from public.answers where user_id = p.user_id and created_at >= v_today),
    'today_ok', (select count(*) from public.answers where user_id = p.user_id and created_at >= v_today and is_correct),
    'total', (select count(*) from public.answers where user_id = p.user_id),
    'total_ok', (select count(*) from public.answers where user_id = p.user_id and is_correct),
    'mistakes', (select count(*) from (
        select distinct on (question_id) is_correct from public.answers
        where user_id = p.user_id order by question_id, created_at desc, id desc) x where not x.is_correct),
    'week', (select coalesce(jsonb_agg(jsonb_build_object('day', d::date, 'n',
        (select count(*) from public.answers a where a.user_id = p.user_id and private.local_day(a.created_at) = d::date)) order by d), '[]'::jsonb)
      from generate_series(private.local_day(now()) - 6, private.local_day(now()), interval '1 day') d),
    'by_subject', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'title', s.short,
        'answers', x.n, 'ok', x.ok) order by s.sort), '[]'::jsonb)
      from public.subjects s,
      lateral (select count(*) as n, count(*) filter (where a.is_correct) as ok
               from (select a.is_correct from public.answers a join public.questions q on q.id = a.question_id
                     where a.user_id = p.user_id and q.subject_id = s.id order by a.created_at desc limit 100) a) x
      where s.is_active),
    'last_mock', (select jsonb_build_object('id', m.id, 'kind', m.kind, 'score', m.score, 'max_score', m.max_score,
        'finished_at', m.finished_at)
      from public.mock_attempts m where m.user_id = p.user_id and m.status = 'finished' and m.kind = 'full'
      order by m.finished_at desc limit 1),
    'active_mock', (select m.id from public.mock_attempts m
      where m.user_id = p.user_id and m.status = 'active' and m.deadline > now() limit 1));
end $$;

-- ---------------------------------------------------------------------
--  Тренажёр
-- ---------------------------------------------------------------------
-- Порция вопросов: сначала новые, потом с ошибками, потом остальные.
-- Для текстов (грамотность чтения) — один текст со всеми его вопросами.
create or replace function public.practice_questions(p_subject text, p_topic int default null, p_limit int default 10)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare p public.profiles := private.me(); v_ids int[]; v_passage int; v_limit int := least(greatest(coalesce(p_limit, 10), 1), 30);
begin
  if not exists (select 1 from public.subjects where id = p_subject and is_active) then
    raise exception 'Предмет не найден';
  end if;

  if exists (select 1 from public.passages where subject_id = p_subject)
     and not exists (select 1 from public.questions where subject_id = p_subject and is_active and passage_id is null) then
    -- предмет только из текстов: выбираем текст, который ученик решал меньше всего
    select x.id into v_passage from (
      select ps.id,
        (select count(*) from public.answers a join public.questions q on q.id = a.question_id
          where a.user_id = p.user_id and q.passage_id = ps.id) as tries
      from public.passages ps where ps.subject_id = p_subject
        and exists (select 1 from public.questions q where q.passage_id = ps.id and q.is_active
                    and (p_topic is null or q.topic_id = p_topic))
    ) x order by x.tries, random() limit 1;
    select array_agg(q.id order by q.id) into v_ids from public.questions q where q.passage_id = v_passage and q.is_active;
  else
    with last_ans as (
      select distinct on (a.question_id) a.question_id, a.is_correct, a.created_at
      from public.answers a where a.user_id = p.user_id
      order by a.question_id, a.created_at desc, a.id desc
    )
    select array_agg(id) into v_ids from (
      select q.id from public.questions q left join last_ans l on l.question_id = q.id
      where q.subject_id = p_subject and q.is_active and (p_topic is null or q.topic_id = p_topic)
      order by case when l.question_id is null then 0 when not l.is_correct then 1 else 2 end,
               l.created_at nulls first, random()
      limit v_limit
    ) x;
  end if;

  return jsonb_build_object(
    'questions', (select coalesce(jsonb_agg(private.q_public(q) order by array_position(v_ids, q.id)), '[]'::jsonb)
                  from public.questions q where q.id = any(coalesce(v_ids, '{}'))),
    'passages', private.passages_for((select array_agg(distinct passage_id) from public.questions where id = any(coalesce(v_ids, '{}')))),
    'free_left', private.free_left(p));
end $$;

create or replace function public.practice_answer(p_question int, p_chosen int[], p_mode text default 'practice')
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare p public.profiles := private.me(); q public.questions; v_pts int; v_left int; v_mode text;
begin
  v_mode := case when p_mode = 'review' then 'review' else 'practice' end;
  if cardinality(private.norm_choice(p_chosen)) = 0 then raise exception 'Выберите ответ'; end if;
  v_left := private.free_left(p);
  if v_left is not null and v_left <= 0 then
    raise exception 'Бесплатные задания на сегодня закончились. Оформите подписку, чтобы заниматься без ограничений';
  end if;
  select * into q from public.questions where id = p_question and is_active;
  if not found then raise exception 'Вопрос не найден'; end if;
  v_pts := private.grade(q.kind, q.correct, p_chosen);
  insert into public.answers (user_id, question_id, chosen, is_correct, points, mode)
  values (p.user_id, q.id, private.norm_choice(p_chosen), v_pts = private.max_points(q.kind), v_pts, v_mode);
  update public.profiles set last_active_at = now() where user_id = p.user_id;
  return jsonb_build_object('is_correct', v_pts = private.max_points(q.kind), 'points', v_pts,
    'max_points', private.max_points(q.kind), 'correct', to_jsonb(q.correct), 'explanation', q.explanation,
    'free_left', case when v_left is null then null else v_left - 1 end);
end $$;

-- Работа над ошибками: вопросы, на которые последний ответ был неверным
create or replace function public.mistakes(p_subject text default null, p_limit int default 15) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare p public.profiles := private.me(); v_ids int[];
begin
  with last_ans as (
    select distinct on (a.question_id) a.question_id, a.is_correct, a.created_at
    from public.answers a where a.user_id = p.user_id
    order by a.question_id, a.created_at desc, a.id desc
  )
  select array_agg(id) into v_ids from (
    select q.id from last_ans l join public.questions q on q.id = l.question_id
    where not l.is_correct and q.is_active and (p_subject is null or q.subject_id = p_subject)
    order by l.created_at limit least(greatest(coalesce(p_limit, 15), 1), 50)
  ) x;
  return jsonb_build_object(
    'questions', (select coalesce(jsonb_agg(private.q_public(q) order by array_position(v_ids, q.id)), '[]'::jsonb)
                  from public.questions q where q.id = any(coalesce(v_ids, '{}'))),
    'passages', private.passages_for((select array_agg(distinct passage_id) from public.questions where id = any(coalesce(v_ids, '{}')))),
    'counts', (with last_ans as (
        select distinct on (a.question_id) a.question_id, a.is_correct
        from public.answers a where a.user_id = p.user_id order by a.question_id, a.created_at desc, a.id desc)
      select coalesce(jsonb_object_agg(subject_id, n), '{}'::jsonb) from (
        select q.subject_id, count(*) as n from last_ans l join public.questions q on q.id = l.question_id
        where not l.is_correct and q.is_active group by q.subject_id) c),
    'free_left', private.free_left(p));
end $$;

create or replace function public.report_question(p_question int, p_message text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare p public.profiles := private.me();
begin
  if length(trim(coalesce(p_message, ''))) < 3 then raise exception 'Опишите, что не так'; end if;
  if (select count(*) from public.question_reports where user_id = p.user_id and created_at > now() - interval '1 day') >= 20 then
    raise exception 'Слишком много сообщений за день';
  end if;
  insert into public.question_reports (question_id, user_id, message) values (p_question, p.user_id, left(trim(p_message), 1000));
  perform private.notify_admin('⚠️ Сообщение об ошибке в вопросе #' || p_question || E'\n' || private.h(left(trim(p_message), 300)));
end $$;

-- ---------------------------------------------------------------------
--  Пробное ЕНТ
-- ---------------------------------------------------------------------
create or replace function private.pick_subject(p_subject text, p_count int, p_multi int) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare v_items jsonb := '[]'::jsonb; v_pass record; v_n int := 0; v_single int[]; v_multi int[];
begin
  if exists (select 1 from public.passages ps where ps.subject_id = p_subject)
     and not exists (select 1 from public.questions where subject_id = p_subject and is_active and passage_id is null) then
    for v_pass in select ps.id from public.passages ps where ps.subject_id = p_subject
                  and exists (select 1 from public.questions q where q.passage_id = ps.id and q.is_active)
                  order by random() loop
      exit when v_n >= p_count;
      select v_items || coalesce(jsonb_agg(jsonb_build_object('q', x.id, 's', p_subject) order by x.id), '[]'::jsonb), v_n + count(*)
        into v_items, v_n
      from (select q.id from public.questions q where q.passage_id = v_pass.id and q.is_active
            order by q.id limit p_count - v_n) x;
    end loop;
    return v_items;
  end if;

  select array_agg(id) into v_multi from (
    select id from public.questions where subject_id = p_subject and is_active and kind = 'multi'
    order by random() limit p_multi) x;
  select array_agg(id) into v_single from (
    select id from public.questions where subject_id = p_subject and is_active and kind = 'single'
    order by passage_id nulls first, random() limit p_count - coalesce(cardinality(v_multi), 0)) x;
  select coalesce(jsonb_agg(jsonb_build_object('q', id, 's', p_subject) order by grp, ord), '[]'::jsonb) into v_items
  from (
    select q.id, case when q.kind = 'multi' then 2 when q.passage_id is not null then 1 else 0 end as grp,
           coalesce(q.passage_id, 0) * 100000 + coalesce(array_position(v_single, q.id), array_position(v_multi, q.id)) as ord
    from public.questions q where q.id = any(coalesce(v_single, '{}') || coalesce(v_multi, '{}'))
  ) z;
  return v_items;
end $$;

create or replace function private.finish_mock(p_id uuid) returns public.mock_attempts
language plpgsql security definer set search_path = public, extensions as $$
declare m public.mock_attempts; v_res jsonb; v_score int; v_max int;
begin
  select * into m from public.mock_attempts where id = p_id for update;
  if m.status = 'finished' then return m; end if;

  with it as (
    select (e->>'q')::int as qid, e->>'s' as sid, ord
    from jsonb_array_elements(m.items) with ordinality t(e, ord)
  ), g as (
    select it.sid, q.id, q.kind,
      private.norm_choice(array(select jsonb_array_elements_text(m.answers -> q.id::text)::int)) as chosen,
      q.correct
    from it join public.questions q on q.id = it.qid
  ), pts as (
    select g.*, private.grade(g.kind, g.correct, g.chosen) as pts, private.max_points(g.kind) as mx from g
  ), ins as (
    insert into public.answers (user_id, question_id, chosen, is_correct, points, mode, attempt_id)
    select m.user_id, id, chosen, pts = mx, pts, 'mock', m.id from pts where cardinality(chosen) > 0
    returning 1
  ), subj as (
    select s.id, s.title, s.short, s.threshold, s.sort,
      coalesce(sum(pts.pts), 0)::int as score, coalesce(sum(pts.mx), 0)::int as max,
      count(pts.id)::int as total, count(pts.id) filter (where cardinality(pts.chosen) > 0)::int as answered
    from public.subjects s join pts on pts.sid = s.id
    group by s.id
  )
  select jsonb_agg(jsonb_build_object('id', id, 'title', title, 'short', short, 'score', score, 'max', max,
           'threshold', threshold, 'passed', score >= threshold, 'total', total, 'answered', answered) order by sort),
         sum(score), sum(max)
    into v_res, v_score, v_max
  from subj where (select count(*) from ins) >= 0;

  update public.mock_attempts
  set status = 'finished', finished_at = least(now(), deadline), score = coalesce(v_score, 0), max_score = coalesce(v_max, 0),
      result = jsonb_build_object('subjects', coalesce(v_res, '[]'::jsonb),
        'passed', m.kind <> 'full' or (coalesce(v_score, 0) >= 50
                  and not exists (select 1 from jsonb_array_elements(coalesce(v_res, '[]'::jsonb)) e where not (e->>'passed')::boolean)))
  where id = p_id returning * into m;
  return m;
end $$;

create or replace function public.start_mock(p_kind text) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare p public.profiles := private.me(); a public.mock_attempts; v_items jsonb := '[]'::jsonb; s record; v_minutes int; v_id uuid;
begin
  -- незаконченный тест продолжаем, просроченный — завершаем
  for a in select * from public.mock_attempts where user_id = p.user_id and status = 'active' loop
    if a.deadline > now() then return a.id; end if;
    perform private.finish_mock(a.id);
  end loop;

  if p_kind = 'full' then
    if not private.is_premium(p) and exists (select 1 from public.mock_attempts where user_id = p.user_id and kind = 'full') then
      raise exception 'Бесплатное пробное ЕНТ уже пройдено. Оформите подписку, чтобы проходить его без ограничений';
    end if;
    for s in select * from public.subjects where is_active order by sort loop
      v_items := v_items || private.pick_subject(s.id, s.ent_count, s.ent_multi);
    end loop;
    v_minutes := 240;
  else
    select * into s from public.subjects where id = p_kind and is_active;
    if not found then raise exception 'Предмет не найден'; end if;
    if not private.is_premium(p) and exists (select 1 from public.mock_attempts where user_id = p.user_id and kind = p_kind) then
      raise exception 'Бесплатный тест по этому предмету уже пройден. Оформите подписку, чтобы проходить тесты без ограничений';
    end if;
    v_items := private.pick_subject(s.id, s.ent_count, s.ent_multi);
    v_minutes := s.minutes;
  end if;
  if jsonb_array_length(v_items) = 0 then raise exception 'В банке пока нет вопросов для теста'; end if;

  insert into public.mock_attempts (user_id, kind, items, deadline)
  values (p.user_id, p_kind, v_items, now() + make_interval(mins => v_minutes))
  returning id into v_id;
  update public.profiles set last_active_at = now() where user_id = p.user_id;
  return v_id;
end $$;

create or replace function public.get_mock(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare p public.profiles := private.me(); m public.mock_attempts; v_ids int[];
begin
  select * into m from public.mock_attempts where id = p_id and user_id = p.user_id;
  if not found then raise exception 'Тест не найден'; end if;
  if m.status = 'active' and m.deadline <= now() then m := private.finish_mock(m.id); end if;
  if m.status = 'finished' then
    return jsonb_build_object('id', m.id, 'status', m.status);
  end if;
  select array_agg((e->>'q')::int) into v_ids from jsonb_array_elements(m.items) e;
  return jsonb_build_object(
    'id', m.id, 'kind', m.kind, 'status', m.status, 'started_at', m.started_at, 'deadline', m.deadline, 'now', now(),
    'answers', m.answers,
    'items', (select jsonb_agg(private.q_public(q) || jsonb_build_object('s', e->>'s') order by ord)
              from jsonb_array_elements(m.items) with ordinality t(e, ord)
              join public.questions q on q.id = (e->>'q')::int),
    'passages', private.passages_for((select array_agg(distinct passage_id) from public.questions where id = any(v_ids))),
    'subjects', (select jsonb_agg(jsonb_build_object('id', s.id, 'title', s.title, 'short', s.short) order by s.sort)
                 from public.subjects s where s.id in (select e->>'s' from jsonb_array_elements(m.items) e)));
end $$;

create or replace function public.save_mock_answer(p_id uuid, p_question int, p_chosen int[]) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare p public.profiles := private.me(); m public.mock_attempts; v int[] := private.norm_choice(p_chosen);
begin
  select * into m from public.mock_attempts where id = p_id and user_id = p.user_id for update;
  if not found then raise exception 'Тест не найден'; end if;
  if m.status <> 'active' or now() > m.deadline + interval '1 minute' then raise exception 'Время теста вышло'; end if;
  if not exists (select 1 from jsonb_array_elements(m.items) e where (e->>'q')::int = p_question) then
    raise exception 'Вопрос не из этого теста';
  end if;
  update public.mock_attempts
  set answers = case when cardinality(v) = 0 then answers - p_question::text
                     else answers || jsonb_build_object(p_question::text, to_jsonb(v)) end
  where id = p_id;
end $$;

create or replace function public.finish_mock(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare p public.profiles := private.me(); m public.mock_attempts;
begin
  select * into m from public.mock_attempts where id = p_id and user_id = p.user_id;
  if not found then raise exception 'Тест не найден'; end if;
  m := private.finish_mock(p_id);
  update public.profiles set last_active_at = now() where user_id = p.user_id;
  return jsonb_build_object('id', m.id, 'score', m.score, 'max_score', m.max_score, 'result', m.result);
end $$;

-- Разбор завершённого теста: ответы, правильные варианты, объяснения
create or replace function public.mock_review(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare p public.profiles := private.me(); m public.mock_attempts; v_ids int[];
begin
  select * into m from public.mock_attempts where id = p_id and user_id = p.user_id;
  if not found then raise exception 'Тест не найден'; end if;
  if m.status = 'active' and m.deadline <= now() then m := private.finish_mock(m.id); end if;
  if m.status <> 'finished' then raise exception 'Тест ещё идёт'; end if;
  select array_agg((e->>'q')::int) into v_ids from jsonb_array_elements(m.items) e;
  return jsonb_build_object(
    'id', m.id, 'kind', m.kind, 'started_at', m.started_at, 'finished_at', m.finished_at,
    'score', m.score, 'max_score', m.max_score, 'result', m.result,
    'items', (select jsonb_agg(private.q_public(q) || jsonb_build_object(
                's', e->>'s', 'correct', to_jsonb(q.correct), 'explanation', q.explanation,
                'chosen', coalesce(m.answers -> q.id::text, '[]'::jsonb),
                'points', private.grade(q.kind, q.correct, array(select jsonb_array_elements_text(coalesce(m.answers -> q.id::text, '[]'::jsonb))::int)))
              order by ord)
              from jsonb_array_elements(m.items) with ordinality t(e, ord)
              join public.questions q on q.id = (e->>'q')::int),
    'passages', private.passages_for((select array_agg(distinct passage_id) from public.questions where id = any(v_ids))));
end $$;

create or replace function public.my_mocks() returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare p public.profiles := private.me(); a public.mock_attempts;
begin
  for a in select * from public.mock_attempts where user_id = p.user_id and status = 'active' and deadline <= now() loop
    perform private.finish_mock(a.id);
  end loop;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'kind', m.kind, 'status', m.status,
      'started_at', m.started_at, 'finished_at', m.finished_at, 'deadline', m.deadline,
      'score', m.score, 'max_score', m.max_score, 'result', m.result,
      'questions', jsonb_array_length(m.items)) order by m.started_at desc), '[]'::jsonb)
    from (select * from public.mock_attempts where user_id = p.user_id order by started_at desc limit 50) m);
end $$;

-- ---------------------------------------------------------------------
--  Подписка
-- ---------------------------------------------------------------------
create or replace function public.request_payment(p_plan text, p_note text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare p public.profiles := private.me(); s public.platform_settings; v_amount int; v_months int; v_id uuid; v_email text;
begin
  if p_plan not in ('month', 'quarter') then raise exception 'Неверный тариф'; end if;
  if length(trim(coalesce(p_note, ''))) < 2 then
    raise exception 'Укажите имя отправителя перевода — так мы найдём ваш платёж';
  end if;
  if exists (select 1 from public.payment_requests where user_id = p.user_id and status = 'pending') then
    raise exception 'Заявка уже отправлена. Мы проверим перевод и откроем доступ';
  end if;
  select * into s from public.platform_settings where id = 1;
  v_months := case p_plan when 'month' then 1 else 3 end;
  v_amount := case p_plan when 'month' then s.price_month else s.price_quarter end;
  insert into public.payment_requests (user_id, plan, months, amount, payer_note)
  values (p.user_id, p_plan, v_months, v_amount, left(trim(p_note), 200))
  returning id into v_id;
  select email into v_email from auth.users where id = p.user_id;
  perform private.notify_admin('💰 Заявка на оплату' || E'\n<b>' || private.h(coalesce(p.full_name, '')) || '</b> (' || private.h(v_email) || ')'
    || E'\nТариф: ' || private.plan_title(p_plan) || E'\nСумма: ' || private.money(v_amount)
    || E'\nОтправитель: ' || private.h(p_note)
    || E'\n\nПроверьте поступление в Kaspi и подтвердите заявку в админке.');
  return jsonb_build_object('id', v_id, 'amount', v_amount);
end $$;

-- ---------------------------------------------------------------------
--  Администратор платформы
-- ---------------------------------------------------------------------
create or replace function public.claim_admin(p_code text) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare v_hash text;
begin
  if auth.uid() is null then raise exception 'Сначала войдите в аккаунт'; end if;
  select admin_code_hash into v_hash from private.secrets where id = 1;
  if v_hash is null or encode(extensions.digest(coalesce(p_code, ''), 'sha256'), 'hex') <> v_hash then
    raise exception 'Неверный код администратора';
  end if;
  insert into public.platform_admins (user_id) values (auth.uid()) on conflict do nothing;
  return true;
end $$;

create or replace function public.admin_set_code(p_code text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not public.is_admin() then raise exception 'Нет доступа'; end if;
  if length(coalesce(p_code, '')) < 8 then raise exception 'Код — минимум 8 символов'; end if;
  update private.secrets set admin_code_hash = encode(extensions.digest(p_code, 'sha256'), 'hex') where id = 1;
end $$;

create or replace function public.admin_overview() returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare s public.platform_settings; v_today timestamptz;
begin
  if not public.is_admin() then raise exception 'Нет доступа'; end if;
  select * into s from public.platform_settings where id = 1;
  v_today := ((now() at time zone 'Asia/Almaty')::date)::timestamp at time zone 'Asia/Almaty';
  return jsonb_build_object(
    'students', (select count(*) from public.profiles),
    'new_7d', (select count(*) from public.profiles where created_at > now() - interval '7 days'),
    'paid', (select count(*) from public.profiles where plan in ('month', 'quarter') and paid_until > now() and not is_blocked),
    'trial', (select count(*) from public.profiles where plan = 'trial' and paid_until > now() and not is_blocked),
    'active_today', (select count(distinct user_id) from public.answers where created_at >= v_today),
    'active_7d', (select count(distinct user_id) from public.answers where created_at > now() - interval '7 days'),
    'answers_7d', (select count(*) from public.answers where created_at > now() - interval '7 days'),
    'mocks_7d', (select count(*) from public.mock_attempts where started_at > now() - interval '7 days'),
    'pending_payments', (select count(*) from public.payment_requests where status = 'pending'),
    'paid_30d', (select coalesce(sum(amount), 0) from public.payment_requests where status = 'approved' and processed_at > now() - interval '30 days'),
    'reports_new', (select count(*) from public.question_reports where status = 'new'),
    'questions', (select count(*) from public.questions where is_active),
    'by_subject', (select jsonb_object_agg(sb.id, (select count(*) from public.questions q where q.subject_id = sb.id and q.is_active))
                   from public.subjects sb));
end $$;

create or replace function public.admin_students(p_search text default null) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare v text := nullif(trim(coalesce(p_search, '')), '');
begin
  if not public.is_admin() then raise exception 'Нет доступа'; end if;
  return (select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]'::jsonb) from (
    select p.user_id, p.full_name, p.phone, p.grade, p.plan, p.paid_until, p.is_blocked, p.created_at, p.last_active_at,
           u.email, (p.tg_chat_id is not null) as tg, private.is_premium(p) as premium,
           (select count(*) from public.answers a where a.user_id = p.user_id) as answers,
           (select count(*) from public.answers a where a.user_id = p.user_id and a.created_at > now() - interval '7 days') as answers_7d,
           (select count(*) from public.mock_attempts m where m.user_id = p.user_id) as mocks
    from public.profiles p join auth.users u on u.id = p.user_id
    where v is null or u.email ilike '%' || v || '%' or p.full_name ilike '%' || v || '%' or p.phone ilike '%' || v || '%'
    order by p.created_at desc limit 500) x);
end $$;

create or replace function public.admin_payments() returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  if not public.is_admin() then raise exception 'Нет доступа'; end if;
  return (select coalesce(jsonb_agg(to_jsonb(x) order by (x.status = 'pending') desc, x.created_at desc), '[]'::jsonb) from (
    select r.*, p.full_name, p.phone, p.paid_until, u.email
    from public.payment_requests r
    join public.profiles p on p.user_id = r.user_id
    join auth.users u on u.id = r.user_id
    order by r.created_at desc limit 300) x);
end $$;

create or replace function public.admin_process_payment(p_id uuid, p_approve boolean) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare r public.payment_requests; p public.profiles; v_support text;
begin
  if not public.is_admin() then raise exception 'Нет доступа'; end if;
  select * into r from public.payment_requests where id = p_id for update;
  if not found then raise exception 'Заявка не найдена'; end if;
  if r.status <> 'pending' then raise exception 'Заявка уже обработана'; end if;
  if p_approve then
    update public.profiles
    set plan = r.plan, paid_until = greatest(paid_until, now()) + make_interval(months => r.months)
    where user_id = r.user_id returning * into p;
    update public.payment_requests set status = 'approved', processed_at = now() where id = p_id;
    perform private.notify(p.tg_chat_id, '✅ Оплата получена, спасибо!' || E'\nПолный доступ открыт до '
      || to_char(p.paid_until at time zone 'Asia/Almaty', 'DD.MM.YYYY') || '. Успехов в подготовке!',
      private.app_button('Открыть Talap'), p.user_id, 'payment_ok');
  else
    update public.payment_requests set status = 'rejected', processed_at = now() where id = p_id;
    select * into p from public.profiles where user_id = r.user_id;
    select support_contact into v_support from public.platform_settings where id = 1;
    perform private.notify(p.tg_chat_id, '⚠️ Мы не нашли ваш перевод на ' || private.money(r.amount) || '.'
      || coalesce(E'\nНапишите в поддержку: ' || private.h(nullif(v_support, '')), ''), null, p.user_id, 'payment_rejected');
  end if;
  return jsonb_build_object('ok', true, 'paid_until', p.paid_until);
end $$;

create or replace function public.admin_set_access(p_user uuid, p_paid_until timestamptz, p_blocked boolean, p_plan text default null)
returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not public.is_admin() then raise exception 'Нет доступа'; end if;
  if p_plan is not null and p_plan not in ('trial', 'month', 'quarter', 'gift') then raise exception 'Неверный тариф'; end if;
  update public.profiles set paid_until = coalesce(p_paid_until, paid_until), is_blocked = coalesce(p_blocked, is_blocked),
    plan = coalesce(p_plan, plan) where user_id = p_user;
  if not found then raise exception 'Ученик не найден'; end if;
end $$;

create or replace function public.admin_reports() returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  if not public.is_admin() then raise exception 'Нет доступа'; end if;
  return (select coalesce(jsonb_agg(to_jsonb(x) order by (x.status = 'new') desc, x.created_at desc), '[]'::jsonb) from (
    select r.*, q.body as question_body, q.subject_id, u.email
    from public.question_reports r join public.questions q on q.id = r.question_id
    left join auth.users u on u.id = r.user_id
    order by r.created_at desc limit 200) x);
end $$;

-- Статистика ответов по вопросам (сложные и подозрительные вопросы видно сразу)
create or replace function public.admin_question_stats(p_subject text) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  if not public.is_admin() then raise exception 'Нет доступа'; end if;
  return (select coalesce(jsonb_object_agg(question_id::text, jsonb_build_object('n', n, 'ok', ok)), '{}'::jsonb) from (
    select a.question_id, count(*) as n, count(*) filter (where a.is_correct) as ok
    from public.answers a join public.questions q on q.id = a.question_id
    where q.subject_id = p_subject group by a.question_id) x);
end $$;

-- Импорт вопросов. Формат (массив блоков):
-- [{"subject": "math", "topic": "Проценты",
--   "passage": {"title": "...", "body": "..."},          -- необязательно
--   "questions": [{"body": "...", "options": ["...", "..."], "answer": "B",   -- или "AC" для нескольких
--                  "kind": "multi", "explanation": "...", "difficulty": 2, "shuffle": true}]}]
create or replace function private.import_questions(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare b jsonb; q jsonb; v_topic int; v_passage int; v_added int := 0; v_skipped int := 0;
        v_correct int[]; v_kind text; v_ans text; v_id int; v_opts jsonb; v_perm int[];
begin
  if jsonb_typeof(p) = 'object' then p := jsonb_build_array(p); end if;
  if jsonb_typeof(p) is distinct from 'array' then raise exception 'Ожидается JSON-массив блоков'; end if;
  for b in select * from jsonb_array_elements(p) loop
    if not exists (select 1 from public.subjects where id = b->>'subject') then
      raise exception 'Неизвестный предмет: %', coalesce(b->>'subject', '(пусто)');
    end if;
    v_topic := null; v_passage := null;
    if nullif(trim(b->>'topic'), '') is not null then
      insert into public.topics (subject_id, title, sort)
      values (b->>'subject', trim(b->>'topic'),
              coalesce((select max(sort) + 1 from public.topics where subject_id = b->>'subject'), 1))
      on conflict (subject_id, title) do update set title = excluded.title
      returning id into v_topic;
    end if;
    if b ? 'passage' and jsonb_typeof(b->'passage') = 'object' then
      select id into v_passage from public.passages where subject_id = b->>'subject' and title = b->'passage'->>'title';
      if v_passage is null then
        insert into public.passages (subject_id, title, body)
        values (b->>'subject', b->'passage'->>'title', b->'passage'->>'body') returning id into v_passage;
      end if;
    end if;
    for q in select * from jsonb_array_elements(b->'questions') loop
      v_ans := upper(regexp_replace(coalesce(q->>'answer', ''), '[^A-Za-zА-Яа-я]', '', 'g'));
      v_ans := translate(v_ans, 'АВСЕ', 'ABCE');
      if v_ans = '' then raise exception 'Нет ответа у вопроса: %', left(q->>'body', 80); end if;
      v_correct := array(select distinct ascii(c) - 65 from regexp_split_to_table(v_ans, '') c order by 1);
      v_kind := coalesce(q->>'kind', case when length(v_ans) > 1 then 'multi' else 'single' end);
      if exists (select 1 from public.questions where subject_id = b->>'subject' and md5(body) = md5(q->>'body')
                 and coalesce(passage_id, 0) = coalesce(v_passage, 0)) then
        v_skipped := v_skipped + 1;
        continue;
      end if;
      v_opts := q->'options';
      if jsonb_typeof(v_opts) = 'array' and exists (select 1 from unnest(v_correct) c where c < 0 or c >= jsonb_array_length(v_opts)) then
        raise exception 'Ответ «%» указывает на несуществующий вариант: %', v_ans, left(q->>'body', 80);
      end if;
      -- варианты перемешиваются, чтобы правильный ответ не стоял всегда на одном месте ("shuffle": false — оставить порядок)
      if coalesce((q->>'shuffle')::boolean, true) and jsonb_typeof(v_opts) = 'array' then
        select array_agg(i order by random()) into v_perm from generate_series(0, jsonb_array_length(v_opts) - 1) i;
        select jsonb_agg(v_opts -> v_perm[k] order by k) into v_opts from generate_subscripts(v_perm, 1) k;
        select array_agg(k - 1 order by k) into v_correct from generate_subscripts(v_perm, 1) k where v_perm[k] = any(v_correct);
      end if;
      insert into public.questions (subject_id, topic_id, passage_id, kind, body, options, correct, explanation, difficulty)
      values (b->>'subject', v_topic, v_passage, v_kind, q->>'body', v_opts, v_correct,
              nullif(q->>'explanation', ''), coalesce((q->>'difficulty')::smallint, 1))
      returning id into v_id;
      v_added := v_added + 1;
    end loop;
  end loop;
  return jsonb_build_object('added', v_added, 'skipped', v_skipped);
end $$;

create or replace function public.admin_import_questions(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not public.is_admin() then raise exception 'Нет доступа'; end if;
  return private.import_questions(p);
end $$;

create or replace function public.admin_tg_info() returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare s private.secrets; v_user text;
begin
  if not public.is_admin() then raise exception 'Нет доступа'; end if;
  select * into s from private.secrets where id = 1;
  select bot_username into v_user from public.platform_settings where id = 1;
  return jsonb_build_object('token_set', s.tg_bot_token is not null, 'bot_username', v_user,
                            'admin_link_code', s.admin_link_code, 'admin_chat_connected', s.admin_chat_id is not null);
end $$;

create or replace function public.admin_test_message() returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_chat bigint;
begin
  if not public.is_admin() then raise exception 'Нет доступа'; end if;
  select admin_chat_id into v_chat from private.secrets where id = 1;
  if v_chat is null then raise exception 'Сначала подключите уведомления администратора'; end if;
  perform private.notify(v_chat, '🔔 Тестовое сообщение: уведомления работают.', null, null, 'admin_test');
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.unlink_tg() returns void
language plpgsql security definer set search_path = public, extensions as $$
declare p public.profiles := private.me();
begin
  update public.profiles set tg_chat_id = null, tg_link_code = encode(extensions.gen_random_bytes(9), 'hex')
  where user_id = p.user_id;
end $$;

-- ---------------------------------------------------------------------
--  Функции для Telegram-бота и регистрации (только service_role)
-- ---------------------------------------------------------------------
create or replace function public.tg_config() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('token', tg_bot_token, 'secret', tg_webhook_secret) from private.secrets where id = 1
$$;

create or replace function public.tg_save_bot(p_token text, p_username text) returns void
language plpgsql security definer set search_path = public as $$
begin
  update private.secrets set tg_bot_token = p_token where id = 1;
  update public.platform_settings set bot_username = p_username, updated_at = now() where id = 1;
end $$;

create or replace function public.tg_handle_start(p_chat_id bigint, p_payload text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare p public.profiles; v_payload text := coalesce(p_payload, ''); v_brand text;
begin
  select brand into v_brand from public.platform_settings where id = 1;
  if left(v_payload, 2) = 's_' then
    update public.profiles set tg_chat_id = p_chat_id where tg_link_code = substr(v_payload, 3) returning * into p;
    if not found then
      return jsonb_build_object('text', 'Ссылка устарела. Откройте Talap → «Профиль» и нажмите «Подключить Telegram» ещё раз.');
    end if;
    return jsonb_build_object('text', '✅ Готово, ' || private.h(coalesce(nullif(p.full_name, ''), 'ученик')) || '!'
      || E'\nБуду напоминать о занятиях'
      || coalesce(' в ' || lpad(p.remind_hour::text, 2, '0') || ':00', '')
      || ', если вы ещё не занимались в этот день, и сообщу, когда откроется доступ.'
      || E'\nВремя напоминания меняется в профиле.',
      'reply_markup', private.app_button('Открыть тренажёр'));
  elsif left(v_payload, 4) = 'adm_' then
    update private.secrets set admin_chat_id = p_chat_id where id = 1 and admin_link_code = substr(v_payload, 5);
    if not found then return jsonb_build_object('text', 'Неверная ссылка администратора.'); end if;
    return jsonb_build_object('text', '✅ Уведомления администратора ' || private.h(v_brand)
      || ' подключены: новые ученики, заявки на оплату и сообщения об ошибках в вопросах.');
  end if;
  return jsonb_build_object('text', 'Сәлеметсіз бе! Я бот ' || private.h(v_brand) || ' — тренажёра для подготовки к ЕНТ.'
    || E'\n\nЧтобы получать напоминания о занятиях, откройте Talap → «Профиль» → «Подключить Telegram».',
    'reply_markup', private.app_button('Открыть тренажёр'));
end $$;

create or replace function public.signup_guard() returns boolean
language sql stable security definer set search_path = public as $$
  select (select count(*) from auth.users where created_at > now() - interval '10 minutes') < 30
$$;

-- ---------------------------------------------------------------------
--  Задачи по расписанию
-- ---------------------------------------------------------------------
-- Каждый час: напоминание тем, кто подключил Telegram и сегодня ещё не занимался
create or replace function private.run_hourly() returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v_hour int := extract(hour from now() at time zone 'Asia/Almaty')::int;
        v_today timestamptz := ((now() at time zone 'Asia/Almaty')::date)::timestamp at time zone 'Asia/Almaty';
begin
  insert into public.notifications (chat_id, text, reply_markup, user_id, kind)
  select p.tg_chat_id,
    case when st.streak > 0
      then '🔥 Серия ' || private.days_word(st.streak) || ' подряд — не прерывайте её! 10 заданий займут около 15 минут.'
      else '📚 Пора заниматься: 10 заданий в тренажёре займут около 15 минут. Каждый день понемногу — и балл растёт.' end,
    private.app_button('Начать занятие'), p.user_id, 'remind'
  from public.profiles p, lateral (select private.streak(p.user_id) as streak) st
  where p.tg_chat_id is not null and not p.is_blocked and p.remind_hour = v_hour
    and coalesce(p.last_active_at, p.created_at) > now() - interval '21 days'
    and not exists (select 1 from public.answers a where a.user_id = p.user_id and a.created_at >= v_today)
    and not exists (select 1 from public.notifications n where n.user_id = p.user_id and n.kind = 'remind' and n.created_at >= v_today);
end $$;

-- Каждый день: окончание доступа, завершение брошенных тестов, очистка
create or replace function private.run_daily() returns void
language plpgsql security definer set search_path = public, extensions as $$
declare a record;
begin
  insert into public.notifications (chat_id, text, reply_markup, user_id, kind)
  select p.tg_chat_id,
    case when x.days_left = 0
      then '⛔ Сегодня заканчивается ' || case when p.plan = 'trial' then 'пробный доступ' else 'подписка' end
           || '. Продлите её в Talap → «Подписка», чтобы заниматься без ограничений.'
      else '⏳ ' || case when p.plan = 'trial' then 'Пробный доступ' else 'Подписка' end || ' закончится через '
           || private.days_word(x.days_left) || ' (' || to_char(p.paid_until at time zone 'Asia/Almaty', 'DD.MM.YYYY')
           || '). Продлить: Talap → «Подписка».' end,
    private.app_button('Продлить'), p.user_id, 'expiry'
  from public.profiles p,
       lateral (select private.local_day(p.paid_until) - private.local_day(now()) as days_left) x
  where p.tg_chat_id is not null and not p.is_blocked and x.days_left in (0, 1, 3)
    and (p.plan <> 'trial' or x.days_left <= 1);

  for a in select id from public.mock_attempts where status = 'active' and deadline < now() loop
    perform private.finish_mock(a.id);
  end loop;

  delete from public.notifications where created_at < now() - interval '60 days';
end $$;

do $$ begin
  perform cron.unschedule(jobid) from cron.job where jobname in ('talap-hourly', 'talap-daily');
end $$;
select cron.schedule('talap-hourly', '0 * * * *', $cron$select private.run_hourly()$cron$);
select cron.schedule('talap-daily', '0 3 * * *', $cron$select private.run_daily()$cron$);

-- ---------------------------------------------------------------------
--  Права доступа и RLS
-- ---------------------------------------------------------------------
alter table public.platform_settings enable row level security;
alter table public.platform_admins   enable row level security;
alter table public.profiles          enable row level security;
alter table public.subjects          enable row level security;
alter table public.topics            enable row level security;
alter table public.passages          enable row level security;
alter table public.questions         enable row level security;
alter table public.mock_attempts     enable row level security;
alter table public.answers           enable row level security;
alter table public.payment_requests  enable row level security;
alter table public.question_reports  enable row level security;
alter table public.notifications     enable row level security;

drop policy if exists ps_read on public.platform_settings;
create policy ps_read on public.platform_settings for select to anon, authenticated using (true);
drop policy if exists ps_admin on public.platform_settings;
create policy ps_admin on public.platform_settings for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists pa_self on public.platform_admins;
create policy pa_self on public.platform_admins for select to authenticated using (user_id = auth.uid());

drop policy if exists prof_self on public.profiles;
create policy prof_self on public.profiles for select to authenticated using (user_id = auth.uid() or public.is_admin());
drop policy if exists prof_update on public.profiles;
create policy prof_update on public.profiles for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Предметы, темы и тексты видны всем; правка — только администратору
do $$
declare t text;
begin
  foreach t in array array['subjects', 'topics', 'passages'] loop
    execute format('drop policy if exists read_all on public.%I', t);
    execute format('create policy read_all on public.%I for select to anon, authenticated using (true)', t);
    execute format('drop policy if exists admin_write on public.%I', t);
    execute format('create policy admin_write on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin())', t);
  end loop;
end $$;

-- Вопросы с ответами — только администратору; ученики получают их через функции без ответов
drop policy if exists q_admin on public.questions;
create policy q_admin on public.questions for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists ma_self on public.mock_attempts;
create policy ma_self on public.mock_attempts for select to authenticated using (user_id = auth.uid());
drop policy if exists ans_self on public.answers;
create policy ans_self on public.answers for select to authenticated using (user_id = auth.uid());
drop policy if exists pr_self on public.payment_requests;
create policy pr_self on public.payment_requests for select to authenticated using (user_id = auth.uid());
drop policy if exists qr_admin on public.question_reports;
create policy qr_admin on public.question_reports for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Табличные права
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
grant select on public.platform_settings, public.subjects, public.topics, public.passages to anon, authenticated;
grant update (brand, site_url, kaspi_details, support_contact, price_month, price_quarter, trial_days, free_daily)
  on public.platform_settings to authenticated;
grant select on public.platform_admins, public.profiles, public.mock_attempts, public.answers, public.payment_requests
  to authenticated;
grant update (full_name, phone, grade, target_score, remind_hour) on public.profiles to authenticated;
grant insert, update, delete on public.subjects, public.topics, public.passages to authenticated;
grant select, insert, update, delete on public.questions, public.question_reports to authenticated;
grant usage on all sequences in schema public to authenticated;

-- Функции: по умолчанию закрыты, открываем нужные
revoke execute on all functions in schema public from public, anon, authenticated;
revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function public.is_admin(), public.get_catalog() to anon, authenticated;
grant execute on function
  public.get_me(), public.my_stats(), public.practice_questions(text, int, int), public.practice_answer(int, int[], text),
  public.mistakes(text, int), public.report_question(int, text), public.start_mock(text), public.get_mock(uuid),
  public.save_mock_answer(uuid, int, int[]), public.finish_mock(uuid), public.mock_review(uuid), public.my_mocks(),
  public.request_payment(text, text), public.unlink_tg(), public.claim_admin(text),
  public.admin_set_code(text), public.admin_overview(), public.admin_students(text), public.admin_payments(),
  public.admin_process_payment(uuid, boolean), public.admin_set_access(uuid, timestamptz, boolean, text),
  public.admin_reports(), public.admin_question_stats(text), public.admin_import_questions(jsonb),
  public.admin_tg_info(), public.admin_test_message()
  to authenticated;
grant execute on function public.tg_config(), public.tg_save_bot(text, text), public.tg_handle_start(bigint, text),
  public.signup_guard() to service_role;

-- ---------------------------------------------------------------------
--  Предметы ЕНТ (формат 2026: 120 заданий, 140 баллов, 4 часа)
-- ---------------------------------------------------------------------
insert into public.subjects (id, title, short, kind, ent_count, ent_multi, ent_max, threshold, minutes, sort) values
  ('history', 'История Казахстана',          'История',       'mandatory', 20,  0, 20, 5, 35, 1),
  ('mathlit', 'Математическая грамотность',  'Мат. грамотность', 'mandatory', 10,  0, 10, 3, 25, 2),
  ('reading', 'Грамотность чтения',          'Чтение',        'mandatory', 10,  0, 10, 3, 25, 3),
  ('math',    'Математика',                  'Математика',    'profile',   40, 10, 50, 5, 85, 4),
  ('physics', 'Физика',                      'Физика',        'profile',   40, 10, 50, 5, 85, 5)
on conflict (id) do update set title = excluded.title, short = excluded.short, kind = excluded.kind,
  ent_count = excluded.ent_count, ent_multi = excluded.ent_multi, ent_max = excluded.ent_max,
  threshold = excluded.threshold, minutes = excluded.minutes, sort = excluded.sort;

-- Фиксированный search_path для вспомогательных функций
alter function private.plan_title(text) set search_path = public;
alter function private.local_day(timestamptz) set search_path = public;
alter function private.is_premium(public.profiles) set search_path = public;
alter function private.h(text) set search_path = public;
alter function private.money(int) set search_path = public;
alter function private.days_word(int) set search_path = public;
alter function private.norm_choice(int[]) set search_path = public;
alter function private.grade(text, int[], int[]) set search_path = public;
alter function private.max_points(text) set search_path = public;
alter function private.q_public(public.questions) set search_path = public;
alter function private.passages_for(int[]) set search_path = public;
alter function private.app_button(text) set search_path = public;
