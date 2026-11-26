import { el, button, api, toast, modal, confirmAction, field, showFormError, safeURL } from './shared.js';
import { compareName } from './model.js';

let serial = 0;
export function editAccount(state, reload, account = {}, duplicate = false) {
  const editing = Boolean(account.id && !duplicate);
  const { dialog, body, show } = modal(editing ? '编辑帐号' : duplicate ? '复制为新帐号' : '新增帐号', { wide: true });
  const form = el('form');
  form.autocomplete = 'off';
  const grid = el('div', 'form-grid');
  const suffix = ++serial;
  const appendField = (label, name, value, options) => {
    const result = field(label, name, value, options); grid.append(result.wrapper); return result.input;
  };
  const datalist = (name, values) => {
    const node = el('datalist'); node.id = `${name}-${suffix}`;
    [...new Set(values.filter(Boolean))].sort(compareName).forEach(value => { const option = el('option'); option.value = value; node.append(option); });
    form.append(node); return node.id;
  };
  const platform = appendField('所属平台 *', 'platform_name', account.platform_name, { required: true, max: 100, list: datalist('platforms', state.platforms.map(item => item.name)), hint: '选择已有平台，或输入新名称直接创建。' });
  const platformURL = appendField('新平台默认网址', 'platform_url', '', { type: 'url', max: 2048, placeholder: 'https://', hint: '仅创建新平台时使用；只允许 http / https。' });
  const username = appendField('登录帐号', 'username', account.username, { max: 320, hint: '登录帐号、绑定邮箱、手机号至少填写一项。' });
  const loginURL = appendField('帐号专属登录网址', 'login_url', account.login_url, { type: 'url', max: 2048, placeholder: '留空以继承平台网址' });
  const effective = el('p', 'notice span-two'); grid.append(effective);
  const updateURL = () => {
    const selected = state.platforms.find(item => item.name.toLowerCase() === platform.value.trim().toLowerCase());
    platformURL.disabled = Boolean(selected);
    const value = loginURL.value.trim() || (selected ? selected.default_url : platformURL.value.trim());
    effective.textContent = value ? `当前有效登录网址：${value}${loginURL.value.trim() ? '（帐号专属）' : '（继承平台）'}` : '当前未设置登录网址。留空不会自动访问或抓取任何网站。';
  };
  [platform, platformURL, loginURL].forEach(input => input.addEventListener('input', updateURL));
  updateURL();
  const email = appendField('绑定邮箱', 'email', account.email, { type: 'email', max: 254, list: datalist('emails', state.accounts.map(item => item.email)) });
  const phone = appendField('绑定手机号', 'phone', account.phone, { type: 'tel', max: 50, list: datalist('phones', state.accounts.map(item => item.phone)) });
  const category = appendField('自定义分类', 'category_name', account.category_name, { max: 50, list: datalist('categories', state.categories.map(item => item.name)), hint: '选择或输入新分类；留空为未分类。' });
  const tagArea = el('div', 'field', '标签');
  const selectedTags = new Set(account.tags || []);
  const chips = el('div', 'tags selected-tags');
  const tagInput = el('input'); tagInput.placeholder = '选择或输入新标签'; tagInput.maxLength = 50; tagInput.setAttribute('aria-label', '新标签');
  tagInput.setAttribute('list', datalist('tags', state.tags));
  const tagActions = el('div', 'inline-input');
  function renderTags() {
    chips.replaceChildren();
    selectedTags.forEach(tag => {
      const remove = button(`${tag} ×`, () => { selectedTags.delete(tag); renderTags(); }, 'tag removable');
      remove.setAttribute('aria-label', `移除标签 ${tag}`); chips.append(remove);
    });
  }
  function addTag() {
    const value = tagInput.value.trim();
    if (!value) return;
    if (selectedTags.size >= 20 && !selectedTags.has(value)) { toast('每个帐号最多 20 个标签。', true); return; }
    selectedTags.add(value); tagInput.value = ''; renderTags();
  }
  tagInput.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); addTag(); } });
  tagActions.append(tagInput, button('添加', addTag));
  tagArea.append(chips, tagActions, el('small', 'muted', '最多 20 个；新标签随帐号保存，无引用的标签不单独保留。'));
  grid.append(tagArea); renderTags();
  const notes = appendField('帐号备注', 'notes', account.notes, { multiline: true, max: 2000, full: true, placeholder: '纯文本备注，请勿填写密码、Token 或密钥。' });
  const error = el('p', 'form-error'); error.role = 'alert'; error.hidden = true;
  const actions = el('div', 'form-actions');
  const save = button(editing ? '保存修改' : '创建帐号', () => {}, 'primary'); save.type = 'submit';
  actions.append(button('取消', () => { if (!busy) dialog.close(); }), save);
  form.append(grid, el('p', 'muted small-note', '多设备同时编辑采用后写覆盖，请避免同时修改同一帐号。'), error, actions); body.append(form);
  let busy = false;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    busy = true; save.disabled = true; save.textContent = '正在保存…'; error.hidden = true;
    dialog.dataset.busy = 'true';
    try {
      if (tagInput.value.trim()) addTag();
      if (tagInput.value.trim()) throw new Error('每个帐号最多 20 个标签，请先移除一个标签再保存。');
      if (!username.value.trim() && !email.value.trim() && !phone.value.trim()) throw new Error('登录帐号、绑定邮箱和手机号至少填写一项。');
      for (const input of [loginURL, ...(platformURL.disabled ? [] : [platformURL])]) {
        if (input.value.trim() && !safeURL(input.value.trim())) throw new Error('登录网址仅支持完整的 http:// 或 https:// 地址。');
      }
      const selectedPlatform = state.platforms.find(item => item.name.toLowerCase() === platform.value.trim().toLowerCase());
      const selectedCategory = state.categories.find(item => item.name.toLowerCase() === category.value.trim().toLowerCase());
      const payload = {
        ...(selectedPlatform ? { platform_id: selectedPlatform.id } : { platform_name: platform.value.trim(), platform_url: platformURL.value.trim() || null }),
        username: username.value.trim() || null, login_url: loginURL.value.trim() || null,
        email: email.value.trim() || null, phone: phone.value.trim() || null, notes: notes.value.trim() || null,
        ...(selectedCategory ? { category_id: selectedCategory.id } : category.value.trim() ? { category_name: category.value.trim() } : { category_id: null }),
        tags: [...selectedTags], confirmDuplicate: false,
      };
      const path = editing ? `/api/accounts/${account.id}` : '/api/accounts';
      const method = editing ? 'PUT' : 'POST';
      try { await api(path, { method, body: payload }); }
      catch (reason) {
        if (reason.status !== 409 || reason.code !== 'DUPLICATE') throw reason;
        if (!await confirmAction('可能是重复帐号', '同平台下已有可能相同的帐号。请确认确实需要保存另一条记录。', '仍然保存')) return;
        await api(path, { method, body: { ...payload, confirmDuplicate: true } });
      }
      dialog.close(); toast(editing ? '帐号已更新' : '帐号已创建'); await reload();
    } catch (reason) { showFormError(form, reason); }
    finally { busy = false; delete dialog.dataset.busy; save.disabled = false; save.textContent = editing ? '保存修改' : '创建帐号'; }
  });
  show();
  platform.focus();
}
