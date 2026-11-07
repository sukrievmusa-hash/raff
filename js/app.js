// Talap — кабинет ученика: тренажёр, пробное ЕНТ, работа над ошибками, бесплатно
import {
  sb, $, $$, esc, rich, money, LETTERS, pl, plural, fmtDate, fmtDateFull, fmtDateTime, daysLeft,
  toast, toastErr, errText, rpc, settings, modal, confirmBox, copyText, logoHtml, supportLink, BRAND,
} from './lib.js';
import { renderAuth } from './auth.js';

const root = $('#root');
const S = { me: null, catalog: null, settings: null, user: null };
let cleanup = null; // остановка таймеров при уходе со страницы

const ICONS = {
  home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  train: '<path d="M4 5a2 2 0 0 1 2-2h13v15H6a2 2 0 0 0-2 2z"/><path d="M4 20a2 2 0 0 0 2 2h13v-4"/><path d="M9 8h6M9 12h4"/>',
  mock: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M10 2h4"/>',
  mistakes: '<path d="M4 12a8 8 0 1 0 2.3-5.6L4 8.7"/><path d="M4 4v4.7h4.7"/><path d="M12 8v5"/><circle cx="12" cy="16.5" r=".6" fill="currentColor"/>',
  profile: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
};
const SUBJ_ICON = { history: 'Ис', mathlit: 'МГ', reading: 'Чт', math: 'М', physics: 'Ф' };

// ---------------------------------------------------------------------
//  Запуск
// ---------------------------------------------------------------------
async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    const mode = new URLSearchParams(location.search).get('mode') === 'login' ? 'login' : 'signup';
    renderAuth(root, { mode, onDone: () => location.reload() });
    return;
  }
  S.user = session.user;
  try {
    [S.me, S.catalog, S.settings] = await Promise.all([rpc('get_me'), rpc('get_catalog'), settings()]);
  } catch (e) {
    root.innerHTML = `<div class="auth-wrap"><div class="panel center stack"><h3>Не удалось загрузить кабинет</h3><p class="muted">${esc(errText(e))}</p><button class="btn btn-pri" onclick="location.reload()">Обновить</button></div></div>`;
    return;
  }
  if (!S.me) {
    await sb.auth.signOut();
    location.reload();
    return;
  }
  shell();
  window.addEventListener('hashchange', route);
  route();
}

async function refreshMe() {
  try { S.me = await rpc('get_me'); } catch { /* оставляем прежние данные */ }
  updateShell();
}
async function refreshCatalog() {
  try { S.catalog = await rpc('get_catalog'); } catch { /* ничего */ }
}

function shell() {
  root.innerHTML = `
    <header class="app-top"><div class="wrap">${logoHtml('app.html')}<div class="row" id="topRight"></div></div></header>
    <nav class="tabs" aria-label="Разделы">
      ${tab('home', 'Главная', '#/')}${tab('train', 'Тренажёр', '#/train')}${tab('mock', 'Пробное ЕНТ', '#/mock')}
      ${tab('mistakes', 'Ошибки', '#/mistakes')}${tab('profile', 'Профиль', '#/profile')}
    </nav>
    <main class="app-main"><div class="wrap" id="view"></div></main>`;
  updateShell();
}
const tab = (id, label, href) =>
  `<a href="${href}" data-tab="${id}"><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[id]}</svg><span>${label}</span></a>`;

function updateShell() {
  const me = S.me;
  const tr = $('#topRight');
  if (!tr || !me) return;
  const streak = me.streak > 0 ? `<span class="chip chip-gold" title="Дней подряд с занятиями">🔥 ${me.streak}</span>` : '';
  const access = `<a class="chip chip-gold" href="#/pay">♥ Поддержать</a>`;
  tr.innerHTML = streak + access;
}

function setTab(id) {
  $$('.tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === id));
}

function route() {
  if (cleanup) { cleanup(); cleanup = null; }
  window.scrollTo(0, 0);
  const parts = (location.hash.replace(/^#\/?/, '') || '').split('/').filter(Boolean);
  const [p0, p1, p2] = parts;
  const v = $('#view');
  if (!p0) { setTab('home'); return viewHome(v); }
  if (p0 === 'train' && !p1) { setTab('train'); return viewSubjects(v); }
  if (p0 === 'train' && p1 && !p2) { setTab('train'); return viewTopics(v, p1); }
  if (p0 === 'train' && p1 && p2) { setTab('train'); return startPractice(v, p1, p2 === 'all' ? null : Number(p2)); }
  if (p0 === 'mock' && !p1) { setTab('mock'); return viewMocks(v); }
  if (p0 === 'mock' && p1) { setTab('mock'); return viewExam(v, p1); }
  if (p0 === 'result' && p1) { setTab('mock'); return viewResult(v, p1); }
  if (p0 === 'mistakes') { setTab('mistakes'); return p1 ? startReview(v, p1 === 'all' ? null : p1) : viewMistakes(v); }
  if (p0 === 'profile') { setTab('profile'); return viewProfile(v); }
  if (p0 === 'pay') { setTab('profile'); return viewPay(v); }
  location.hash = '#/';
}

const loading = (v) => { v.innerHTML = '<div class="spinner"></div>'; };
const subjById = (id) => (S.catalog || []).find((s) => s.id === id);
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

// Окно «нужна подписка»
function paywall(text) {
  const m = modal(`<h3>Нужна подписка</h3><p class="muted">${esc(text)}</p>
    <div class="note small">Подписка — ${money(S.settings.price_month)} в месяц. Без автосписаний: продлеваете, только когда сами решите.</div>
    <div class="row-end"><button class="btn" data-a="close" type="button">Позже</button><a class="btn btn-gold" href="#/pay">Оформить подписку</a></div>`);
  $('[data-a=close]', m.el).onclick = m.close;
  $('a', m.el).onclick = () => m.close();
}
const isPaywallError = (e) => /подписк/i.test(errText(e));

// ---------------------------------------------------------------------
//  Главная
// ---------------------------------------------------------------------
async function viewHome(v) {
  loading(v);
  let st;
  try { st = await rpc('my_stats'); } catch (e) { v.innerHTML = `<div class="note note-bad">${esc(errText(e))}</div>`; return; }
  await refreshCatalog();
  const me = S.me;
  const name = (me.full_name || '').split(' ')[0];
  const accuracy = pct(st.total_ok, st.total);
  const maxDay = Math.max(1, ...st.week.map((d) => d.n));
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Almaty' });
  const weekdays = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

  // предмет с самой низкой точностью (или ещё не начатый) — для кнопки «Продолжить»
  const subjects = S.catalog || [];
  const weakest = [...subjects].sort((a, b) => (a.done ? a.ok / a.done : -1) - (b.done ? b.ok / b.done : -1))[0];

  const access = '';

  const lm = st.last_mock;
  v.innerHTML = `
    <div class="page-title"><h1>${name ? 'Сәлем, ' + esc(name) + '!' : 'Сәлем!'}</h1>
      <span class="muted">${st.today ? `Сегодня решено ${pl(st.today, 'задание', 'задания', 'заданий')}` : 'Сегодня ещё не занимались'}</span></div>
    <div class="stack-lg">
      ${access}
      ${st.active_mock ? `<div class="note row-between"><div><b>У вас есть незаконченный тест.</b> Время идёт — вернитесь и завершите его.</div><a class="btn btn-pri btn-sm" href="#/mock/${st.active_mock}">Продолжить тест</a></div>` : ''}
      <div class="grid-2">
        <div class="panel stack">
          <h3>Занятие на сегодня</h3>
          <p class="muted" style="margin:0">10 заданий — около 15 минут. Сначала новые вопросы, потом те, где были ошибки.</p>
          <div class="row">
            ${weakest ? `<a class="btn btn-pri btn-lg" href="#/train/${weakest.id}/all">${esc(weakest.short)}: 10 заданий</a>` : ''}
            <a class="btn btn-lg" href="#/train">Выбрать предмет</a>
          </div>
          ${st.mistakes ? `<a href="#/mistakes" class="small">Работа над ошибками: ${pl(st.mistakes, 'вопрос', 'вопроса', 'вопросов')}</a>` : ''}
        </div>
        <div class="panel">
          <div class="row-between" style="margin-bottom:14px">
            <div class="stat"><b>${st.streak}</b><span>${plural(st.streak, 'день', 'дня', 'дней')} подряд</span></div>
            <div class="stat"><b>${st.total}</b><span>всего ответов</span></div>
            <div class="stat"><b>${accuracy}%</b><span>верных</span></div>
          </div>
          <div class="week" aria-label="Ответы за неделю">
            ${st.week.map((d) => `<div class="${d.day === todayStr ? 'today' : ''}" title="${d.n}"><i class="${d.n ? 'has' : ''}" style="height:${Math.max(6, Math.round((d.n / maxDay) * 54))}px"></i>${weekdays[new Date(d.day + 'T12:00:00').getDay()]}</div>`).join('')}
          </div>
        </div>
      </div>
      <div class="grid-2">
        <div class="panel">
          <div class="row-between"><h3 style="margin:0">Пробное ЕНТ</h3>${lm ? `<a class="small" href="#/result/${lm.id}">Разбор</a>` : ''}</div>
          ${lm ? `<div class="row" style="margin:12px 0 8px;align-items:flex-end;gap:16px"><div class="score-big">${lm.score}<small> / ${lm.max_score}</small></div></div>
                 <p class="muted small">Последний результат, ${fmtDate(lm.finished_at)}. Порог для поступления — 50 баллов, на педагогические специальности — от 65.</p>`
               : `<p class="muted" style="margin:12px 0">120 заданий и 4 часа, как на настоящем экзамене. Узнайте свой балл и слабые темы.</p>`}
          <a class="btn ${lm ? '' : 'btn-pri'}" href="#/mock">${lm ? 'Пройти ещё раз' : 'Пройти пробное ЕНТ'}</a>
        </div>
        <div class="panel">
          <h3>Точность по предметам</h3>
          <p class="muted small">По последним 100 ответам в каждом предмете</p>
          <div>${st.by_subject.map((s) => `<div class="res-row"><span>${esc(s.title)}</span><span class="small muted">${s.answers ? pct(s.ok, s.answers) + '%' : 'нет ответов'}</span><div class="bar ${pct(s.ok, s.answers) >= 70 ? 'bar-ok' : ''}"><i style="width:${pct(s.ok, s.answers)}%"></i></div></div>`).join('')}</div>
        </div>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------
//  Тренажёр: предметы и темы
// ---------------------------------------------------------------------
async function viewSubjects(v) {
  loading(v);
  await refreshCatalog();
  const subjects = S.catalog || [];
  const block = (title, list) => `<h3 style="margin:26px 0 12px">${title}</h3><div class="list">${list.map((s) => `
    <a class="subj" href="#/train/${s.id}"><span class="ico s-${s.id}">${SUBJ_ICON[s.id] || esc(s.short[0])}</span>
      <span><h4>${esc(s.title)}</h4><div class="bar"><i style="width:${pct(s.done, s.questions)}%"></i></div></span>
      <span class="small muted">${s.done} / ${s.questions}</span></a>`).join('')}</div>`;
  v.innerHTML = `<div class="page-title"><h1>Тренажёр</h1><span class="muted">Решено вопросов из банка</span></div>
    ${!S.me.premium ? `<div class="note note-gold">Без подписки — ${pl(S.me.free_daily, 'задание', 'задания', 'заданий')} в день. Сегодня осталось: ${S.me.free_left ?? 0}.</div>` : ''}
    ${block('Обязательные предметы', subjects.filter((s) => s.kind === 'mandatory'))}
    ${block('Профильные: математика и физика', subjects.filter((s) => s.kind === 'profile'))}`;
}

async function viewTopics(v, subjectId) {
  loading(v);
  await refreshCatalog();
  const s = subjById(subjectId);
  if (!s) { location.hash = '#/train'; return; }
  const isReading = s.passages > 0 && s.id === 'reading';
  v.innerHTML = `<p><a href="#/train">Все предметы</a></p>
    <div class="page-title"><h1>${esc(s.title)}</h1><span class="muted">На ЕНТ: ${pl(s.ent_count, 'задание', 'задания', 'заданий')}, максимум ${pl(s.ent_max, 'балл', 'балла', 'баллов')}, порог ${s.threshold}</span></div>
    <div class="panel row-between" style="margin-bottom:22px">
      <div><h3 style="margin:0 0 4px">${isReading ? 'Текст и 5 вопросов к нему' : 'Все темы вперемешку'}</h3>
        <p class="muted small" style="margin:0">${isReading ? 'Как на ЕНТ: читаете текст и отвечаете на вопросы по нему' : '10 заданий: сначала новые, потом с ошибками'}</p></div>
      <a class="btn btn-pri" href="#/train/${s.id}/all">Начать</a>
    </div>
    <h3>По темам</h3>
    <div class="list">${s.topics.map((t) => `<a class="topic" href="#/train/${s.id}/${t.id}">
      <span><b>${esc(t.title)}</b><br><span class="small muted">${t.done} из ${t.questions} решено${t.done ? ', верно ' + pct(t.ok, t.done) + '%' : ''}</span></span>
      <span class="chip ${t.done && t.done === t.questions ? 'chip-ok' : ''}">${pct(t.done, t.questions)}%</span></a>`).join('') || '<p class="muted">Темы появятся, когда добавят вопросы.</p>'}</div>`;
}

async function startPractice(v, subjectId, topicId) {
  loading(v);
  let data;
  try { data = await rpc('practice_questions', { p_subject: subjectId, p_topic: topicId, p_limit: 10 }); }
  catch (e) { v.innerHTML = `<div class="note note-bad">${esc(errText(e))}</div>`; return; }
  if (!data.questions.length) {
    v.innerHTML = `<div class="empty"><h3>Вопросов пока нет</h3><p>Попробуйте другую тему.</p><a class="btn" href="#/train/${subjectId}">К темам</a></div>`;
    return;
  }
  runSession(v, {
    questions: data.questions, passages: data.passages, mode: 'practice',
    backHref: `#/train/${subjectId}`, againHref: `#/train/${subjectId}/${topicId ?? 'all'}`,
    title: subjById(subjectId)?.title || '',
  });
}

// ---------------------------------------------------------------------
//  Работа над ошибками
// ---------------------------------------------------------------------
async function viewMistakes(v) {
  loading(v);
  let data;
  try { data = await rpc('mistakes', { p_subject: null, p_limit: 1 }); }
  catch (e) { v.innerHTML = `<div class="note note-bad">${esc(errText(e))}</div>`; return; }
  const counts = data.counts || {};
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  v.innerHTML = `<div class="page-title"><h1>Работа над ошибками</h1><span class="muted">Вопросы, где последний ответ был неверным</span></div>
    ${total ? `<div class="panel row-between" style="margin-bottom:20px"><div><h3 style="margin:0">${pl(total, 'вопрос', 'вопроса', 'вопросов')} ждут повторения</h3>
      <p class="muted small" style="margin:4px 0 0">Ответите верно — вопрос уйдёт из списка</p></div><a class="btn btn-pri" href="#/mistakes/all">Повторить всё</a></div>
      <div class="list">${(S.catalog || []).filter((s) => counts[s.id]).map((s) => `
        <a class="subj" href="#/mistakes/${s.id}"><span class="ico s-${s.id}">${SUBJ_ICON[s.id]}</span><span><h4 style="margin:0">${esc(s.title)}</h4></span>
        <span class="chip chip-bad">${counts[s.id]}</span></a>`).join('')}</div>`
    : `<div class="empty panel"><h3>Ошибок нет</h3><p>Решайте задания в тренажёре — вопросы с неверными ответами появятся здесь.</p><a class="btn btn-pri" href="#/train">Открыть тренажёр</a></div>`}`;
}

async function startReview(v, subjectId) {
  loading(v);
  let data;
  try { data = await rpc('mistakes', { p_subject: subjectId, p_limit: 15 }); }
  catch (e) { v.innerHTML = `<div class="note note-bad">${esc(errText(e))}</div>`; return; }
  if (!data.questions.length) { location.hash = '#/mistakes'; return; }
  runSession(v, { questions: data.questions, passages: data.passages, mode: 'review', backHref: '#/mistakes', againHref: '#/mistakes/' + (subjectId || 'all'), title: 'Работа над ошибками' });
}

// ---------------------------------------------------------------------
//  Сессия тренажёра: вопрос → ответ → объяснение
// ---------------------------------------------------------------------
function optionsHtml(q, chosen = [], result = null) {
  return `<div class="opts ${q.kind === 'multi' ? 'multi' : ''}" role="${q.kind === 'multi' ? 'group' : 'radiogroup'}">
    ${q.options.map((o, i) => {
      let cls = chosen.includes(i) ? 'sel' : '';
      if (result) {
        const isRight = result.correct.includes(i);
        cls = isRight && chosen.includes(i) ? 'right' : !isRight && chosen.includes(i) ? 'wrong' : isRight ? 'right missed' : '';
      }
      return `<button type="button" class="opt ${cls}" data-i="${i}" ${result ? 'disabled' : ''} aria-pressed="${chosen.includes(i)}"><span class="l">${LETTERS[i]}</span><span>${rich(o)}</span></button>`;
    }).join('')}</div>`;
}

function passageHtml(p) {
  if (!p) return '';
  return `<div class="passage"><h4>${esc(p.title)}</h4>${String(p.body).split(/\n\s*\n/).map((x) => `<p>${rich(x.trim())}</p>`).join('')}</div>`;
}

function runSession(v, { questions, passages, mode, backHref, againHref, title }) {
  let idx = 0, chosen = [], result = null, busy = false;
  const log = [];

  const render = () => {
    const q = questions[idx];
    const passage = q.passage_id ? passages[q.passage_id] : null;
    v.innerHTML = `
      <div class="session-top"><a class="btn btn-sm" href="${backHref}" aria-label="Выйти из занятия">Выйти</a>
        <div class="bar"><i style="width:${pct(idx + (result ? 1 : 0), questions.length)}%"></i></div>
        <span class="small muted num">${idx + 1}/${questions.length}</span></div>
      ${passageHtml(passage)}
      <article class="q sheet">
        <div class="q-meta"><span class="chip">${esc(title)}</span>${q.topic ? `<span class="chip">${esc(q.topic)}</span>` : ''}
          ${q.kind === 'multi' ? '<span class="chip chip-gold">Несколько ответов, 2 балла</span>' : ''}</div>
        <div class="q-body">${rich(q.body)}</div>
        ${q.kind === 'multi' ? '<p class="q-hint">Выберите все верные варианты и нажмите «Ответить»</p>' : ''}
        ${optionsHtml(q, chosen, result)}
        ${result ? verdictHtml(q, result) : ''}
        <div class="row-end">
          ${result ? `<button class="btn btn-ghost btn-sm" type="button" data-a="report">Ошибка в вопросе?</button>
                      <button class="btn btn-pri btn-lg" type="button" data-a="next">${idx + 1 < questions.length ? 'Дальше' : 'Итоги'}</button>`
                   : q.kind === 'multi' ? `<button class="btn btn-pri btn-lg" type="button" data-a="check" ${chosen.length ? '' : 'disabled'}>Ответить</button>` : ''}
        </div>
      </article>`;
    $$('.opt', v).forEach((b) => (b.onclick = () => pick(Number(b.dataset.i))));
    $('[data-a=check]', v) && ($('[data-a=check]', v).onclick = check);
    $('[data-a=next]', v) && ($('[data-a=next]', v).onclick = next);
    $('[data-a=report]', v) && ($('[data-a=report]', v).onclick = () => reportQuestion(q.id));
    if (result) $('[data-a=next]', v).focus();
  };

  const pick = (i) => {
    if (result || busy) return;
    const q = questions[idx];
    if (q.kind === 'multi') {
      chosen = chosen.includes(i) ? chosen.filter((x) => x !== i) : [...chosen, i];
      render();
    } else {
      chosen = [i];
      check();
    }
  };

  const check = async () => {
    if (busy || !chosen.length) return;
    busy = true;
    const q = questions[idx];
    try {
      result = await rpc('practice_answer', { p_question: q.id, p_chosen: chosen, p_mode: mode });
      log.push({ q, ok: result.is_correct, points: result.points, max: result.max_points });
      if (result.free_left != null) S.me.free_left = result.free_left;
      render();
    } catch (e) {
      chosen = [];
      if (isPaywallError(e)) { render(); paywall(errText(e)); }
      else { toastErr(e); render(); }
    } finally { busy = false; }
  };

  const next = () => {
    if (idx + 1 < questions.length) { idx++; chosen = []; result = null; render(); window.scrollTo(0, 0); }
    else finish();
  };

  const finish = () => {
    const ok = log.filter((x) => x.ok).length;
    const pts = log.reduce((a, x) => a + x.points, 0), max = log.reduce((a, x) => a + x.max, 0);
    refreshMe();
    v.innerHTML = `<div class="panel center stack" style="max-width:560px;margin:20px auto;padding:32px 24px">
      <div class="score-big">${ok}<small> / ${log.length}</small></div>
      <h2>${ok === log.length ? 'Все ответы верные!' : ok >= log.length * 0.7 ? 'Хороший результат' : 'Есть над чем поработать'}</h2>
      <p class="muted">${pl(pts, 'балл', 'балла', 'баллов')} из ${max} по правилам ЕНТ.${ok < log.length ? ' Вопросы с ошибками сохранены в «Работе над ошибками».' : ''}</p>
      <div class="row" style="justify-content:center"><a class="btn btn-pri btn-lg" href="${againHref}" data-again>Ещё 10 заданий</a><a class="btn btn-lg" href="${backHref}">Назад</a></div>
      ${S.me && !S.me.premium && S.me.free_left === 0 ? '<div class="note note-gold small">Бесплатные задания на сегодня закончились. Завтра будут новые — или <a href="#/pay">оформите подписку</a>.</div>' : ''}
    </div>`;
    // ссылка «Ещё» совпадает с текущим адресом — перезапускаем вручную
    $('[data-again]', v).onclick = (e) => { if (location.hash === againHref) { e.preventDefault(); route(); } };
  };

  const onKey = (e) => {
    if (e.target.closest('input, textarea, .modal-wrap')) return;
    const k = e.key.toUpperCase();
    const li = LETTERS.indexOf(k);
    const ni = Number(e.key) - 1;
    const i = li >= 0 ? li : ni >= 0 && ni < 8 ? ni : -1;
    if (i >= 0 && i < questions[idx].options.length) { e.preventDefault(); pick(i); }
    else if (e.key === 'Enter') { e.preventDefault(); result ? next() : check(); }
  };
  document.addEventListener('keydown', onKey);
  cleanup = () => document.removeEventListener('keydown', onKey);
  render();
}

function verdictHtml(q, r) {
  const head = r.is_correct ? 'Верно' : r.points > 0 ? `Почти: ${r.points} из ${r.max_points} баллов` : 'Неверно';
  const right = r.correct.map((i) => LETTERS[i]).join(', ');
  return `<div class="verdict ${r.is_correct ? 'ok' : 'bad'}" role="status"><h4>${head}${r.is_correct ? '' : ` — правильный ответ: ${right}`}</h4>
    ${r.explanation ? `<p>${rich(r.explanation)}</p>` : ''}</div>`;
}

function reportQuestion(qid) {
  const m = modal(`<h3>Сообщить об ошибке</h3><p class="muted small">Неверный ответ, опечатка или непонятное условие — напишите, мы проверим вопрос.</p>
    <form class="stack"><textarea class="input" name="m" maxlength="1000" required placeholder="Что не так?"></textarea>
    <div class="row-end"><button class="btn btn-pri" type="submit">Отправить</button></div></form>`);
  $('form', m.el).onsubmit = async (e) => {
    e.preventDefault();
    try { await rpc('report_question', { p_question: qid, p_message: e.target.m.value }); toast('Спасибо! Мы проверим вопрос'); m.close(); }
    catch (err) { toastErr(err); }
  };
}

// ---------------------------------------------------------------------
//  Пробное ЕНТ: список и запуск
// ---------------------------------------------------------------------
async function viewMocks(v) {
  loading(v);
  let mocks;
  try { mocks = await rpc('my_mocks'); } catch (e) { v.innerHTML = `<div class="note note-bad">${esc(errText(e))}</div>`; return; }
  await refreshMe();
  const me = S.me;
  const subjects = S.catalog || [];
  const usedKinds = new Set(mocks.map((m) => m.kind));
  const lock = (kind) => !me.premium && usedKinds.has(kind);
  const title = (kind) => (kind === 'full' ? 'Пробное ЕНТ' : subjById(kind)?.title || kind);
  const total = subjects.reduce((a, s) => a + s.ent_max, 0);

  v.innerHTML = `<div class="page-title"><h1>Пробное ЕНТ</h1><span class="muted">Формат 2026 года</span></div>
    <div class="panel stack" style="margin-bottom:22px">
      <div class="entbar" aria-label="Распределение баллов ЕНТ">${subjects.map((s) => `<div class="s-${s.id}" style="flex:${s.ent_max}" title="${esc(s.title)}: ${s.ent_max} баллов"><b>${s.ent_max}</b><span>${esc(s.short)}</span></div>`).join('')}</div>
      <div class="entbar-legend"><span>${subjects.reduce((a, s) => a + s.ent_count, 0)} заданий, 4 часа</span><span>${total} баллов</span></div>
      <p class="muted small" style="margin:0">В профильных предметах 30 заданий с одним ответом (1 балл) и 10 с несколькими (2 балла; одна ошибка — 1 балл). Пороги: история — 5, грамотности — по 3, профильные — по 5, общий — 50.</p>
      <div class="row">
        ${lock('full') ? `<a class="btn btn-gold btn-lg" href="#/pay">Открыть по подписке</a><span class="small muted">Бесплатное пробное ЕНТ уже пройдено</span>`
                       : `<button class="btn btn-pri btn-lg" type="button" data-start="full">Начать пробное ЕНТ</button>${!me.premium ? '<span class="small muted">Первое — бесплатно</span>' : ''}`}
      </div>
    </div>
    <h3>Тест по одному предмету</h3>
    <div class="list">${subjects.map((s) => `<div class="subj" style="cursor:default"><span class="ico s-${s.id}">${SUBJ_ICON[s.id]}</span>
      <span><h4 style="margin:0">${esc(s.title)}</h4><span class="small muted">${pl(s.ent_count, 'задание', 'задания', 'заданий')}, ${s.minutes} мин</span></span>
      ${lock(s.id) ? '<a class="btn btn-sm btn-gold" href="#/pay">По подписке</a>' : `<button class="btn btn-sm" type="button" data-start="${s.id}">Начать</button>`}</div>`).join('')}</div>
    <h3 style="margin-top:28px">Мои результаты</h3>
    ${mocks.length ? `<div class="list">${mocks.map((m) => `<a class="topic" href="${m.status === 'active' ? '#/mock/' + m.id : '#/result/' + m.id}">
        <span><b>${esc(title(m.kind))}</b><br><span class="small muted">${fmtDateTime(m.started_at)}</span></span>
        ${m.status === 'active' ? '<span class="chip chip-sky">Идёт</span>' : `<span class="num" style="font-size:20px">${m.score}<span class="small muted"> / ${m.max_score}</span></span>`}</a>`).join('')}</div>`
      : '<p class="muted">Здесь появятся ваши результаты и разборы.</p>'}`;

  $$('[data-start]', v).forEach((b) => (b.onclick = async () => {
    const kind = b.dataset.start;
    const s = subjById(kind);
    const ok = await confirmBox(kind === 'full'
      ? 'Начать пробное ЕНТ? На 120 заданий даётся 4 часа. Таймер не останавливается, но ответы сохраняются — можно закрыть страницу и вернуться.'
      : `Начать тест «${s.title}»? ${pl(s.ent_count, 'задание', 'задания', 'заданий')}, ${s.minutes} минут.`, 'Начать');
    if (!ok) return;
    b.disabled = true;
    try { const id = await rpc('start_mock', { p_kind: kind }); location.hash = '#/mock/' + id; }
    catch (e) { b.disabled = false; isPaywallError(e) ? paywall(errText(e)) : toastErr(e); }
  }));
}

// ---------------------------------------------------------------------
//  Экзамен: таймер, навигация, сохранение ответов
// ---------------------------------------------------------------------
async function viewExam(v, id) {
  loading(v);
  let m;
  try { m = await rpc('get_mock', { p_id: id }); } catch (e) { v.innerHTML = `<div class="note note-bad">${esc(errText(e))}</div>`; return; }
  if (m.status === 'finished') { location.hash = '#/result/' + id; return; }

  const items = m.items;
  const answers = {};
  for (const [k, val] of Object.entries(m.answers || {})) answers[k] = val;
  const offset = new Date(m.now).getTime() - Date.now(); // разница часов с сервером
  const deadline = new Date(m.deadline).getTime();
  let cur = Number(sessionStorage.getItem('exam-pos-' + id) || 0);
  if (!(cur >= 0 && cur < items.length)) cur = 0;
  const pending = new Map(); // несохранённые ответы
  let finishing = false;

  const subjOf = (i) => items[i].s;
  const answered = (q) => (answers[q.id] || []).length > 0;

  const save = async (q) => {
    pending.set(q.id, answers[q.id] || []);
    updateSaved();
    try {
      await rpc('save_mock_answer', { p_id: id, p_question: q.id, p_chosen: answers[q.id] || [] });
      if (JSON.stringify(pending.get(q.id)) === JSON.stringify(answers[q.id] || [])) pending.delete(q.id);
    } catch (e) {
      if (/Время теста вышло/.test(errText(e))) return finish(true);
      toast('Ответ не сохранился — повторим, когда появится связь', 'err');
    }
    updateSaved();
  };
  const retry = () => { for (const qid of [...pending.keys()]) { const q = items.find((x) => x.id === qid); q && save(q); } };
  const updateSaved = () => {
    const el = $('#saved', v);
    if (el) el.textContent = pending.size ? 'Сохраняем…' : 'Ответы сохранены';
  };

  const render = () => {
    sessionStorage.setItem('exam-pos-' + id, cur);
    const q = items[cur];
    const sid = subjOf(cur);
    const inSubj = items.map((x, i) => [x, i]).filter(([x]) => x.s === sid);
    const passage = q.passage_id ? m.passages[q.passage_id] : null;
    const doneCount = items.filter(answered).length;
    v.innerHTML = `
      <div class="exam-head">
        <div class="row-between"><span class="timer" id="timer" aria-label="Осталось времени">--:--</span>
          <button class="btn btn-sm btn-pri" type="button" data-a="finish">Завершить тест</button></div>
        <div class="small muted">Отвечено ${doneCount} из ${items.length}. <span id="saved">Ответы сохранены</span></div>
      </div>
      ${m.subjects.length > 1 ? `<div class="subj-tabs">${m.subjects.map((s) => {
        const n = items.filter((x) => x.s === s.id).length, d = items.filter((x) => x.s === s.id && answered(x)).length;
        return `<button class="btn btn-sm ${s.id === sid ? 'btn-pri' : ''}" type="button" data-subj="${s.id}">${esc(s.short)} ${d}/${n}</button>`;
      }).join('')}</div>` : ''}
      <div class="qnav" style="margin-bottom:16px">${inSubj.map(([x, i], k) => `<button type="button" data-go="${i}" class="${answered(x) ? 'done' : ''} ${i === cur ? 'cur' : ''}" aria-label="Задание ${k + 1}">${k + 1}</button>`).join('')}</div>
      ${passageHtml(passage)}
      <article class="q sheet">
        <div class="q-meta"><span class="chip">${esc(m.subjects.find((s) => s.id === sid)?.title || '')}</span>
          <span class="chip">Задание ${inSubj.findIndex(([, i]) => i === cur) + 1} из ${inSubj.length}</span>
          ${q.kind === 'multi' ? '<span class="chip chip-gold">Несколько ответов, 2 балла</span>' : ''}</div>
        <div class="q-body">${rich(q.body)}</div>
        ${q.kind === 'multi' ? '<p class="q-hint">Выберите все верные варианты</p>' : ''}
        ${optionsHtml(q, answers[q.id] || [])}
        <div class="row-between" style="margin-top:18px">
          <button class="btn" type="button" data-a="prev" ${cur === 0 ? 'disabled' : ''}>Назад</button>
          ${answered(q) ? '<button class="btn btn-ghost btn-sm" type="button" data-a="clear">Сбросить ответ</button>' : ''}
          <button class="btn btn-pri" type="button" data-a="next">${cur + 1 < items.length ? 'Следующее' : 'К завершению'}</button>
        </div>
      </article>`;
    tick();
    updateSaved();
    $$('.opt', v).forEach((b) => (b.onclick = () => {
      const i = Number(b.dataset.i);
      const a = answers[q.id] || [];
      answers[q.id] = q.kind === 'multi' ? (a.includes(i) ? a.filter((x) => x !== i) : [...a, i].sort()) : [i];
      save(q);
      render();
    }));
    $$('[data-go]', v).forEach((b) => (b.onclick = () => { cur = Number(b.dataset.go); render(); }));
    $$('[data-subj]', v).forEach((b) => (b.onclick = () => { cur = items.findIndex((x) => x.s === b.dataset.subj); render(); }));
    $('[data-a=prev]', v).onclick = () => { if (cur > 0) { cur--; render(); window.scrollTo(0, 0); } };
    $('[data-a=next]', v).onclick = () => { if (cur + 1 < items.length) { cur++; render(); window.scrollTo(0, 0); } else askFinish(); };
    $('[data-a=clear]', v) && ($('[data-a=clear]', v).onclick = () => { answers[q.id] = []; save(q); render(); });
    $('[data-a=finish]', v).onclick = askFinish;
  };

  const askFinish = async () => {
    const left = items.filter((x) => !answered(x)).length;
    const ok = await confirmBox(left ? `Без ответа ${pl(left, 'задание', 'задания', 'заданий')}. Завершить тест и посмотреть результат?` : 'Завершить тест и посмотреть результат?', 'Завершить');
    if (ok) finish(false);
  };

  const finish = async (auto) => {
    if (finishing) return;
    finishing = true;
    clearInterval(timer);
    loading(v);
    // сначала дожидаемся сохранения последних ответов
    for (const [qid, val] of pending) {
      try { await rpc('save_mock_answer', { p_id: id, p_question: qid, p_chosen: val }); } catch { /* время вышло */ }
    }
    try { await rpc('finish_mock', { p_id: id }); }
    catch (e) { if (!/Тест не найден/.test(errText(e))) toastErr(e); }
    sessionStorage.removeItem('exam-pos-' + id);
    if (auto) toast('Время вышло — тест завершён');
    refreshMe();
    location.hash = '#/result/' + id;
  };

  const tick = () => {
    const leftMs = deadline - (Date.now() + offset);
    const el = $('#timer', v);
    if (leftMs <= 0) { finish(true); return; }
    if (!el) return;
    const s = Math.floor(leftMs / 1000);
    const h = Math.floor(s / 3600), mi = Math.floor((s % 3600) / 60), se = s % 60;
    el.textContent = (h ? h + ':' : '') + String(mi).padStart(2, '0') + ':' + String(se).padStart(2, '0');
    el.classList.toggle('low', s < 300);
  };
  const timer = setInterval(() => { tick(); if (pending.size && navigator.onLine) retry(); }, 1000);
  const onKey = (e) => {
    if (e.target.closest('input, textarea, .modal-wrap')) return;
    if (e.key === 'ArrowRight' && cur + 1 < items.length) { cur++; render(); }
    else if (e.key === 'ArrowLeft' && cur > 0) { cur--; render(); }
  };
  const onLeave = (e) => { if (pending.size) { e.preventDefault(); e.returnValue = ''; } };
  document.addEventListener('keydown', onKey);
  window.addEventListener('beforeunload', onLeave);
  cleanup = () => { clearInterval(timer); document.removeEventListener('keydown', onKey); window.removeEventListener('beforeunload', onLeave); };
  render();
}

// ---------------------------------------------------------------------
//  Результат и разбор теста
// ---------------------------------------------------------------------
async function viewResult(v, id) {
  loading(v);
  let r;
  try { r = await rpc('mock_review', { p_id: id }); } catch (e) { v.innerHTML = `<div class="note note-bad">${esc(errText(e))}</div>`; return; }
  const full = r.kind === 'full';
  const subjects = r.result.subjects || [];
  const passed = r.result.passed;
  let filter = 'all', sid = subjects[0]?.id, cur = null;

  const status = (it) => (it.points >= it.max_points ? 'r-ok' : it.points > 0 ? 'r-part' : 'r-bad');

  const renderReview = () => {
    const list = r.items.map((it, i) => [it, i]).filter(([it]) => it.s === sid && (filter === 'all' || it.points < it.max_points));
    if (cur == null || !list.some(([, i]) => i === cur)) cur = list[0]?.[1] ?? null;
    const box = $('#review', v);
    if (cur == null) { box.innerHTML = '<p class="muted">Здесь ошибок нет.</p>'; return; }
    const it = r.items[cur];
    const chosen = it.chosen || [];
    box.innerHTML = `
      <div class="qnav" style="margin-bottom:14px">${list.map(([x, i]) => `<button type="button" data-go="${i}" class="${status(x)} ${i === cur ? 'cur' : ''}">${r.items.filter((y) => y.s === sid).indexOf(x) + 1}</button>`).join('')}</div>
      ${passageHtml(it.passage_id ? r.passages[it.passage_id] : null)}
      <article class="q sheet">
        <div class="q-meta"><span class="chip ${it.points >= it.max_points ? 'chip-ok' : it.points ? 'chip-gold' : 'chip-bad'}">${it.points} из ${it.max_points}</span>
          ${it.topic ? `<span class="chip">${esc(it.topic)}</span>` : ''}${!chosen.length ? '<span class="chip">Без ответа</span>' : ''}</div>
        <div class="q-body">${rich(it.body)}</div>
        ${optionsHtml(it, chosen, { correct: it.correct })}
        ${it.explanation ? `<div class="verdict"><h4>Объяснение</h4><p>${rich(it.explanation)}</p></div>` : ''}
        <div class="row-end"><button class="btn btn-ghost btn-sm" type="button" data-a="report">Ошибка в вопросе?</button></div>
      </article>`;
    $$('[data-go]', box).forEach((b) => (b.onclick = () => { cur = Number(b.dataset.go); renderReview(); }));
    $('[data-a=report]', box).onclick = () => reportQuestion(it.id);
  };

  v.innerHTML = `<p><a href="#/mock">Все тесты</a></p>
    <div class="grid-2" style="align-items:start">
      <div class="panel stack">
        <span class="muted">${full ? 'Пробное ЕНТ' : esc(subjects[0]?.title || '')}, ${fmtDateTime(r.finished_at)}</span>
        <div class="score-big">${r.score}<small> / ${r.max_score}</small></div>
        ${full ? `<div class="note ${passed ? 'note-ok' : 'note-bad'}">${passed ? 'Пороги пройдены: этого достаточно для участия в конкурсе на поступление (от 50 баллов).' : 'Пока ниже порога: нужно не меньше 50 баллов в сумме и пороговый балл по каждому предмету.'}</div>` : ''}
        <a class="btn btn-pri" href="#/mistakes">Работа над ошибками</a>
      </div>
      <div class="panel">
        <h3>По предметам</h3>
        ${subjects.map((s) => `<div class="res-row"><span>${esc(s.title)} ${s.passed ? '' : '<span class="chip chip-bad">ниже порога</span>'}</span>
          <span class="num">${s.score}<span class="small muted"> / ${s.max}</span></span>
          <div class="bar ${s.passed ? 'bar-ok' : ''}"><i style="width:${pct(s.score, s.max)}%"></i></div></div>`).join('')}
      </div>
    </div>
    <h2 style="margin-top:30px">Разбор заданий</h2>
    <div class="row-between" style="margin-bottom:12px">
      ${subjects.length > 1 ? `<div class="subj-tabs" style="margin:0">${subjects.map((s) => `<button class="btn btn-sm" type="button" data-subj="${s.id}">${esc(s.short)}</button>`).join('')}</div>` : '<span></span>'}
      <div class="seg"><button type="button" data-f="all">Все</button><button type="button" data-f="bad">Только ошибки</button></div>
    </div>
    <div id="review"></div>`;
  const syncTabs = () => {
    $$('[data-subj]', v).forEach((b) => b.classList.toggle('btn-pri', b.dataset.subj === sid));
    $$('[data-f]', v).forEach((b) => b.classList.toggle('on', b.dataset.f === filter));
  };
  $$('[data-subj]', v).forEach((b) => (b.onclick = () => { sid = b.dataset.subj; cur = null; syncTabs(); renderReview(); }));
  $$('[data-f]', v).forEach((b) => (b.onclick = () => { filter = b.dataset.f; cur = null; syncTabs(); renderReview(); }));
  syncTabs();
  renderReview();
}

// ---------------------------------------------------------------------
//  Профиль
// ---------------------------------------------------------------------
async function viewProfile(v) {
  await refreshMe();
  const me = S.me;
  const bot = S.settings.bot_username;
  const hours = Array.from({ length: 16 }, (_, i) => i + 7);
  v.innerHTML = `<div class="page-title"><h1>Профиль</h1><span class="muted">${esc(me.email)}</span></div>
    <div class="grid-2" style="align-items:start">
      <div class="stack-lg">
        <div class="panel stack">
          <h3>Поддержать автора</h3>
          <p class="small muted" style="margin:0">Talap бесплатный. Если он вам помог, можно поддержать автора любой суммой — по желанию.</p>
          <a class="btn btn-gold" href="#/pay">Поддержать</a>
        </div>
        <div class="panel stack">
          <h3>Напоминания в Telegram</h3>
          ${!bot ? '<p class="muted small" style="margin:0">Скоро здесь можно будет подключить бота с напоминаниями.</p>'
            : me.tg_connected
              ? `<p class="small" style="margin:0">Подключено. Бот напомнит о занятии, если в этот день вы ещё не решали задания.</p>
                 <label class="field"><span>Время напоминания</span><select class="input" id="hour"><option value="">Не напоминать</option>${hours.map((h) => `<option value="${h}" ${me.remind_hour === h ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('')}</select></label>
                 <button class="btn btn-sm btn-ghost" type="button" id="unlink" style="align-self:flex-start">Отключить Telegram</button>`
              : `<p class="small muted" style="margin:0">Бот напомнит о занятии вечером и сообщит, когда откроется доступ.</p>
                 <a class="btn btn-pri" target="_blank" rel="noopener" href="https://t.me/${esc(bot)}?start=s_${esc(me.tg_link_code)}">Подключить Telegram</a>
                 <button class="btn btn-sm btn-ghost" type="button" id="tgcheck" style="align-self:flex-start">Я подключил — проверить</button>`}
        </div>
      </div>
      <div class="stack-lg">
        <form class="panel stack" id="pf">
          <h3>Данные</h3>
          <label class="field"><span>Имя и фамилия</span><input class="input" name="full_name" maxlength="80" value="${esc(me.full_name || '')}"></label>
          <label class="field"><span>Класс</span><select class="input" name="grade">${[['11', '11 класс'], ['10', '10 класс'], ['9', '9 класс'], ['grad', 'Окончил(а) школу']].map(([k, t]) => `<option value="${k}" ${me.grade === k ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
          <label class="field"><span>Телефон</span><input class="input" name="phone" type="tel" maxlength="20" value="${esc(me.phone || '')}"></label>
          <label class="field"><span>Цель на ЕНТ, баллов</span><input class="input" name="target_score" type="number" min="50" max="140" value="${me.target_score ?? ''}" placeholder="например, 110"></label>
          <button class="btn btn-pri" type="submit">Сохранить</button>
        </form>
        <form class="panel stack" id="pw">
          <h3>Пароль</h3>
          <label class="field"><span>Новый пароль (минимум 6 символов)</span><input class="input" name="p" type="password" autocomplete="new-password" minlength="6"></label>
          <button class="btn" type="submit">Сменить пароль</button>
        </form>
        <div class="row">
          ${me.is_admin ? '<a class="btn" href="admin.html">Админка</a>' : ''}
          ${S.settings.support_contact ? `<a class="btn" target="_blank" rel="noopener" href="${esc(supportLink(S.settings.support_contact, 'Здравствуйте! Вопрос по Talap'))}">Поддержка</a>` : ''}
          <button class="btn btn-danger" type="button" id="logout">Выйти</button>
        </div>
      </div>
    </div>`;

  $('#pf', v).onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const ts = f.target_score.value ? Number(f.target_score.value) : null;
    if (ts != null && (ts < 50 || ts > 140)) return toastErr('Цель — от 50 до 140 баллов');
    const { error } = await sb.from('profiles').update({
      full_name: f.full_name.value.trim().slice(0, 80) || null, grade: f.grade.value,
      phone: f.phone.value.trim().slice(0, 20) || null, target_score: ts,
    }).eq('user_id', me.user_id);
    if (error) return toastErr(error);
    toast('Сохранено');
    refreshMe();
  };
  $('#pw', v).onsubmit = async (e) => {
    e.preventDefault();
    const p = e.target.p.value;
    if (p.length < 6) return toastErr('Минимум 6 символов');
    const { error } = await sb.auth.updateUser({ password: p });
    if (error) return toastErr(error);
    e.target.reset();
    toast('Пароль изменён');
  };
  $('#logout', v).onclick = async () => { await sb.auth.signOut(); location.href = 'index.html'; };
  $('#hour', v) && ($('#hour', v).onchange = async (e) => {
    const { error } = await sb.from('profiles').update({ remind_hour: e.target.value === '' ? null : Number(e.target.value) }).eq('user_id', me.user_id);
    error ? toastErr(error) : toast('Время напоминания сохранено');
  });
  $('#unlink', v) && ($('#unlink', v).onclick = async () => {
    try { await rpc('unlink_tg'); toast('Telegram отключён'); viewProfile(v); } catch (e) { toastErr(e); }
  });
  $('#tgcheck', v) && ($('#tgcheck', v).onclick = async () => {
    await refreshMe();
    S.me.tg_connected ? (toast('Telegram подключён'), viewProfile(v)) : toast('Пока не видим подключения. Нажмите «Старт» в боте', 'err');
  });
}

// ---------------------------------------------------------------------
//  Оплата подписки через Kaspi
// ---------------------------------------------------------------------
async function viewPay(v) {
  loading(v);
  S.settings = await settings();
  const s = S.settings;
  v.innerHTML = `<p><a href="#/profile">Профиль</a></p>
    <div class="page-title"><h1>Поддержать автора</h1></div>
    <div class="grid-2" style="align-items:start">
      <div class="panel stack">
        <h3>Talap бесплатный</h3>
        <p class="small" style="margin:0">Все задания, пробные ЕНТ и разбор ошибок открыты без оплаты и без ограничений. Платформу делает один человек: если она вам помогла, вы можете поддержать автора — на хостинг, новые задания и казахскую версию.</p>
        <p class="small muted" style="margin:0">Сумма любая, на ваше усмотрение, и это не обязательно. Ничего не откроется и не закроется от того, поддержали вы или нет. Это добровольный подарок, а не плата за услугу.</p>
      </div>
      <div class="panel stack">
        <h3>Перевод через Kaspi</h3>
        ${s.kaspi_details ? `<div class="code" style="font-size:15px">${esc(s.kaspi_details)}</div><button class="btn btn-gold" type="button" id="copyk" style="align-self:flex-start">Скопировать реквизиты</button>`
                          : '<div class="note small">Реквизиты ещё не указаны.</div>'}
        <p class="small muted" style="margin:0">Откройте Kaspi.kz → Платежи → Перевод по номеру телефона и укажите любую сумму. Спасибо и да воздаст вам Аллах благом!</p>
        ${s.support_contact ? `<p class="small muted" style="margin:0">Вопросы и ошибки в заданиях: <a target="_blank" rel="noopener" href="${esc(supportLink(s.support_contact, 'Здравствуйте! Вопрос по Talap'))}">${esc(s.support_contact)}</a></p>` : ''}
      </div>
    </div>`;
  $('#copyk', v) && ($('#copyk', v).onclick = () => copyText(s.kaspi_details));
}

sb.auth.onAuthStateChange((ev) => { if (ev === 'SIGNED_OUT') location.href = 'index.html'; });
boot();
