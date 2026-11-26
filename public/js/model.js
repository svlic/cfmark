export const normalizeEmail = value => String(value || '').trim().toLowerCase();
export const isEmail = value => {
  const text = String(value || '').trim();
  return text.length <= 254 && /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(text);
};
export const identity = account => account.username || account.email || account.phone || '未填写';
export const compareName = (a, b) => String(a).localeCompare(String(b), 'zh-CN', { numeric: true, sensitivity: 'base' });

export function emailsFor(account) {
  const result = new Map();
  for (const [value, label] of [[account.username, '登录邮箱'], [account.email, '绑定邮箱']]) {
    if (!isEmail(value)) continue;
    const key = normalizeEmail(value);
    if (!result.has(key)) result.set(key, []);
    result.get(key).push(label);
  }
  return result;
}

export function filterAccounts(accounts, { search = '', category = '', tag = '' } = {}) {
  const query = search.trim().toLowerCase();
  return accounts.filter(account => {
    if (category === 'none' && account.category_id != null) return false;
    if (category && category !== 'none' && String(account.category_id) !== category) return false;
    if (tag && !account.tags.includes(tag)) return false;
    return !query || [account.platform_name, account.username, account.email, account.phone, account.notes,
      account.category_name, account.login_url, account.default_url, account.effective_url, ...account.tags]
      .some(value => String(value || '').toLowerCase().includes(query));
  });
}

export function groupAccounts(accounts, view, search = '') {
  const groups = new Map();
  const query = search.trim().toLowerCase();
  const exactEmail = isEmail(query);
  for (const account of accounts) {
    const keys = view === 'email' ? [...emailsFor(account).keys()].filter(key => !query || (exactEmail ? key === query : true)) : [String(account.platform_id)];
    for (const key of keys) {
      if (!groups.has(key)) groups.set(key, { key, name: view === 'email' ? key : account.platform_name, accounts: [] });
      groups.get(key).accounts.push(account);
    }
  }
  // Partial email searches must not leak the unrelated second email of a matching record.
  if (view === 'email' && query && !exactEmail && query.includes('@')) {
    for (const [key] of groups) if (!key.includes(query)) groups.delete(key);
  }
  return [...groups.values()].sort((a, b) => compareName(a.name, b.name));
}

export function recentAccounts(accounts) {
  return [...accounts].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || Number(b.id) - Number(a.id));
}
