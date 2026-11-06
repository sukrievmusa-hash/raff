import { CONFIG } from './config.js';

export const sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});
export const BRAND = CONFIG.BRAND;

export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Текст вопроса: экранируем и сохраняем переносы строк
export const rich = (s) => esc(s).replace(/\n/g, '<br>');

export const money = (n) => (n == null ? '' : Number(n).toLocaleString('ru-RU').replace(/ |,/g, ' ') + ' ₸');
export const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}
export const pl = (n, one, few, many) => `${n} ${plural(n, one, few, many)}`;

const TZ = 'Asia/Almaty';
export const fmtDate = (ts) => new Date(ts).toLocaleDateString('ru-RU', { timeZone: TZ, day: 'numeric', month: 'long' });
export const fmtDateFull = (ts) => new Date(ts).toLocaleDateString('ru-RU', { timeZone: TZ, day: 'numeric', month: 'long', year: 'numeric' });
export const fmtDateTime = (ts) => new Date(ts).toLocaleString('ru-RU', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
export const daysLeft = (ts) => Math.ceil((new Date(ts) - Date.now()) / 86400000);

export function normPhone(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  if (d.length === 10) d = '7' + d;
  return d.length >= 11 && d.length <= 15 ? d : null;
}
export function fmtPhone(d) {
  d = String(d || '').replace(/\D/g, '');
  if (/^7\d{10}$/.test(d)) return `+7 ${d.slice(1, 4)} ${d.slice(4, 7)} ${d.slice(7, 9)} ${d.slice(9, 11)}`;
  return d ? '+' + d : '';
}
// Ссылка на поддержку по контакту из настроек: @telegram или номер WhatsApp
export function supportLink(contact, text = '') {
  const c = String(contact || '');
  const tg = c.match(/@([A-Za-z0-9_]{4,})/);
  if (tg) return `https://t.me/${tg[1]}`;
  const ph = normPhone(c);
  return ph ? `https://wa.me/${ph}${text ? '?text=' + encodeURIComponent(text) : ''}` : '';
}

// ---------- Уведомления ----------
let toastBox;
export function toast(msg, kind = 'ok') {
  if (!toastBox) {
    toastBox = document.createElement('div');
    toastBox.className = 'toasts';
    toastBox.setAttribute('role', 'status');
    toastBox.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastBox);
  }
  const t = document.createElement('div');
  t.className = 'toast toast-' + kind;
  t.textContent = msg;
  toastBox.appendChild(t);
  setTimeout(() => t.classList.add('out'), kind === 'err' ? 5200 : 2800);
  setTimeout(() => t.remove(), kind === 'err' ? 5600 : 3200);
}
export function errText(e) {
  const m = String(e?.message || e?.error_description || e || 'Ошибка');
  if (/Invalid login credentials/i.test(m)) return 'Неверный email или пароль';
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'Нет связи с сервером. Проверьте интернет и попробуйте ещё раз';
  if (/JWT expired|not authenticated/i.test(m)) return 'Сессия истекла — войдите снова';
  return m;
}
export const toastErr = (e) => toast(errText(e), 'err');

export async function rpc(fn, args = {}) {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw error;
  return data;
}

export async function settings() {
  const { data } = await sb.from('platform_settings').select('*').eq('id', 1).maybeSingle();
  return data || {};
}

// ---------- Модальное окно ----------
export function modal(html, { onOpen, wide = false } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap';
  wrap.innerHTML = `<div class="modal${wide ? ' modal-wide' : ''}" role="dialog" aria-modal="true">
    <button class="modal-x" type="button" aria-label="Закрыть">×</button>${html}</div>`;
  const prev = document.activeElement;
  const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); prev && prev.focus && prev.focus(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  $('.modal-x', wrap).onclick = close;
  document.addEventListener('keydown', onKey);
  document.body.appendChild(wrap);
  const first = wrap.querySelector('input, textarea, select, button:not(.modal-x)');
  first && first.focus();
  onOpen && onOpen(wrap, close);
  return { el: wrap, close };
}

export function confirmBox(text, okText = 'Да') {
  return new Promise((res) => {
    const m = modal(`<p class="lead">${esc(text)}</p>
      <div class="row-end"><button class="btn" data-a="no" type="button">Отмена</button>
      <button class="btn btn-pri" data-a="yes" type="button">${esc(okText)}</button></div>`);
    $('[data-a=no]', m.el).onclick = () => { m.close(); res(false); };
    $('[data-a=yes]', m.el).onclick = () => { m.close(); res(true); };
  });
}

export async function copyText(t) {
  try { await navigator.clipboard.writeText(t); toast('Скопировано'); }
  catch { prompt('Скопируйте:', t); }
}

export const logoHtml = (href = 'index.html') =>
  `<a class="logo" href="${href}" aria-label="${esc(BRAND)} — на главную"><svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9" fill="currentColor"/><path d="M9 10h14M16 10v13" stroke="#fff" stroke-width="3.2" stroke-linecap="round"/><circle cx="23" cy="22" r="2.6" fill="#E8B31C"/></svg><span>${esc(BRAND)}</span></a>`;
