import { $, el, button, api, toast, modal, field, showFormError, confirmAction, safeURL } from './shared.js';
import { backupPanel } from './backup.js';

export function openSettings(state, reload, logout) {
  const { dialog, body, show } = modal('空间设置', { wide: true });
  const tabs = el('div', 'settings-tabs');
  const panel = el('section', 'settings-panel');
  let active = 'platforms';
  const definitions = [['platforms', '平台'], ['categories', '分类'], ['tags', '标签'], ['backup', '数据备份'], ['appearance', '外观与会话']];
  definitions.forEach(([key, title]) => tabs.append(button(title, () => { active = key; render(); }, 'quiet')));
  body.append(tabs, panel);

  async function refresh() { await reload(); if (dialog.open) render(); }

  function render() {
    [...tabs.children].forEach((node, i) => node.setAttribute('aria-pressed', String(definitions[i][0] === active)));
    panel.replaceChildren();
    if (active === 'backup') { backupPanel(panel, refresh); return; }
    if (active === 'appearance') {
      panel.append(el('h3', '', '按你的习惯，选择外观'), el('p', 'muted', '只在当前浏览器保存主题偏好，不保存帐号数据或登录凭据。'));
      const theme = el('select'); theme.setAttribute('aria-label', '主题偏好');
      for (const [value, name] of [['system', '跟随系统'], ['light', '浅色模式'], ['dark', '深色模式']]) {
        const option = el('option', '', name); option.value = value; theme.append(option);
      }
      theme.value = $('#theme').value;
      theme.addEventListener('change', () => { $('#theme').value = theme.value; $('#theme').dispatchEvent(new Event('change')); });
      panel.append(theme, el('h3', 'section-heading', '登录会话'), el('p', 'muted', '默认登录有效期 24 小时；记住登录为 30 天。退出将撤销当前会话。'), button('退出登录', logout, 'danger-quiet'));
      return;
    }
    if (active === 'tags') {
      panel.append(el('p', 'notice', '标签随帐号保存。重命名为已有标签时会合并所有引用并去重；删除标签不会删除帐号。未使用的标签不单独保留。'));
      if (!state.tags.length) panel.append(el('p', 'muted', '还没有标签。在新增或编辑帐号时添加你的第一个标签。'));
      state.tags.forEach(name => {
        const row = el('div', 'management-row');
        const count = state.accounts.filter(account => account.tags.includes(name)).length;
        const text = el('div', 'management-text'); text.append(el('strong', '', name), el('small', 'muted', `${count} 个帐号引用`));
        const actions = el('div', 'row-actions');
        actions.append(button('重命名 / 合并', () => editTag(name)), button('删除', event => removeItem('tags', { name }, event.currentTarget), 'danger-quiet'));
        row.append(text, actions); panel.append(row);
      });
      return;
    }
    const type = active;
    const platform = type === 'platforms';
    panel.append(el('p', 'muted', platform ? '维护平台名称与默认登录网址。被帐号引用的平台不能删除。' : '分类属于帐号。排序值越小越靠前；删除分类后，关联帐号变为未分类。'), button(platform ? '＋ 新增平台' : '＋ 新增分类', () => editItem(type), 'primary'));
    if (!state[type].length) panel.append(el('p', 'notice', platform ? '暂无平台，点击上方按钮创建。' : '暂无分类，帐号默认显示为未分类。'));
    state[type].forEach(item => {
      const row = el('div', 'management-row');
      const text = el('div', 'management-text');
      text.append(el('strong', '', item.name), el('small', 'muted', platform ? item.default_url || '未设置默认网址' : `排序值 ${item.sort_order} · ${state.accounts.filter(account => account.category_id === item.id).length} 个帐号`));
      const actions = el('div', 'row-actions');
      actions.append(button('编辑', () => editItem(type, item)), button('删除', event => removeItem(type, item, event.currentTarget), 'danger-quiet'));
      row.append(text, actions); panel.append(row);
    });
  }

  function editItem(type, item = {}) {
    const platform = type === 'platforms';
    const label = platform ? '平台' : '分类';
    const edit = modal(`${item.id ? '编辑' : '新增'}${label}`);
    const form = el('form');
    const name = field(`${label}名称 *`, 'name', item.name, { required: true, max: platform ? 100 : 50 });
    const extra = field(platform ? '默认登录网址' : '排序值', platform ? 'default_url' : 'sort_order', platform ? item.default_url : item.sort_order ?? 0, { type: platform ? 'url' : 'number', max: platform ? 2048 : undefined, hint: platform ? '仅支持 http / https；留空表示未设置。' : '整数，越小越靠前。' });
    if (!platform) extra.input.step = '1';
    const error = el('p', 'form-error'); error.role = 'alert'; error.hidden = true;
    const save = button('保存', () => {}, 'primary'); save.type = 'submit';
    const actions = el('div', 'form-actions'); actions.append(button('取消', () => edit.dialog.close()), save);
    form.append(name.wrapper, extra.wrapper, error, actions); edit.body.append(form);
    let busy = false;
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (busy) return; busy = true; save.disabled = true;
      try {
        const value = extra.input.value.trim();
        if (platform && value && !safeURL(value)) throw new Error('网址必须是完整的 http:// 或 https:// 地址。');
        if (!platform && !Number.isSafeInteger(Number(value))) throw new Error('排序值必须是有效整数。');
        await api(`/api/${type}${item.id ? `/${item.id}` : ''}`, { method: item.id ? 'PUT' : 'POST', body: { name: name.input.value.trim(), ...(platform ? { default_url: value || null } : { sort_order: Number(value) }) } });
        edit.dialog.close(); toast(`${label}已保存`); await refresh();
      } catch (reason) { showFormError(form, reason); }
      finally { busy = false; save.disabled = false; }
    });
    edit.show(); name.input.focus();
  }

  function editTag(name) {
    const edit = modal('重命名或合并标签');
    const form = el('form');
    const input = field('新标签名称 *', 'newName', name, { required: true, max: 50, hint: '输入已有标签名称将合并所有引用；不会删除帐号。' });
    const error = el('p', 'form-error'); error.role = 'alert'; error.hidden = true;
    const actions = el('div', 'form-actions'); const save = button('保存', () => {}, 'primary'); save.type = 'submit';
    actions.append(button('取消', () => edit.dialog.close()), save); form.append(input.wrapper, error, actions); edit.body.append(form);
    let busy = false;
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (busy) return; busy = true; save.disabled = true;
      try {
        const newName = input.input.value.trim();
        if (newName !== name && state.tags.includes(newName) && !await confirmAction('合并标签？', `将「${name}」合并到「${newName}」，所有引用帐号都会更新。`, '确认合并')) return;
        await api('/api/tags', { method: 'PUT', body: { name, newName } });
        edit.dialog.close(); toast('标签已更新'); await refresh();
      } catch (reason) { showFormError(form, reason); }
      finally { busy = false; save.disabled = false; }
    });
    edit.show(); input.input.focus();
  }

  async function removeItem(type, item, control) {
    if (control.disabled) return; control.disabled = true;
    try {
      const messages = {
        platforms: '被引用的平台不能删除。此操作不会删除帐号。',
        categories: '所有引用该分类的帐号将变为未分类，帐号本身不会被删除。',
        tags: '将从所有帐号中移除此标签，帐号本身不会被删除。',
      };
      if (!await confirmAction(`删除「${item.name}」？`, messages[type], '确认删除', true)) return;
      await api(`/api/${type}${type === 'tags' ? '' : `/${item.id}`}`, { method: 'DELETE', ...(type === 'tags' ? { body: { name: item.name } } : {}) });
      toast('已删除'); await refresh();
    } catch (error) { toast(error.message, true); }
    finally { control.disabled = false; }
  }
  render(); show();
}
