import { $, el, button, api, initTheme, toast, setUnauthorizedHandler, confirmAction, modal, copyText, safeURL } from './shared.js';
import { emailsFor, identity, compareName, filterAccounts, groupAccounts, recentAccounts } from './model.js';
import { editAccount } from './editor.js';
import { openSettings } from './settings.js';

initTheme();
const state = { accounts: [], platforms: [], categories: [], tags: [], view: 'platform', group: null, ready: false };
let generation = 0;
let expired = false;
let loading = false;
function clearPrivateData() {
  generation++;
  state.accounts = []; state.platforms = []; state.categories = []; state.tags = [];
  state.group = null;
  state.ready = false;
  document.querySelectorAll('dialog').forEach(node => node.close());
  $('#content').replaceChildren();
  $('#breadcrumb').replaceChildren();
  $('#toasts').replaceChildren();
  $('#search').value = '';
  $('#category-filter').replaceChildren();
  $('#tag-filter').replaceChildren();
  ['#stat-accounts', '#stat-platforms', '#stat-emails'].forEach(id => { $(id).textContent = '—'; });
  $('#result-count').textContent = '';
}
setUnauthorizedHandler(() => { expired = true; clearPrivateData(); });

function option(value, text) {
  const node = el('option', '', text); node.value = value; return node;
}

function updateFilters() {
  const category = $('#category-filter').value;
  const tag = $('#tag-filter').value;
  $('#category-filter').replaceChildren(option('', '全部分类'), option('none', '未分类'), ...state.categories.map(item => option(String(item.id), item.name)));
  $('#tag-filter').replaceChildren(option('', '全部标签'), ...state.tags.map(item => option(item, item)));
  $('#category-filter').value = [...$('#category-filter').options].some(item => item.value === category) ? category : '';
  $('#tag-filter').value = state.tags.includes(tag) ? tag : '';
}

export async function reload() {
  const current = ++generation;
  loading = true;
  $('#content').setAttribute('aria-busy', 'true');
  try {
    const [accounts, platforms, categories, tags] = await Promise.all([
      api('/api/accounts'), api('/api/platforms'), api('/api/categories'), api('/api/tags'),
    ]);
    if (current !== generation || expired) return;
    state.accounts = accounts;
    state.platforms = platforms.sort((a, b) => compareName(a.name, b.name));
    state.categories = categories.sort((a, b) => a.sort_order - b.sort_order || compareName(a.name, b.name));
    state.tags = tags.sort(compareName);
    state.ready = true;
    updateFilters();
    render();
  } catch (error) {
    if (current !== generation || expired) return;
    $('#content').replaceChildren(empty('暂时无法读取帐号', error.message, '重新加载', () => reload()));
    toast(error.message, true);
  } finally {
    if (current === generation) { loading = false; $('#content').setAttribute('aria-busy', 'false'); }
  }
}

function empty(title, description, action, handler) {
  const node = el('div', 'empty-state');
  node.append(el('div', 'empty-symbol', '◇'), el('h2', '', title), el('p', 'muted', description));
  if (action) node.append(button(action, handler, 'primary'));
  return node;
}

function tagsRow(tags) {
  const node = el('div', 'tags');
  tags.forEach(tag => node.append(el('span', 'tag', tag)));
  return node;
}

function accountCard(account) {
  const card = el('article', 'account-card');
  const open = button('', () => accountDetail(account), 'card-open');
  const top = el('div', 'card-top');
  top.append(el('span', 'avatar small-avatar', [...account.platform_name][0]?.toUpperCase() || 'A'), el('span', 'platform-label', account.platform_name));
  open.append(top, el('h3', 'account-identity', identity(account)));
  if (account.email && account.username) open.append(el('p', 'card-secondary', `绑定邮箱 · ${account.email}`));
  if (state.view === 'email' && state.group) open.append(el('p', 'association', emailsFor(account).get(state.group)?.join(' / ') || ''));
  if (account.notes) open.append(el('p', 'notes-excerpt', account.notes));
  card.append(open);
  const bottom = el('div', 'card-bottom');
  bottom.append(el('span', 'category-caption', account.category_name || '未分类'));
  card.append(tagsRow(account.tags), bottom);
  return card;
}

function groupCard(group) {
  const card = button('', () => { state.group = group.key; render(); $('#breadcrumb button')?.focus(); }, 'group-card');
  const top = el('div', 'card-top');
  top.append(el('span', `avatar${state.view === 'email' ? ' email-avatar' : ''}`, state.view === 'email' ? '@' : [...group.name][0]?.toUpperCase() || 'A'), el('span', 'card-arrow', '↗'));
  card.append(top, el('h3', '', group.name));
  const count = group.accounts.length;
  card.append(el('p', 'muted', state.view === 'email' ? `${new Set(group.accounts.map(account => account.platform_id)).size} 个平台 · ${count} 个帐号` : `${count} 个帐号`));
  const captions = state.view === 'email' ? [...new Set(group.accounts.map(account => account.platform_name))] : [...new Set(group.accounts.map(account => account.category_name || '未分类'))];
  card.append(el('p', 'group-caption', captions.join(' · ')));
  return card;
}

function render() {
  if (!state.ready || expired) return;
  $('#stat-accounts').textContent = state.accounts.length;
  $('#stat-platforms').textContent = new Set(state.accounts.map(account => account.platform_id)).size;
  $('#stat-emails').textContent = new Set(state.accounts.flatMap(account => [...emailsFor(account).keys()])).size;
  const filtered = filterAccounts(state.accounts, { search: $('#search').value, category: $('#category-filter').value, tag: $('#tag-filter').value });
  const content = $('#content');
  content.replaceChildren();
  $('#breadcrumb').replaceChildren();
  let visible = filtered;
  if (state.view === 'all') {
    content.append(...recentAccounts(visible).map(accountCard));
  } else {
    const groups = groupAccounts(filtered, state.view, $('#search').value);
    if (state.group) {
      const selected = groups.find(group => group.key === state.group);
      const breadcrumb = el('div', 'breadcrumb');
      breadcrumb.append(button('← 返回分组', () => { state.group = null; render(); }, 'quiet'), el('strong', '', selected?.name || '当前分组'));
      $('#breadcrumb').append(breadcrumb);
      visible = selected?.accounts || [];
      content.append(...recentAccounts(visible).map(accountCard));
    } else {
      content.append(...groups.map(groupCard));
      visible = [...new Map(groups.flatMap(group => group.accounts).map(account => [account.id, account])).values()];
    }
  }
  $('#result-count').textContent = `筛选结果 ${visible.length} 个帐号`;
  if (!content.children.length) {
    if (!state.accounts.length) content.append(empty('你的空间，从第一个帐号开始', '按平台整理帐号，用邮箱串联数字生活。这里不存储任何第三方密码。', '新增第一个帐号', () => editAccount(state, reload)));
    else content.append(empty('没有找到匹配的帐号', state.view === 'email' ? '仅含手机号或普通用户名的帐号不参与邮箱分组。试试其他关键词，或查看全部帐号。' : '试试其他关键词，或者清除分类和标签筛选。', '清除筛选', clearFilters));
  }
}

function clearFilters() {
  $('#search').value = ''; $('#category-filter').value = ''; $('#tag-filter').value = ''; state.group = null; render();
}

function accountDetail(account) {
  const { dialog, body, show } = modal('帐号详情', { wide: true });
  const heading = el('div', 'detail-heading');
  heading.append(el('span', 'avatar', [...account.platform_name][0]?.toUpperCase() || 'A'), el('div', '', account.platform_name));
  body.append(heading, el('h3', 'detail-identity', identity(account)));
  const list = el('dl', 'detail-list');
  const detail = (label, value, { url = false } = {}) => {
    const row = el('div', 'detail-row');
    row.append(el('dt', '', label));
    const dd = el('dd');
    if (url && safeURL(value)) {
      const link = el('a', 'safe-link', value); link.href = safeURL(value); link.target = '_blank'; link.rel = 'noopener noreferrer'; dd.append(link);
    } else dd.append(el('span', 'pre-wrap', value || '未填写'));
    if (value) dd.append(button(`复制${label}`, () => copyText(value), 'quiet copy-button'));
    row.append(dd); list.append(row);
  };
  detail('登录帐号', account.username);
  detail('绑定邮箱', account.email);
  detail('绑定手机号', account.phone);
  detail('登录网址', account.effective_url, { url: true });
  detail('网址来源', account.login_url ? '帐号专属网址' : '继承平台默认网址');
  detail('自定义分类', account.category_name || '未分类');
  detail('帐号备注', account.notes);
  const formatTime = value => value ? new Date(value).toLocaleString('zh-CN') : '—';
  detail('创建时间', formatTime(account.created_at)); detail('修改时间', formatTime(account.updated_at));
  body.append(list, tagsRow(account.tags));
  const actions = el('div', 'form-actions wrap');
  actions.append(button('删除帐号', async event => {
    const control = event.currentTarget;
    if (control.disabled) return;
    control.disabled = true;
    try {
      if (!await confirmAction('删除帐号？', `将永久删除「${account.platform_name} · ${identity(account)}」，此操作无法撤销。`, '确认删除', true)) return;
      await api(`/api/accounts/${account.id}`, { method: 'DELETE' });
      dialog.close(); toast('帐号已删除'); await reload();
    } catch (error) { toast(error.message, true); }
    finally { control.disabled = false; }
  }, 'danger-quiet'), button('复制为新帐号', () => { dialog.close(); editAccount(state, reload, account, true); }), button('编辑帐号', () => { dialog.close(); editAccount(state, reload, account); }, 'primary'));
  body.append(actions); show();
}

$('#views').addEventListener('click', event => {
  const control = event.target.closest('[data-view]');
  if (!control) return;
  state.view = control.dataset.view; state.group = null;
  $('#views').querySelectorAll('button').forEach(node => node.setAttribute('aria-pressed', String(node === control)));
  render();
});
['#search', '#category-filter', '#tag-filter'].forEach(selector => $(selector).addEventListener(selector === '#search' ? 'input' : 'change', () => { state.group = null; render(); }));
$('#clear-filters').addEventListener('click', clearFilters);
$('#add-account').addEventListener('click', () => {
  if (state.ready) editAccount(state, reload);
  else toast('请等待数据载入，或点击重新加载。', true);
});
$('#settings').addEventListener('click', () => {
  if (state.ready) openSettings(state, reload, logout);
  else toast('请先重新加载帐号数据。', true);
});
async function logout() {
  if (!await confirmAction('退出帐号空间？', '退出后将清除本页内存中的帐号信息，未保存的修改会丢失。', '退出登录')) return;
  try {
    await api('/api/auth/logout', { method: 'POST', body: {} });
    expired = true; clearPrivateData(); location.replace('/login.html');
  } catch (error) { toast(error.message, true); }
}
$('#logout').addEventListener('click', logout);

let checkingSession = false;
async function checkSession() {
  if (checkingSession || expired || document.hidden) return;
  checkingSession = true;
  try { await api('/api/auth/session'); }
  catch (error) { if (error.status !== 401) toast('无法确认登录状态，请检查网络。', true); }
  finally { checkingSession = false; }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkSession(); });
setInterval(checkSession, 60000);
window.addEventListener('pagehide', clearPrivateData);
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
await checkSession();
if (!expired && !loading) await reload();
