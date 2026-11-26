import { $, api, initTheme } from './shared.js';

initTheme();
const form = $('#login-form');
const error = $('#login-error');
if (new URLSearchParams(location.search).has('expired')) {
  error.textContent = '登录已过期，内存中的帐号数据已清除，请重新登录。';
  error.hidden = false;
}
$('#toggle-password').addEventListener('click', event => {
  const showing = $('#password').type === 'password';
  $('#password').type = showing ? 'text' : 'password';
  event.currentTarget.textContent = showing ? '隐藏' : '显示';
  event.currentTarget.setAttribute('aria-pressed', String(showing));
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (form.dataset.busy) return;
  form.dataset.busy = 'true';
  const submit = $('#login-submit');
  submit.disabled = true;
  submit.textContent = '正在登录…';
  error.hidden = true;
  try {
    await api('/api/auth/login', { method: 'POST', body: {
      username: form.elements.username.value.trim(),
      password: form.elements.password.value,
      remember: form.elements.remember.checked,
    } });
    form.elements.password.value = '';
    location.replace('/');
  } catch (reason) {
    error.textContent = reason.message;
    error.hidden = false;
    form.elements.password.focus();
  } finally {
    delete form.dataset.busy;
    submit.disabled = false;
    submit.textContent = '登 录';
  }
});
window.addEventListener('pagehide', () => { form.elements.password.value = ''; });
