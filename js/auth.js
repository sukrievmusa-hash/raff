// Экран входа и регистрации — общий для кабинета ученика и админки
import { sb, $, $$, esc, toastErr, logoHtml, settings, supportLink } from './lib.js';

export function renderAuth(root, { mode = 'signup', onDone, allowSignup = true, title } = {}) {
  root.innerHTML = `<div class="auth-wrap"><div class="auth-card">
    <div class="center" style="margin-bottom:20px">${logoHtml()}</div>
    <div class="panel">
      ${allowSignup ? '<div class="seg" style="margin-bottom:18px"><button type="button" data-m="signup">Регистрация</button><button type="button" data-m="login">Вход</button></div>' : ''}
      <form id="af" class="stack" novalidate>
        <div><h2 id="at" style="margin-bottom:4px"></h2><p class="muted small" id="as" style="margin:0"></p></div>
        <label class="field su"><span>Имя и фамилия</span><input class="input" name="full_name" autocomplete="name" maxlength="80"></label>
        <label class="field"><span>Email</span><input class="input" name="email" type="email" autocomplete="email" inputmode="email" required></label>
        <label class="field"><span>Пароль</span><input class="input" name="password" type="password" minlength="6" required></label>
        <label class="field su"><span>Класс</span><select class="input" name="grade">
          <option value="11">11 класс</option><option value="10">10 класс</option><option value="9">9 класс</option><option value="grad">Уже окончил(а) школу</option></select></label>
        <label class="field su"><span>Телефон (необязательно — для восстановления пароля)</span><input class="input" name="phone" type="tel" autocomplete="tel" inputmode="tel" placeholder="+7 7__ ___ __ __"></label>
        <label class="check small su"><input type="checkbox" name="agree" checked><span>Принимаю <a href="terms.html" target="_blank">условия</a> и <a href="terms.html#privacy" target="_blank">политику конфиденциальности</a></span></label>
        <button class="btn btn-pri btn-block btn-lg" type="submit" id="ab"></button>
        <button class="btn btn-ghost btn-block" type="button" id="alt"></button>
      </form>
      <div id="forgot" class="hide stack center">
        <h3>Восстановление пароля</h3>
        <p class="muted" id="forgotText"></p>
        <a class="btn btn-pri btn-block hide" id="supportLink" target="_blank" rel="noopener">Написать в поддержку</a>
        <button class="btn btn-block" type="button" id="backLogin">Вернуться ко входу</button>
      </div>
    </div></div></div>`;

  const f = $('#af', root);
  const setMode = (m) => {
    mode = m;
    $$('[data-m]', root).forEach((b) => b.classList.toggle('on', b.dataset.m === m));
    $$('.su', root).forEach((el) => el.classList.toggle('hide', m !== 'signup'));
    f.password.autocomplete = m === 'signup' ? 'new-password' : 'current-password';
    const T = {
      login: [title || 'Вход', 'Введите email и пароль', 'Войти', 'Забыли пароль?'],
      signup: ['Начать подготовку', 'Бесплатно, без карты. Первые дни — полный доступ', 'Создать аккаунт', 'Уже есть аккаунт? Войти'],
    }[m];
    $('#at', root).textContent = T[0];
    $('#as', root).textContent = T[1];
    $('#ab', root).textContent = T[2];
    $('#alt', root).textContent = T[3];
  };
  $$('[data-m]', root).forEach((b) => (b.onclick = () => setMode(b.dataset.m)));
  $('#alt', root).onclick = async () => {
    if (mode !== 'login') return setMode('login');
    const s = await settings();
    const c = s.support_contact || '';
    f.classList.add('hide');
    $('.seg', root)?.classList.add('hide');
    $('#forgot', root).classList.remove('hide');
    $('#forgotText', root).textContent = c
      ? `Напишите в поддержку: ${c}. Укажите email аккаунта — пришлём новый пароль.`
      : 'Напишите в поддержку — пришлём новый пароль.';
    const link = supportLink(c, 'Здравствуйте! Забыл(а) пароль от Talap, мой email: ' + (f.email.value || ''));
    if (link) { const a = $('#supportLink', root); a.href = link; a.classList.remove('hide'); }
  };
  $('#backLogin', root).onclick = () => {
    $('#forgot', root).classList.add('hide');
    $('.seg', root)?.classList.remove('hide');
    f.classList.remove('hide');
    setMode('login');
  };
  setMode(allowSignup ? mode : 'login');

  f.onsubmit = async (e) => {
    e.preventDefault();
    const email = f.email.value.trim().toLowerCase();
    const password = f.password.value;
    if (!/^\S+@\S+\.\S+$/.test(email)) return toastErr('Проверьте email');
    if (password.length < 6) return toastErr('Пароль — минимум 6 символов');
    if (mode === 'signup') {
      if (f.full_name.value.trim().length < 2) return toastErr('Укажите имя');
      if (!f.agree.checked) return toastErr('Нужно принять условия');
    }
    const btn = $('#ab', root);
    btn.disabled = true;
    try {
      if (mode === 'signup') {
        // Аккаунт создаётся сразу подтверждённым — письмо не нужно
        const { error } = await sb.functions.invoke('account', {
          body: { action: 'signup', email, password, full_name: f.full_name.value.trim(), grade: f.grade.value, phone: f.phone.value },
        });
        if (error) {
          let msg = error.message;
          try { msg = (await error.context.json()).error || msg; } catch { /* без тела */ }
          throw new Error(msg);
        }
      }
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      onDone && onDone();
    } catch (err) {
      toastErr(err);
    } finally {
      btn.disabled = false;
    }
  };
}
