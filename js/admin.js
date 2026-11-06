// Talap — админка платформы: ученики, оплаты, банк вопросов, настройки
import {
  sb, $, $$, esc, money, LETTERS, pl, fmtDate, fmtDateFull, fmtDateTime, toast, toastErr, errText,
  rpc, settings, modal, confirmBox, copyText, logoHtml, normPhone,
} from './lib.js';
import { renderAuth } from './auth.js';

const root = $('#root');
const A = { subjects: [], settings: {} };
const SUBJ = (id) => A.subjects.find((s) => s.id === id);

async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    renderAuth(root, { mode: 'login', allowSignup: false, title: 'Вход в админку', onDone: () => location.reload() });
    return;
  }
  const isAdmin = await rpc('is_admin').catch(() => false);
  if (!isAdmin) return noAccess(session.user.email);
  const { data: subjects } = await sb.from('subjects').select('*').order('sort');
  A.subjects = subjects || [];
  A.settings = await settings();
  root.innerHTML = `
    <header class="app-top"><div class="wrap">${logoHtml('index.html')}
      <div class="row"><a class="btn btn-sm" href="app.html">Кабинет ученика</a><button class="btn btn-sm btn-ghost" id="logout" type="button">Выйти</button></div></div></header>
    <nav class="tabs" aria-label="Разделы админки" style="grid-template-columns:repeat(6,1fr)">
      ${[['', 'Обзор'], ['students', 'Ученики'], ['payments', 'Оплаты'], ['questions', 'Вопросы'], ['reports', 'Ошибки'], ['settings', 'Настройки']]
        .map(([k, t]) => `<a href="#/${k}" data-tab="${k}"><span>${t}</span><b class="dot hide" data-dot="${k}"></b></a>`).join('')}
    </nav>
    <main class="app-main"><div class="wrap" id="view"></div></main>`;
  $('#logout').onclick = async () => { await sb.auth.signOut(); location.reload(); };
  window.addEventListener('hashchange', route);
  route();
}

function noAccess(email) {
  root.innerHTML = `<div class="auth-wrap"><div class="auth-card"><div class="center" style="margin-bottom:20px">${logoHtml()}</div>
    <form class="panel stack" id="cf"><h2>Нет доступа</h2>
      <p class="muted small">Вы вошли как ${esc(email)}. Если вам выдали код администратора, введите его.</p>
      <label class="field"><span>Код администратора</span><input class="input" name="code" type="password" required></label>
      <button class="btn btn-pri btn-block" type="submit">Получить доступ</button>
      <button class="btn btn-ghost btn-block" type="button" id="out">Войти под другим аккаунтом</button></form></div></div>`;
  $('#cf').onsubmit = async (e) => {
    e.preventDefault();
    try { await rpc('claim_admin', { p_code: e.target.code.value }); location.reload(); } catch (err) { toastErr(err); }
  };
  $('#out').onclick = async () => { await sb.auth.signOut(); location.reload(); };
}

function route() {
  const [p0] = (location.hash.replace(/^#\/?/, '') || '').split('/');
  $$('.tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === (p0 || '')));
  const v = $('#view');
  v.innerHTML = '<div class="spinner"></div>';
  const views = { '': viewOverview, students: viewStudents, payments: viewPayments, questions: viewQuestions, reports: viewReports, settings: viewSettings };
  (views[p0] || viewOverview)(v).catch((e) => { v.innerHTML = `<div class="note note-bad">${esc(errText(e))}</div>`; });
}

function setDot(key, n) {
  const d = $(`[data-dot="${key}"]`);
  if (!d) return;
  d.textContent = n;
  d.classList.toggle('hide', !n);
}

// ---------------------------------------------------------------------
async function viewOverview(v) {
  const o = await rpc('admin_overview');
  setDot('payments', o.pending_payments);
  setDot('reports', o.reports_new);
  const tg = await rpc('admin_tg_info');
  const todo = [];
  if (!A.settings.kaspi_details) todo.push('Укажите реквизиты Kaspi — без них ученики не смогут оплатить подписку');
  if (!A.settings.support_contact) todo.push('Укажите контакт поддержки (WhatsApp или @telegram)');
  if (!A.settings.site_url) todo.push('Укажите адрес сайта — он нужен для кнопок в сообщениях бота');
  if (!tg.token_set) todo.push('Подключите Telegram-бота: напоминания ученикам и уведомления вам');
  else if (!tg.admin_chat_connected) todo.push('Подключите свой Telegram, чтобы получать заявки на оплату');
  v.innerHTML = `<div class="page-title"><h1>Обзор</h1><span class="muted">${fmtDateFull(Date.now())}</span></div>
    ${todo.length ? `<div class="note note-gold" style="margin-bottom:20px"><b>Осталось настроить</b><ul style="margin:6px 0 0;padding-left:20px">${todo.map((t) => `<li>${t}</li>`).join('')}</ul>
      <a class="btn btn-sm" style="margin-top:10px" href="#/settings">Открыть настройки</a></div>` : ''}
    ${o.pending_payments ? `<div class="note row-between" style="margin-bottom:20px"><b>Заявок на оплату ждут проверки: ${o.pending_payments}</b><a class="btn btn-pri btn-sm" href="#/payments">Проверить</a></div>` : ''}
    <div class="kpis">
      <div class="kpi"><b>${o.students}</b><span>учеников, +${o.new_7d} за неделю</span></div>
      <div class="kpi"><b>${o.paid}</b><span>с оплаченной подпиской</span></div>
      <div class="kpi"><b>${o.trial}</b><span>на пробном доступе</span></div>
      <div class="kpi"><b>${money(o.paid_30d)}</b><span>оплат за 30 дней</span></div>
      <div class="kpi"><b>${o.active_today}</b><span>занимались сегодня</span></div>
      <div class="kpi"><b>${o.active_7d}</b><span>занимались за 7 дней</span></div>
      <div class="kpi"><b>${o.answers_7d}</b><span>ответов за 7 дней</span></div>
      <div class="kpi"><b>${o.mocks_7d}</b><span>пробных тестов за 7 дней</span></div>
    </div>
    <h3 style="margin-top:28px">Банк вопросов: ${o.questions}</h3>
    <div class="kpis">${A.subjects.map((s) => `<a class="kpi" href="#/questions" data-s="${s.id}" style="text-decoration:none;color:inherit"><b>${o.by_subject[s.id] || 0}</b><span>${esc(s.title)}${(o.by_subject[s.id] || 0) < s.ent_count * 3 ? ' — мало для разных вариантов' : ''}</span></a>`).join('')}</div>
    <p class="small muted" style="margin-top:12px">Чтобы пробные ЕНТ не повторялись, держите в каждом предмете хотя бы втрое больше вопросов, чем в тесте: 60 по истории, 30 по грамотностям, 120 по профильным.</p>`;
  $$('[data-s]', v).forEach((a) => (a.onclick = () => sessionStorage.setItem('adm-subj', a.dataset.s)));
}

// ---------------------------------------------------------------------
async function viewStudents(v) {
  v.innerHTML = `<div class="page-title"><h1>Ученики</h1></div>
    <div class="row" style="margin-bottom:14px"><input class="input" id="q" placeholder="Поиск по имени, email или телефону" style="max-width:420px"></div>
    <div id="list"><div class="spinner"></div></div>`;
  let timer;
  const load = async () => {
    const list = await rpc('admin_students', { p_search: $('#q').value });
    $('#list').innerHTML = list.length ? `<div class="table-wrap"><table class="t"><thead><tr>
      <th>Ученик</th><th>Доступ</th><th>Ответов</th><th>Тестов</th><th>Активность</th><th>Регистрация</th></tr></thead><tbody>
      ${list.map((s, i) => `<tr class="click" data-i="${i}">
        <td><b>${esc(s.full_name || '—')}</b>${s.tg ? ' <span class="chip chip-sky">TG</span>' : ''}<br><span class="small muted">${esc(s.email)}${s.phone ? ', ' + esc(s.phone) : ''}</span></td>
        <td>${s.is_blocked ? '<span class="chip chip-bad">Заблокирован</span>' : s.premium ? `<span class="chip ${s.plan === 'trial' ? '' : 'chip-ok'}">${planTitle(s.plan)} до ${fmtDate(s.paid_until)}</span>` : '<span class="chip">Бесплатный</span>'}</td>
        <td>${s.answers}<br><span class="small muted">${s.answers_7d} за неделю</span></td>
        <td>${s.mocks}</td>
        <td class="small">${s.last_active_at ? fmtDateTime(s.last_active_at) : '—'}</td>
        <td class="small">${fmtDate(s.created_at)}</td></tr>`).join('')}</tbody></table></div>`
      : '<div class="empty">Учеников пока нет.</div>';
    $$('tr[data-i]').forEach((tr) => (tr.onclick = () => editStudent(list[Number(tr.dataset.i)], load)));
  };
  $('#q').oninput = () => { clearTimeout(timer); timer = setTimeout(() => load().catch(toastErr), 300); };
  await load();
}
const planTitle = (p) => ({ trial: 'Пробный', month: 'Подписка', quarter: 'Подписка', gift: 'Подарок' }[p] || p);

function editStudent(s, reload) {
  const d = new Date(s.paid_until);
  const iso = (x) => new Date(x.getTime() - x.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const m = modal(`<h3>${esc(s.full_name || s.email)}</h3>
    <p class="small muted">${esc(s.email)}${s.phone ? ', ' + esc(s.phone) : ''}. Класс: ${s.grade === 'grad' ? 'выпускник' : esc(s.grade)}.</p>
    <form class="stack" id="sf">
      <label class="field"><span>Доступ открыт до</span><input class="input" type="date" name="until" value="${iso(d)}"></label>
      <div class="row"><button class="btn btn-sm" type="button" data-add="1">+1 месяц</button><button class="btn btn-sm" type="button" data-add="3">+3 месяца</button><button class="btn btn-sm" type="button" data-add="0">Закрыть доступ</button></div>
      <label class="field"><span>Тариф</span><select class="input" name="plan">
        ${['trial', 'month', 'quarter', 'gift'].map((p) => `<option value="${p}" ${s.plan === p ? 'selected' : ''}>${{ trial: 'Пробный', month: '1 месяц', quarter: '3 месяца', gift: 'Подарок (бесплатно)' }[p]}</option>`).join('')}</select></label>
      <label class="check"><input type="checkbox" name="blocked" ${s.is_blocked ? 'checked' : ''}><span>Заблокировать аккаунт</span></label>
      <div class="row-end"><button class="btn btn-ghost" type="button" id="reset">Новый пароль</button><button class="btn btn-pri" type="submit">Сохранить</button></div>
    </form>`);
  const f = $('#sf', m.el);
  $$('[data-add]', m.el).forEach((b) => (b.onclick = () => {
    const n = Number(b.dataset.add);
    if (!n) { f.until.value = iso(new Date(Date.now() - 86400000)); return; }
    const base = new Date(Math.max(Date.now(), new Date(f.until.value).getTime()));
    base.setMonth(base.getMonth() + n);
    f.until.value = iso(base);
    if (f.plan.value === 'trial') f.plan.value = 'gift';
  }));
  f.onsubmit = async (e) => {
    e.preventDefault();
    try {
      // доступ до конца выбранного дня по Алматы
      const until = new Date(f.until.value + 'T23:59:00+05:00').toISOString();
      await rpc('admin_set_access', { p_user: s.user_id, p_paid_until: until, p_blocked: f.blocked.checked, p_plan: f.plan.value });
      toast('Сохранено'); m.close(); reload();
    } catch (err) { toastErr(err); }
  };
  $('#reset', m.el).onclick = async () => {
    if (!(await confirmBox('Выдать ученику новый пароль? Старый перестанет работать.', 'Выдать'))) return;
    const { data, error } = await sb.functions.invoke('account', { body: { action: 'reset_password', user_id: s.user_id } });
    if (error || !data?.ok) {
      let msg = error?.message || data?.error;
      try { msg = (await error.context.json()).error || msg; } catch { /* без тела */ }
      return toastErr(msg);
    }
    const text = `Здравствуйте! Ваш новый пароль от Talap: ${data.password}\nВход: ${A.settings.site_url ? A.settings.site_url.replace(/\/$/, '') + '/app.html' : 'app.html'}\nEmail: ${s.email}\nСмените пароль в профиле после входа.`;
    const ph = normPhone(s.phone);
    modal(`<h3>Новый пароль</h3><p>Пароль: <b class="num" style="font-size:20px">${esc(data.password)}</b></p>
      <div class="code">${esc(text)}</div>
      <div class="row-end"><button class="btn" type="button" id="cp">Скопировать сообщение</button>
      ${ph ? `<a class="btn btn-pri" target="_blank" rel="noopener" href="https://wa.me/${ph}?text=${encodeURIComponent(text)}">Отправить в WhatsApp</a>` : ''}</div>`,
    { onOpen: (el) => { $('#cp', el).onclick = () => copyText(text); } });
  };
}

// ---------------------------------------------------------------------
async function viewPayments(v) {
  const list = await rpc('admin_payments');
  setDot('payments', list.filter((p) => p.status === 'pending').length);
  const ST = { pending: ['Ждёт проверки', 'chip-sky'], approved: ['Подтверждена', 'chip-ok'], rejected: ['Отклонена', 'chip-bad'] };
  v.innerHTML = `<div class="page-title"><h1>Оплаты</h1></div>
    <p class="muted small">Откройте Kaspi, найдите перевод на нужную сумму от указанного отправителя и подтвердите заявку. Доступ продлится сам, ученику придёт сообщение в Telegram.</p>
    ${list.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>Ученик</th><th>Сумма</th><th>Отправитель в Kaspi</th><th>Создана</th><th>Статус</th><th></th></tr></thead><tbody>
      ${list.map((p) => `<tr><td><b>${esc(p.full_name || '—')}</b><br><span class="small muted">${esc(p.email)}${p.phone ? ', ' + esc(p.phone) : ''}</span></td>
        <td><b>${money(p.amount)}</b><br><span class="small muted">${p.months === 1 ? '1 месяц' : '3 месяца'}</span></td>
        <td>${esc(p.payer_note || '')}</td><td class="small">${fmtDateTime(p.created_at)}</td>
        <td><span class="chip ${ST[p.status][1]}">${ST[p.status][0]}</span></td>
        <td>${p.status === 'pending' ? `<div class="row" style="flex-wrap:nowrap"><button class="btn btn-sm btn-pri" data-ok="${p.id}" type="button">Подтвердить</button><button class="btn btn-sm" data-no="${p.id}" type="button">Отклонить</button></div>` : ''}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">Заявок пока нет.</div>'}`;
  const act = async (id, ok) => {
    if (!ok && !(await confirmBox('Отклонить заявку? Ученик получит сообщение, что перевод не найден.', 'Отклонить'))) return;
    try { await rpc('admin_process_payment', { p_id: id, p_approve: ok }); toast(ok ? 'Оплата подтверждена, доступ продлён' : 'Заявка отклонена'); viewPayments(v); }
    catch (e) { toastErr(e); }
  };
  $$('[data-ok]', v).forEach((b) => (b.onclick = () => act(b.dataset.ok, true)));
  $$('[data-no]', v).forEach((b) => (b.onclick = () => act(b.dataset.no, false)));
}

// ---------------------------------------------------------------------
//  Банк вопросов
// ---------------------------------------------------------------------
async function viewQuestions(v) {
  let subject = sessionStorage.getItem('adm-subj') || A.subjects[0]?.id;
  let topic = '', search = '', onlyOff = false;
  v.innerHTML = `<div class="page-title"><h1>Вопросы</h1>
      <div class="row"><button class="btn btn-sm" type="button" id="imp">Импорт JSON</button><button class="btn btn-sm" type="button" id="exp">Экспорт</button>
      <button class="btn btn-sm" type="button" id="pas">Тексты</button><button class="btn btn-sm btn-pri" type="button" id="add">Добавить вопрос</button></div></div>
    <div class="row" style="margin-bottom:14px">
      <select class="input" id="fs" style="width:auto">${A.subjects.map((s) => `<option value="${s.id}">${esc(s.title)}</option>`).join('')}</select>
      <select class="input" id="ft" style="width:auto"></select>
      <input class="input" id="fq" placeholder="Поиск по тексту" style="max-width:260px">
      <label class="check small"><input type="checkbox" id="fo"><span>Только выключенные</span></label>
    </div>
    <div id="list"><div class="spinner"></div></div>`;
  $('#fs').value = subject;
  let topics = [], passages = [], stats = {}, qs = [];

  const loadMeta = async () => {
    const [t, p, st] = await Promise.all([
      sb.from('topics').select('*').eq('subject_id', subject).order('sort'),
      sb.from('passages').select('id, title').eq('subject_id', subject).order('id'),
      rpc('admin_question_stats', { p_subject: subject }),
    ]);
    topics = t.data || []; passages = p.data || []; stats = st || {};
    $('#ft').innerHTML = `<option value="">Все темы</option>${topics.map((x) => `<option value="${x.id}">${esc(x.title)}</option>`).join('')}<option value="none">Без темы</option>`;
    $('#ft').value = topic;
  };
  const load = async () => {
    let q = sb.from('questions').select('*').eq('subject_id', subject).order('id');
    if (topic === 'none') q = q.is('topic_id', null); else if (topic) q = q.eq('topic_id', Number(topic));
    if (onlyOff) q = q.eq('is_active', false);
    if (search) q = q.ilike('body', `%${search}%`);
    const { data, error } = await q.limit(1000);
    if (error) throw error;
    qs = data;
    const tname = (id) => topics.find((x) => x.id === id)?.title || '';
    $('#list').innerHTML = qs.length ? `<p class="small muted">${pl(qs.length, 'вопрос', 'вопроса', 'вопросов')}. Процент — доля верных ответов учеников: слишком низкий может означать ошибку в ответе.</p>
      <div class="table-wrap"><table class="t"><thead><tr><th>#</th><th>Вопрос</th><th>Тема</th><th>Ответов</th><th></th></tr></thead><tbody>
      ${qs.map((x, i) => { const st = stats[x.id]; const rate = st ? Math.round((st.ok / st.n) * 100) : null;
        return `<tr class="click" data-i="${i}"><td class="small muted">${x.id}</td>
        <td>${esc(x.body.length > 140 ? x.body.slice(0, 140) + '…' : x.body)}${x.kind === 'multi' ? ' <span class="chip chip-gold">несколько</span>' : ''}${x.passage_id ? ' <span class="chip">текст</span>' : ''}${x.is_active ? '' : ' <span class="chip chip-bad">выключен</span>'}</td>
        <td class="small">${esc(tname(x.topic_id))}</td>
        <td class="small">${st ? `${st.n}, <span class="${rate < 30 && st.n >= 10 ? 'chip chip-bad' : ''}">${rate}%</span>` : '—'}</td>
        <td class="small muted">${'●'.repeat(x.difficulty)}</td></tr>`; }).join('')}</tbody></table></div>`
      : '<div class="empty">Вопросов нет.</div>';
    $$('tr[data-i]', v).forEach((tr) => (tr.onclick = () => editQuestion(qs[Number(tr.dataset.i)], { subject, topics, passages, onSaved: refresh })));
  };
  const refresh = async () => { await loadMeta(); await load(); };
  $('#fs').onchange = () => { subject = $('#fs').value; sessionStorage.setItem('adm-subj', subject); topic = ''; refresh().catch(toastErr); };
  $('#ft').onchange = () => { topic = $('#ft').value; load().catch(toastErr); };
  let tm; $('#fq').oninput = () => { clearTimeout(tm); tm = setTimeout(() => { search = $('#fq').value.trim(); load().catch(toastErr); }, 300); };
  $('#fo').onchange = () => { onlyOff = $('#fo').checked; load().catch(toastErr); };
  $('#add').onclick = () => editQuestion(null, { subject, topics, passages, onSaved: refresh });
  $('#imp').onclick = () => importDialog(refresh);
  $('#exp').onclick = () => exportBank(subject);
  $('#pas').onclick = () => passagesDialog(subject, refresh);
  await refresh();
}

function editQuestion(q, { subject, topics, passages, onSaved }) {
  const isNew = !q;
  q = q || { subject_id: subject, kind: 'single', body: '', options: ['', '', '', ''], correct: [], explanation: '', difficulty: 1, is_active: true, topic_id: null, passage_id: null };
  const m = modal(`<h3>${isNew ? 'Новый вопрос' : 'Вопрос #' + q.id}</h3>
    <form class="stack" id="qf">
      <div class="grid-2">
        <label class="field"><span>Тема</span><select class="input" name="topic"><option value="">Без темы</option>${topics.map((t) => `<option value="${t.id}" ${q.topic_id === t.id ? 'selected' : ''}>${esc(t.title)}</option>`).join('')}<option value="new">+ Новая тема…</option></select></label>
        <label class="field"><span>Тип</span><select class="input" name="kind"><option value="single" ${q.kind === 'single' ? 'selected' : ''}>Один ответ (1 балл)</option><option value="multi" ${q.kind === 'multi' ? 'selected' : ''}>Несколько ответов (2 балла)</option></select></label>
      </div>
      <label class="field hide" id="newTopic"><span>Название новой темы</span><input class="input" name="new_topic" maxlength="120"></label>
      ${passages.length ? `<label class="field"><span>Текст (для заданий по тексту)</span><select class="input" name="passage"><option value="">Без текста</option>${passages.map((p) => `<option value="${p.id}" ${q.passage_id === p.id ? 'selected' : ''}>${esc(p.title)}</option>`).join('')}</select></label>` : ''}
      <label class="field"><span>Условие</span><textarea class="input" name="body" rows="4" required>${esc(q.body)}</textarea></label>
      <label class="field"><span>Варианты ответа — каждый с новой строки (от 2 до 8)</span><textarea class="input" name="options" rows="6">${esc(q.options.join('\n'))}</textarea></label>
      <div class="field"><span>Правильный ответ</span><div class="row" id="corr"></div></div>
      <label class="field"><span>Объяснение (видно ученику после ответа)</span><textarea class="input" name="explanation" rows="3">${esc(q.explanation || '')}</textarea></label>
      <div class="row-between">
        <label class="field" style="flex:1;max-width:220px"><span>Сложность</span><select class="input" name="difficulty">${[1, 2, 3].map((d) => `<option value="${d}" ${q.difficulty === d ? 'selected' : ''}>${['Базовая', 'Средняя', 'Высокая'][d - 1]}</option>`).join('')}</select></label>
        <label class="check"><input type="checkbox" name="active" ${q.is_active ? 'checked' : ''}><span>Показывать ученикам</span></label>
      </div>
      <div class="row-end">${isNew ? '' : '<button class="btn btn-danger" type="button" id="del">Удалить</button>'}<button class="btn btn-pri" type="submit">Сохранить</button></div>
    </form>`, { wide: true });
  const f = $('#qf', m.el);
  let correct = [...q.correct];
  const drawCorrect = () => {
    const opts = f.options.value.split('\n').map((x) => x.trim()).filter(Boolean);
    correct = correct.filter((i) => i < opts.length);
    const type = f.kind.value === 'multi' ? 'checkbox' : 'radio';
    $('#corr', m.el).innerHTML = opts.map((o, i) => `<label class="check"><input type="${type}" name="c" value="${i}" ${correct.includes(i) ? 'checked' : ''}><span><b>${LETTERS[i]}</b> ${esc(o.length > 30 ? o.slice(0, 30) + '…' : o)}</span></label>`).join('') || '<span class="small muted">Сначала впишите варианты</span>';
    $$('input[name=c]', m.el).forEach((c) => (c.onchange = () => { correct = $$('input[name=c]:checked', m.el).map((x) => Number(x.value)); }));
  };
  f.options.oninput = drawCorrect;
  f.kind.onchange = () => { if (f.kind.value === 'single') correct = correct.slice(0, 1); drawCorrect(); };
  f.topic.onchange = () => $('#newTopic', m.el).classList.toggle('hide', f.topic.value !== 'new');
  drawCorrect();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const options = f.options.value.split('\n').map((x) => x.trim()).filter(Boolean);
    if (!correct.length) return toastErr('Отметьте правильный ответ');
    try {
      let topic_id = f.topic.value && f.topic.value !== 'new' ? Number(f.topic.value) : null;
      if (f.topic.value === 'new') {
        const title = f.new_topic.value.trim();
        if (title.length < 2) return toastErr('Введите название темы');
        const { data, error } = await sb.from('topics').insert({ subject_id: q.subject_id, title, sort: topics.length + 1 }).select().single();
        if (error) throw error;
        topic_id = data.id;
      }
      const row = {
        subject_id: q.subject_id, topic_id, passage_id: f.passage && f.passage.value ? Number(f.passage.value) : null,
        kind: f.kind.value, body: f.body.value.trim(), options, correct, explanation: f.explanation.value.trim() || null,
        difficulty: Number(f.difficulty.value), is_active: f.active.checked,
      };
      const { error } = isNew ? await sb.from('questions').insert(row) : await sb.from('questions').update(row).eq('id', q.id);
      if (error) throw error;
      toast('Вопрос сохранён'); m.close(); onSaved();
    } catch (err) { toastErr(err); }
  };
  $('#del', m.el) && ($('#del', m.el).onclick = async () => {
    if (!(await confirmBox('Удалить вопрос вместе с ответами учеников на него? Чтобы просто скрыть, снимите галочку «Показывать ученикам».', 'Удалить'))) return;
    const { error } = await sb.from('questions').delete().eq('id', q.id);
    if (error) return toastErr(error);
    toast('Вопрос удалён'); m.close(); onSaved();
  });
}

const IMPORT_EXAMPLE = `[
  {
    "subject": "math",
    "topic": "Проценты",
    "questions": [
      {
        "body": "Найдите 15 % от 200.",
        "options": ["15", "30", "20", "45"],
        "answer": "B",
        "explanation": "200 · 0,15 = 30."
      },
      {
        "kind": "multi",
        "body": "Выберите чётные числа.",
        "options": ["2", "3", "4", "7", "10", "11"],
        "answer": "ACE",
        "explanation": "Чётные: 2, 4, 10."
      }
    ]
  }
]`;

function importDialog(onDone) {
  const m = modal(`<h3>Импорт вопросов</h3>
    <p class="small muted">Вставьте JSON или выберите файл. Предметы: ${A.subjects.map((s) => `<b>${s.id}</b> — ${esc(s.title)}`).join(', ')}.
      Ответ — буквы вариантов (A, B, … или «AC» для нескольких). Для заданий по тексту добавьте в блок <b>"passage": {"title": "…", "body": "…"}</b>.
      Варианты перемешиваются автоматически; повторы пропускаются.</p>
    <input type="file" accept=".json,application/json" id="file" class="input">
    <textarea class="input code" id="json" rows="14" placeholder='${esc(IMPORT_EXAMPLE)}'></textarea>
    <div class="row-end"><button class="btn" type="button" id="ex">Вставить пример</button><button class="btn btn-pri" type="button" id="go">Импортировать</button></div>`, { wide: true });
  $('#file', m.el).onchange = async (e) => { const fl = e.target.files[0]; if (fl) $('#json', m.el).value = await fl.text(); };
  $('#ex', m.el).onclick = () => { $('#json', m.el).value = IMPORT_EXAMPLE; };
  $('#go', m.el).onclick = async () => {
    let data;
    try { data = JSON.parse($('#json', m.el).value); } catch (e) { return toastErr('JSON не читается: ' + e.message); }
    try {
      const r = await rpc('admin_import_questions', { p: data });
      toast(`Добавлено: ${r.added}${r.skipped ? `, пропущено повторов: ${r.skipped}` : ''}`);
      m.close(); onDone();
    } catch (e) { toastErr(e); }
  };
}

async function exportBank(subject) {
  const [{ data: qs, error }, { data: topics }, { data: passages }] = await Promise.all([
    sb.from('questions').select('*').eq('subject_id', subject).order('id'),
    sb.from('topics').select('*').eq('subject_id', subject),
    sb.from('passages').select('*').eq('subject_id', subject),
  ]);
  if (error) return toastErr(error);
  const blocks = new Map();
  for (const q of qs) {
    const key = `${q.topic_id || ''}|${q.passage_id || ''}`;
    if (!blocks.has(key)) {
      const b = { subject, topic: topics.find((t) => t.id === q.topic_id)?.title || undefined, questions: [] };
      const p = passages.find((x) => x.id === q.passage_id);
      if (p) b.passage = { title: p.title, body: p.body };
      blocks.set(key, b);
    }
    blocks.get(key).questions.push({
      kind: q.kind, body: q.body, options: q.options, answer: q.correct.map((i) => LETTERS[i]).join(''),
      explanation: q.explanation || undefined, difficulty: q.difficulty, shuffle: false,
    });
  }
  const blob = new Blob([JSON.stringify([...blocks.values()], null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `talap-${subject}-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function passagesDialog(subject, onDone) {
  const { data: list, error } = await sb.from('passages').select('*').eq('subject_id', subject).order('id');
  if (error) return toastErr(error);
  const m = modal(`<h3>Тексты: ${esc(SUBJ(subject)?.title || '')}</h3>
    <p class="small muted">Тексты для заданий на понимание прочитанного. Вопросы к тексту добавляются в форме вопроса или импортом.</p>
    <div class="list" id="pl">${list.map((p, i) => `<button type="button" class="topic" data-i="${i}"><span><b>${esc(p.title)}</b><br><span class="small muted">${p.body.length} символов</span></span></button>`).join('') || '<p class="muted">Текстов нет.</p>'}</div>
    <form class="stack" id="pf" style="margin-top:18px"><h4 id="ph">Новый текст</h4>
      <label class="field"><span>Заголовок</span><input class="input" name="title" maxlength="160" required></label>
      <label class="field"><span>Текст (абзацы разделяйте пустой строкой)</span><textarea class="input" name="body" rows="10" required></textarea></label>
      <div class="row-end"><button class="btn btn-pri" type="submit">Сохранить текст</button></div></form>`, { wide: true });
  let editId = null;
  const f = $('#pf', m.el);
  $$('[data-i]', m.el).forEach((b) => (b.onclick = () => {
    const p = list[Number(b.dataset.i)];
    editId = p.id; f.title.value = p.title; f.body.value = p.body; $('#ph', m.el).textContent = 'Редактирование текста';
  }));
  f.onsubmit = async (e) => {
    e.preventDefault();
    const row = { subject_id: subject, title: f.title.value.trim(), body: f.body.value.trim() };
    if (row.body.length < 50) return toastErr('Текст слишком короткий');
    const { error: err } = editId ? await sb.from('passages').update(row).eq('id', editId) : await sb.from('passages').insert(row);
    if (err) return toastErr(err);
    toast('Текст сохранён'); m.close(); onDone();
  };
}

// ---------------------------------------------------------------------
async function viewReports(v) {
  const list = await rpc('admin_reports');
  setDot('reports', list.filter((r) => r.status === 'new').length);
  v.innerHTML = `<div class="page-title"><h1>Сообщения об ошибках</h1></div>
    ${list.length ? `<div class="list">${list.map((r, i) => `<div class="panel stack">
      <div class="row-between"><span class="chip ${r.status === 'new' ? 'chip-bad' : 'chip-ok'}">${r.status === 'new' ? 'Новое' : 'Разобрано'}</span>
        <span class="small muted">${esc(SUBJ(r.subject_id)?.title || '')}, вопрос #${r.question_id}, ${fmtDateTime(r.created_at)}${r.email ? ', ' + esc(r.email) : ''}</span></div>
      <p style="margin:0"><b>${esc(r.message)}</b></p>
      <p class="small muted" style="margin:0">${esc(r.question_body.slice(0, 220))}</p>
      <div class="row"><button class="btn btn-sm" type="button" data-open="${i}">Открыть вопрос</button>
        ${r.status === 'new' ? `<button class="btn btn-sm btn-pri" type="button" data-done="${r.id}">Разобрано</button>` : ''}</div></div>`).join('')}</div>`
      : '<div class="empty">Сообщений нет. Ученики могут сообщить об ошибке после ответа на любой вопрос.</div>'}`;
  $$('[data-done]', v).forEach((b) => (b.onclick = async () => {
    const { error } = await sb.from('question_reports').update({ status: 'done' }).eq('id', Number(b.dataset.done));
    error ? toastErr(error) : viewReports(v);
  }));
  $$('[data-open]', v).forEach((b) => (b.onclick = async () => {
    const r = list[Number(b.dataset.open)];
    const [{ data: q }, { data: topics }, { data: passages }] = await Promise.all([
      sb.from('questions').select('*').eq('id', r.question_id).single(),
      sb.from('topics').select('*').eq('subject_id', r.subject_id).order('sort'),
      sb.from('passages').select('id, title').eq('subject_id', r.subject_id),
    ]);
    if (q) editQuestion(q, { subject: r.subject_id, topics: topics || [], passages: passages || [], onSaved: () => viewReports(v) });
  }));
}

// ---------------------------------------------------------------------
async function viewSettings(v) {
  const s = A.settings = await settings();
  const tg = await rpc('admin_tg_info');
  const suggested = location.href.replace(/admin\.html.*$/, '').replace(/\/$/, '');
  v.innerHTML = `<div class="page-title"><h1>Настройки</h1></div>
    <div class="grid-2" style="align-items:start">
      <form class="panel stack" id="sf">
        <h3>Платформа и оплата</h3>
        <label class="field"><span>Реквизиты Kaspi (видят ученики при оплате)</span><textarea class="input" name="kaspi_details" rows="3" placeholder="Kaspi Gold: +7 700 000 00 00, Айдар С.">${esc(s.kaspi_details || '')}</textarea></label>
        <label class="field"><span>Контакт поддержки: номер WhatsApp или @telegram</span><input class="input" name="support_contact" value="${esc(s.support_contact || '')}" placeholder="+7 700 000 00 00"></label>
        <label class="field"><span>Адрес сайта</span><input class="input" name="site_url" value="${esc(s.site_url || '')}" placeholder="${esc(suggested)}"></label>
        ${!s.site_url ? `<button class="btn btn-sm btn-ghost btn-wrap" type="button" id="useUrl" style="align-self:flex-start;text-align:left">Подставить ${esc(suggested)}</button>` : ''}
        <div class="grid-2">
          <label class="field"><span>Цена за 1 месяц, ₸</span><input class="input" name="price_month" type="number" min="0" value="${s.price_month}"></label>
          <label class="field"><span>Цена за 3 месяца, ₸</span><input class="input" name="price_quarter" type="number" min="0" value="${s.price_quarter}"></label>
          <label class="field"><span>Пробный доступ, дней</span><input class="input" name="trial_days" type="number" min="0" max="30" value="${s.trial_days}"></label>
          <label class="field"><span>Бесплатных заданий в день</span><input class="input" name="free_daily" type="number" min="0" max="500" value="${s.free_daily}"></label>
        </div>
        <label class="field"><span>Название</span><input class="input" name="brand" value="${esc(s.brand)}"></label>
        <button class="btn btn-pri" type="submit">Сохранить</button>
      </form>
      <div class="stack-lg">
        <div class="panel stack">
          <h3>Telegram-бот</h3>
          ${tg.token_set ? `<p class="small" style="margin:0">Подключён бот <a href="https://t.me/${esc(tg.bot_username)}" target="_blank" rel="noopener">@${esc(tg.bot_username)}</a>. <span id="tgst" class="muted"></span></p>` : '<p class="small muted" style="margin:0">Создайте бота в @BotFather командой /newbot и вставьте токен.</p>'}
          <form class="row" id="tf"><input class="input" name="token" placeholder="123456789:AA…" style="flex:1;min-width:200px" autocomplete="off"><button class="btn" type="submit">${tg.token_set ? 'Заменить' : 'Подключить'}</button></form>
          ${tg.token_set ? `<div class="sep"></div>
            <p class="small" style="margin:0">${tg.admin_chat_connected ? 'Ваш Telegram подключён: сюда приходят новые ученики, заявки на оплату и сообщения об ошибках.' : 'Подключите свой Telegram, чтобы сразу узнавать о заявках на оплату.'}</p>
            <div class="row"><a class="btn ${tg.admin_chat_connected ? '' : 'btn-pri'}" target="_blank" rel="noopener" href="https://t.me/${esc(tg.bot_username)}?start=adm_${esc(tg.admin_link_code)}">${tg.admin_chat_connected ? 'Переподключить' : 'Подключить мой Telegram'}</a>
            ${tg.admin_chat_connected ? '<button class="btn" type="button" id="test">Тестовое сообщение</button>' : ''}</div>` : ''}
        </div>
        <form class="panel stack" id="cf">
          <h3>Код администратора</h3>
          <p class="small muted" style="margin:0">По этому коду ещё один человек сможет получить доступ к админке: он регистрируется как ученик и вводит код на странице admin.html.</p>
          <input class="input" name="code" type="password" minlength="8" placeholder="Новый код, минимум 8 символов" autocomplete="new-password">
          <button class="btn" type="submit">Сохранить код</button>
        </form>
      </div>
    </div>`;

  $('#useUrl', v) && ($('#useUrl', v).onclick = () => { $('#sf', v).site_url.value = suggested; });
  $('#sf', v).onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const row = {
      kaspi_details: f.kaspi_details.value.trim() || null, support_contact: f.support_contact.value.trim() || null,
      site_url: f.site_url.value.trim().replace(/\/$/, '') || null, brand: f.brand.value.trim() || 'Talap',
      price_month: Number(f.price_month.value), price_quarter: Number(f.price_quarter.value),
      trial_days: Number(f.trial_days.value), free_daily: Number(f.free_daily.value),
    };
    const { error } = await sb.from('platform_settings').update(row).eq('id', 1);
    if (error) return toastErr(error);
    toast('Настройки сохранены');
    viewSettings(v);
  };
  $('#tf', v).onsubmit = async (e) => {
    e.preventDefault();
    const token = e.target.token.value.trim();
    if (!token) return;
    const { data, error } = await sb.functions.invoke('tg', { body: { action: 'setup', token } });
    if (error || !data?.ok) {
      let msg = error?.message || data?.error;
      try { msg = (await error.context.json()).error || msg; } catch { /* без тела */ }
      return toastErr(msg);
    }
    toast(`Бот @${data.username} подключён`);
    viewSettings(v);
  };
  $('#test', v) && ($('#test', v).onclick = async () => { try { await rpc('admin_test_message'); toast('Отправлено — проверьте Telegram'); } catch (e) { toastErr(e); } });
  $('#cf', v).onsubmit = async (e) => {
    e.preventDefault();
    try { await rpc('admin_set_code', { p_code: e.target.code.value }); e.target.reset(); toast('Код сохранён'); } catch (err) { toastErr(err); }
  };
  if (tg.token_set) {
    const { data } = await sb.functions.invoke('tg', { body: { action: 'status' } });
    const el = $('#tgst', v);
    if (el && data) el.textContent = data.url_ok ? (data.last_error ? 'Последняя ошибка: ' + data.last_error : 'Работает.') : 'Webhook не настроен — нажмите «Заменить» с тем же токеном.';
  }
}

boot();
