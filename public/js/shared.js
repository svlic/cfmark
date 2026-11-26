export const $ = (selector, parent = document) => parent.querySelector(selector);

// All dynamic content is assigned as text, never parsed as HTML.
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

export function button(text, handler, className = 'secondary') {
  const node = el('button', className, text);
  node.type = 'button';
  node.addEventListener('click', handler);
  return node;
}

let onUnauthorized = () => {};
export function setUnauthorizedHandler(handler) { onUnauthorized = handler; }

export async function api(path, { method = 'GET', body, download = false } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method, credentials: 'same-origin', cache: 'no-store',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new Error('网络连接中断，请检查网络后重试。保存失败时，请先刷新确认是否已保存。');
  }
  let payload;
  if (response.ok && download) return response.blob();
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `请求失败（${response.status}），请稍后重试。`);
    error.code = payload?.error?.code;
    error.fields = payload?.error?.fields;
    error.status = response.status;
    if (response.status === 401 && !path.endsWith('/auth/login')) {
      onUnauthorized();
      location.replace('/login.html?expired=1');
    }
    throw error;
  }
  if (!payload || !Object.hasOwn(payload, 'data')) throw new Error('服务器响应格式异常，请刷新后重试。');
  return payload.data;
}

export function initTheme() {
  let theme = 'system';
  try { theme = localStorage.getItem('account-space-theme') || 'system'; } catch { /* storage may be disabled */ }
  if (!['light', 'dark', 'system'].includes(theme)) theme = 'system';
  applyTheme(theme);
  const select = $('#theme');
  if (select) {
    select.value = theme;
    select.addEventListener('change', () => {
      applyTheme(select.value);
      try { localStorage.setItem('account-space-theme', select.value); } catch { /* in-memory theme still works */ }
    });
  }
}

export function applyTheme(theme) { document.documentElement.dataset.theme = theme; }

export function toast(message, error = false) {
  const activeDialog = [...document.querySelectorAll('dialog[open]')].at(-1);
  const region = activeDialog ? $('.dialog-body', activeDialog) : $('#toasts');
  if (!region) return;
  region.querySelectorAll('.toast').forEach(node => node.remove());
  const node = el('div', `toast${error ? ' toast-error' : ''}${activeDialog ? ' inline-toast' : ''}`, message);
  if (activeDialog) { node.setAttribute('role', error ? 'alert' : 'status'); region.prepend(node); }
  else region.append(node);
  setTimeout(() => node.remove(), 5500);
}

export function modal(title, { wide = false } = {}) {
  const previous = document.activeElement;
  const dialog = el('dialog', wide ? 'dialog wide' : 'dialog');
  const header = el('header', 'dialog-header');
  const heading = el('h2', '', title);
  heading.id = `dialog-${++modal.serial}`;
  dialog.setAttribute('aria-labelledby', heading.id);
  const close = button('关闭 ×', () => { if (!dialog.dataset.busy) dialog.close(); }, 'quiet');
  dialog.addEventListener('cancel', event => { if (dialog.dataset.busy) event.preventDefault(); });
  header.append(heading, close);
  const body = el('div', 'dialog-body');
  dialog.append(header, body);
  document.body.append(dialog);
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (previous?.isConnected) previous.focus();
  }, { once: true });
  // Call show after content is ready, so native focus targets the first field.
  return { dialog, body, show: () => dialog.showModal() };
}
modal.serial = 0;

export function confirmAction(title, message, label = '确认', danger = false) {
  return new Promise(resolve => {
    const { dialog, body, show } = modal(title);
    body.append(el('p', 'confirm-message', message));
    const actions = el('div', 'form-actions');
    actions.append(button('取消', () => dialog.close()), button(label, () => dialog.close('confirmed'), danger ? 'danger' : 'primary'));
    body.append(actions);
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirmed'), { once: true });
    show();
  });
}

export function field(label, name, value = '', options = {}) {
  const wrapper = el('label', `field${options.full ? ' span-two' : ''}`, label);
  const input = el(options.multiline ? 'textarea' : 'input');
  input.setAttribute('aria-label', label);
  input.name = name;
  input.value = value ?? '';
  if (!options.multiline) input.type = options.type || 'text';
  if (options.max) input.maxLength = options.max;
  if (options.required) input.required = true;
  if (options.placeholder) input.placeholder = options.placeholder;
  if (options.list) input.setAttribute('list', options.list);
  wrapper.append(input);
  if (options.hint) wrapper.append(el('small', 'muted', options.hint));
  const error = el('small', 'field-error');
  error.dataset.errorFor = name;
  wrapper.append(error);
  return { wrapper, input };
}

export function showFormError(form, error) {
  const summary = $('.form-error', form);
  if (summary) { summary.hidden = false; summary.textContent = error.message; }
  form.querySelectorAll('[data-error-for]').forEach(node => {
    const value = error.fields?.[node.dataset.errorFor];
    node.textContent = Array.isArray(value) ? value.join('；') : value || '';
  });
  if (summary) { summary.tabIndex = -1; summary.focus(); }
}

export function safeURL(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

export async function copyText(value) {
  try { await navigator.clipboard.writeText(value); toast('已复制到剪贴板'); }
  catch { toast('无法访问剪贴板，请选中文字手动复制。', true); }
}
