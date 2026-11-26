import { el, button, api, toast, confirmAction } from './shared.js';

export function backupPanel(panel, refresh) {
  panel.append(el('h3', '', '把数据的掌控权，留在自己手中'), el('p', 'muted', 'JSON 保留完整平台、分类和帐号，适合无损备份。导出文件包含私人信息，请安全保存。'));
  const exports = el('div', 'backup-actions');
  async function download(format, control) {
    if (control.disabled) return; control.disabled = true;
    try {
      const blob = await api(format === 'json' ? '/api/backup/export' : '/api/backup/csv', { download: true });
      const url = URL.createObjectURL(blob);
      const anchor = el('a'); anchor.href = url; anchor.download = `account-space-${new Date().toISOString().slice(0, 10)}.${format}`;
      panel.append(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('备份已下载，请妥善保管私密文件。');
    } catch (error) { toast(error.message, true); }
    finally { control.disabled = false; }
  }
  exports.append(button('导出 JSON 完整备份', event => download('json', event.currentTarget), 'primary'), button('导出 CSV', event => download('csv', event.currentTarget)));
  panel.append(exports, el('p', 'notice', 'CSV 仅用于交换八个业务字段，标签使用 JSON 数组。导出采用公式前缀安全转义，Excel 仍可能改变手机号等格式；精确无损迁移请使用 JSON。'));
  panel.append(el('h3', 'section-heading', '导入与恢复'), el('p', 'muted', 'JSON 全量替换业务数据，CSV 追加导入。必须先预览，再确认；建议先导出当前 JSON 备份。单文件最多 1 MiB、500 个帐号。'));
  const fileLabel = el('label', 'field', '选择 JSON 或 CSV 文件');
  const file = el('input'); file.type = 'file'; file.accept = '.json,.csv,application/json,text/csv'; fileLabel.append(file);
  const checkbox = el('label', 'checkbox');
  const keep = el('input'); keep.type = 'checkbox'; checkbox.append(keep, el('span', '', 'CSV 保留可能重复的帐号（默认跳过）'));
  const status = el('p', 'form-error'); status.role = 'alert'; status.hidden = true;
  const previewArea = el('section', 'preview-area'); previewArea.setAttribute('aria-live', 'polite');
  const preview = button('校验并预览', runPreview, 'secondary');
  panel.append(fileLabel, checkbox, status, preview, previewArea);
  let source = null;
  let validated = null;
  let busy = false;
  let revision = 0;
  function invalidate() { revision++; source = null; validated = null; previewArea.replaceChildren(); status.hidden = true; }
  file.addEventListener('change', invalidate);
  keep.addEventListener('change', invalidate);

  async function runPreview() {
    if (busy) return;
    invalidate();
    const selected = file.files[0];
    if (!selected) { status.textContent = '请先选择要导入的 JSON 或 CSV 文件。'; status.hidden = false; return; }
    if (selected.size > 1024 * 1024) { status.textContent = '文件超过 1 MiB，请拆分 CSV 或检查备份文件。'; status.hidden = false; return; }
    const extension = selected.name.split('.').pop().toLowerCase();
    if (!['json', 'csv'].includes(extension)) { status.textContent = '仅支持 .json 或 .csv 文件。'; status.hidden = false; return; }
    const current = revision;
    busy = true; preview.disabled = true; file.disabled = true; keep.disabled = true;
    preview.textContent = '正在校验…';
    try {
      const content = await selected.text();
      source = { format: extension, content, keepDuplicates: keep.checked };
      validated = await api('/api/backup/preview', { method: 'POST', body: source });
      if (current !== revision || !panel.isConnected) return;
      const result = validated;
      const summary = el('div', 'preview-summary');
      const counts = [['平台', result.platforms], ['分类', result.categories], ['帐号', result.accounts], ['有效', result.valid], ['可能重复', result.duplicates]];
      counts.forEach(([label, count]) => { const item = el('div'); item.append(el('strong', '', count), el('span', 'muted', label)); summary.append(item); });
      previewArea.append(el('h4', '', '导入预览'), summary);
      if (extension === 'json') {
        const old = result.replacing;
        previewArea.append(el('p', 'warning', old ? `将替换现有 ${old.accounts} 个帐号、${old.platforms} 个平台、${old.categories} 个分类。登录会话不受影响。` : 'JSON 恢复将替换全部现有帐号、平台与分类，不会与当前数据混合。'));
      } else previewArea.append(el('p', 'notice', `CSV 追加导入，不覆盖现有帐号。${keep.checked ? '你选择保留可能重复的条目。' : '可能重复的条目将跳过。'}`));
      if (result.errors?.length) {
        const errors = el('ul', 'import-errors');
        result.errors.forEach(error => errors.append(el('li', '', `第 ${error.row} 行：${error.message}`)));
        previewArea.append(el('p', 'form-error', '文件存在错误，不会执行导入。请修正后重新预览。'), errors);
      }
      const tooMany = result.accounts > 500;
      if (tooMany) previewArea.append(el('p', 'form-error', '单次导入不能超过 500 个帐号。'));
      const commit = button(extension === 'json' ? '确认恢复并替换' : '确认追加导入', () => commitImport(commit), extension === 'json' ? 'danger' : 'primary');
      commit.disabled = Boolean(result.errors?.length || tooMany || result.valid === 0 && extension === 'csv');
      previewArea.append(commit);
    } catch (error) {
      source = null; validated = null;
      status.textContent = error.message; status.hidden = false;
    } finally {
      busy = false; preview.disabled = false; file.disabled = false; keep.disabled = false; preview.textContent = '重新校验并预览';
    }
  }

  async function commitImport(control) {
    if (busy || !source || !validated) return;
    busy = true; control.disabled = true; preview.disabled = true; file.disabled = true; keep.disabled = true;
    try {
      const json = source.format === 'json';
      if (!await confirmAction(json ? '确定全量恢复？' : '确定导入 CSV？', json ? '将永久替换全部现有业务数据。请确认已导出当前备份，并且信任所选文件。此操作无法撤销。' : '将追加写入预览中的有效帐号。请确认重复处理选项与预览结果。', json ? '替换并恢复' : '开始导入', json)) return;
      await api('/api/backup/import', { method: 'POST', body: { ...source, confirm: true } });
      source = null; validated = null; file.value = ''; previewArea.replaceChildren();
      toast(json ? '备份恢复成功，正在刷新全部视图。' : 'CSV 导入成功，正在刷新全部视图。');
      await refresh();
    } catch (error) { status.textContent = error.message; status.hidden = false; }
    finally { busy = false; control.disabled = false; preview.disabled = false; file.disabled = false; keep.disabled = false; }
  }
}
