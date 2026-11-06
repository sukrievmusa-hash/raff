-- Самопроверка базы Talap: select * from private.self_test();
-- Прогоняет сценарии ученика и администратора и откатывает все изменения.
create or replace function private.self_test() returns table (check_name text, passed boolean, details text)
language plpgsql as $test$
declare
  r jsonb := '[]'::jsonb;
  uid uuid := gen_random_uuid();
  uid2 uuid := gen_random_uuid();
  v jsonb; v2 jsonb; mid uuid; qid int; qm record; n int; ok boolean; msg text;
  pay uuid;
begin
  begin
    -- служебная функция для проверок
    create or replace function pg_temp.t(r jsonb, name text, pass boolean, info text default null) returns jsonb
    language sql as $f$ select r || jsonb_build_object('test', name, 'ok', pass, 'info', info) $f$;

    -- 0. Подсчёт баллов
    r := pg_temp.t(r, 'grade: один ответ верно', private.grade('single', '{2}', '{2}') = 1);
    r := pg_temp.t(r, 'grade: один ответ неверно', private.grade('single', '{2}', '{1}') = 0);
    r := pg_temp.t(r, 'grade: несколько — все верно', private.grade('multi', '{0,2,4}', '{4,0,2}') = 2);
    r := pg_temp.t(r, 'grade: несколько — одна ошибка (лишний)', private.grade('multi', '{0,2}', '{0,2,3}') = 1);
    r := pg_temp.t(r, 'grade: несколько — одна ошибка (не выбран)', private.grade('multi', '{0,2,4}', '{0,2}') = 1);
    r := pg_temp.t(r, 'grade: несколько — две ошибки', private.grade('multi', '{0,2}', '{1,3}') = 0);
    r := pg_temp.t(r, 'grade: пустой ответ', private.grade('multi', '{0}', '{}') = 0);

    -- 1. Регистрация → профиль с пробным доступом
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
                            raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    values (uid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'selftest1@talap.test', '', now(),
            '{}', '{"full_name": "Тест Ученик", "grade": "11"}', now(), now()),
           (uid2, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'selftest2@talap.test', '', now(),
            '{}', '{"full_name": "Второй"}', now(), now());
    select count(*) into n from public.profiles where user_id = uid and full_name = 'Тест Ученик' and paid_until > now();
    r := pg_temp.t(r, 'профиль создан с пробным доступом', n = 1);

    -- 2. Действия ученика
    perform set_config('request.jwt.claims', jsonb_build_object('sub', uid, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);

    select count(*) into n from public.questions;
    r := pg_temp.t(r, 'ученик не видит таблицу вопросов с ответами', n = 0);

    v := public.get_me();
    r := pg_temp.t(r, 'get_me: пробный доступ активен', (v->>'premium')::boolean and v->>'full_name' = 'Тест Ученик');

    v := public.get_catalog();
    r := pg_temp.t(r, 'каталог: 5 предметов', jsonb_array_length(v) = 5);

    v := public.practice_questions('math', null, 10);
    r := pg_temp.t(r, 'тренажёр: выдаёт 10 вопросов', jsonb_array_length(v->'questions') = 10);
    r := pg_temp.t(r, 'тренажёр: без правильных ответов',
      not exists (select 1 from jsonb_array_elements(v->'questions') e where e ? 'correct' or e ? 'explanation'));

    v := public.practice_questions('reading', null, 10);
    r := pg_temp.t(r, 'чтение: один текст со всеми вопросами',
      jsonb_array_length(v->'questions') = 5 and (select count(*) from jsonb_object_keys(v->'passages')) = 1);

    perform set_config('role', 'postgres', true);
    select id, correct into qm from public.questions where subject_id = 'math' and kind = 'single' order by id limit 1;
    perform set_config('role', 'authenticated', true);
    v := public.practice_answer(qm.id, qm.correct, 'practice');
    r := pg_temp.t(r, 'ответ верный → 1 балл', (v->>'is_correct')::boolean and (v->>'points')::int = 1);
    v := public.practice_answer(qm.id, array[(qm.correct[1] + 1) % 4], 'practice');
    r := pg_temp.t(r, 'ответ неверный → 0, показано объяснение', not (v->>'is_correct')::boolean and v ? 'explanation');

    v := public.mistakes(null, 15);
    r := pg_temp.t(r, 'работа над ошибками: вопрос попал в список',
      exists (select 1 from jsonb_array_elements(v->'questions') e where (e->>'id')::int = qm.id));

    -- ученик не может сам продлить доступ
    begin
      update public.profiles set paid_until = now() + interval '1 year' where user_id = uid;
      ok := false;
    exception when others then ok := true;
    end;
    r := pg_temp.t(r, 'ученик не может изменить paid_until', ok);

    update public.profiles set full_name = 'Тест Ученик 2' where user_id = uid;
    r := pg_temp.t(r, 'ученик может изменить имя', (public.get_me()->>'full_name') = 'Тест Ученик 2');

    -- 3. Пробное ЕНТ
    mid := public.start_mock('full');
    v := public.get_mock(mid);
    r := pg_temp.t(r, 'пробное ЕНТ: 120 заданий', jsonb_array_length(v->'items') = 120,
      jsonb_array_length(v->'items')::text);
    r := pg_temp.t(r, 'пробное ЕНТ: по 10 заданий с несколькими ответами в профильных',
      (select count(*) from jsonb_array_elements(v->'items') e where e->>'kind' = 'multi') = 20);
    r := pg_temp.t(r, 'пробное ЕНТ: без ответов', not exists (select 1 from jsonb_array_elements(v->'items') e where e ? 'correct'));
    r := pg_temp.t(r, 'пробное ЕНТ: повторный старт продолжает тот же тест', public.start_mock('full') = mid);

    -- отвечаем правильно на все вопросы истории
    perform set_config('role', 'postgres', true);
    for qm in select q.id, q.correct from jsonb_array_elements((select items from public.mock_attempts where id = mid)) e
              join public.questions q on q.id = (e->>'q')::int where e->>'s' = 'history' loop
      perform set_config('role', 'authenticated', true);
      perform public.save_mock_answer(mid, qm.id, qm.correct);
      perform set_config('role', 'postgres', true);
    end loop;
    perform set_config('role', 'authenticated', true);
    v := public.finish_mock(mid);
    r := pg_temp.t(r, 'пробное ЕНТ: максимум 140 баллов', (v->>'max_score')::int = 140, v->>'max_score');
    r := pg_temp.t(r, 'пробное ЕНТ: история 20 из 20',
      exists (select 1 from jsonb_array_elements(v->'result'->'subjects') e where e->>'id' = 'history' and (e->>'score')::int = 20));
    r := pg_temp.t(r, 'пробное ЕНТ: не пройден (математика ниже порога)', not (v->'result'->>'passed')::boolean);
    v := public.mock_review(mid);
    r := pg_temp.t(r, 'разбор теста: есть правильные ответы и объяснения',
      (select count(*) from jsonb_array_elements(v->'items') e where e ? 'correct') = 120);

    -- 4. Без подписки
    perform set_config('role', 'postgres', true);
    update public.profiles set paid_until = now() - interval '1 day' where user_id = uid;
    update public.platform_settings set free_daily = 3 where id = 1;
    perform set_config('role', 'authenticated', true);
    r := pg_temp.t(r, 'без подписки: доступ не активен', not (public.get_me()->>'premium')::boolean);
    begin
      perform public.start_mock('full');
      ok := false;
    exception when others then ok := sqlerrm like 'Бесплатное пробное ЕНТ уже пройдено%';
    end;
    r := pg_temp.t(r, 'без подписки: второе пробное ЕНТ закрыто', ok);
    -- сегодня уже 2 ответа в тренажёре, лимит 3: один ещё можно, четвёртый — нет
    v := public.practice_answer(qm.id, qm.correct, 'practice');
    r := pg_temp.t(r, 'лимит: третий ответ принят, осталось 0', (v->>'free_left')::int = 0, v->>'free_left');
    begin
      perform public.practice_answer(qm.id, qm.correct, 'practice');
      ok := false;
    exception when others then ok := sqlerrm like 'Бесплатные задания на сегодня закончились%';
    end;
    r := pg_temp.t(r, 'лимит: сверх лимита ответ не принимается', ok);

    -- 5. Оплата
    v := public.request_payment('month', 'Тест Т.');
    pay := (v->>'id')::uuid;
    r := pg_temp.t(r, 'заявка на оплату создана', (v->>'amount')::int > 0);
    begin
      perform public.request_payment('month', 'Тест Т.');
      ok := false;
    exception when others then ok := true;
    end;
    r := pg_temp.t(r, 'вторая заявка, пока первая не проверена, не создаётся', ok);
    begin
      perform public.admin_process_payment(pay, true);
      ok := false;
    exception when others then ok := sqlerrm = 'Нет доступа';
    end;
    r := pg_temp.t(r, 'ученик не может подтвердить оплату', ok);
    begin
      perform public.admin_overview();
      ok := false;
    exception when others then ok := sqlerrm = 'Нет доступа';
    end;
    r := pg_temp.t(r, 'ученик не видит админку', ok);

    -- чужой тест недоступен
    perform set_config('request.jwt.claims', jsonb_build_object('sub', uid2, 'role', 'authenticated')::text, true);
    begin
      perform public.get_mock(mid);
      ok := false;
    exception when others then ok := sqlerrm = 'Тест не найден';
    end;
    r := pg_temp.t(r, 'чужой тест недоступен', ok);
    select count(*) into n from public.answers;
    r := pg_temp.t(r, 'чужие ответы не видны', n = 0);

    -- 6. Администратор подтверждает оплату
    perform set_config('role', 'postgres', true);
    insert into public.platform_admins (user_id) values (uid2);
    perform set_config('role', 'authenticated', true);
    v := public.admin_overview();
    r := pg_temp.t(r, 'админ: сводка открывается', (v->>'pending_payments')::int >= 1);
    v := public.admin_process_payment(pay, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', uid, 'role', 'authenticated')::text, true);
    v := public.get_me();
    r := pg_temp.t(r, 'после оплаты доступ открыт на месяц',
      (v->>'premium')::boolean and v->>'plan' = 'month' and (v->>'paid_until')::timestamptz > now() + interval '27 days');
    v := public.practice_answer(qm.id, qm.correct, 'practice');
    r := pg_temp.t(r, 'с подпиской лимита нет', v->'free_left' = 'null'::jsonb);

    -- 7. Тест по предмету
    mid := public.start_mock('physics');
    v := public.get_mock(mid);
    r := pg_temp.t(r, 'тест по физике: 40 заданий', jsonb_array_length(v->'items') = 40);
    v := public.finish_mock(mid);
    r := pg_temp.t(r, 'тест по физике: максимум 50', (v->>'max_score')::int = 50);

    perform set_config('role', 'postgres', true);
    raise exception 'talap_rollback';
  exception when others then
    if sqlerrm <> 'talap_rollback' then
      r := r || jsonb_build_object('test', 'НЕПРЕДВИДЕННАЯ ОШИБКА', 'ok', false, 'info', sqlerrm);
    end if;
  end;
  perform set_config('role', 'postgres', true);
  return query select e->>'test', (e->>'ok')::boolean, e->>'info' from jsonb_array_elements(r) e;
end $test$;
revoke execute on function private.self_test() from public, anon, authenticated;

select * from private.self_test();
