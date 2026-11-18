const $ = selector => document.querySelector(selector);
const states = { new: '待處理', processing: '處理中', replied: '已回覆', archived: '已封存' };
const services = ['貨運物流', '專案物流', '倉儲物流', '船務代理'];
const offices = ['台北', '台中', '高雄', '洛杉磯', '胡志明市', '東京', '大阪'];
const fieldLabels = {
  name: '姓名', company: '公司', email: 'Email', origin: '起運地', destination: '目的地',
  dimensions: '貨物尺寸或重量', schedule: '預計日期', requirements: '貨物與需求',
  service: '服務項目', recipient: '聯絡據點'
};
let csrf = '';
let setup = false;
let entries = [];
let current = null;
let page = 1;
let dirty = false;
let detailLoading = false;
let saving = false;
let authenticated = false;
let loadSequence = 0;
const pageSize = 20;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function message(selector, text, success = false) {
  const node = $(selector);
  if (!node) return;
  node.textContent = text;
  node.classList.toggle('success', success);
}

function date(value) {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.valueOf()) ? '—' : timestamp.toLocaleString('zh-TW', { hour12: false });
}

function signedOut() {
  authenticated = false;
  csrf = '';
  current = null;
  entries = [];
  dirty = false;
  loadSequence++;
  $('#appView').hidden = true;
  $('#accountActions').hidden = true;
  $('#authView').hidden = false;
  $('#rows').replaceChildren();
  $('#detail').replaceChildren();
  $('#counts').replaceChildren();
  $('#passwordForm').reset();
  $('#passwordDialog').close();
}

async function api(path, options = {}) {
  const response = await fetch('/api/admin' + path, {
    ...options,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, ...options.headers }
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== '/login' && path !== '/password') {
      signedOut();
      message('#authMessage', '登入已到期，請重新登入。');
    }
    const error = new Error(data.error || '操作失敗，請重試。');
    error.status = response.status;
    throw error;
  }
  return data;
}

async function start() {
  $('#authDescription').textContent = '載入中…';
  $('#authForm').hidden = true;
  $('#retryAuth').hidden = true;
  try {
    const session = await api('/session');
    setup = session.setupRequired;
    $('#authTitle').textContent = setup ? '建立管理帳號' : '管理者登入';
    $('#authDescription').textContent = setup
      ? (session.setupAllowed ? '設定第一位管理者的帳號與密碼。密碼至少 12 字元。' : '請在本機伺服器完成初始帳號設定。')
      : '登入以查看及處理客戶詢問。';
    $('#confirmLabel').hidden = !setup;
    const form = $('#authForm');
    form.elements.confirm.required = setup;
    form.elements.password.minLength = setup ? 12 : 1;
    form.elements.password.autocomplete = setup ? 'new-password' : 'current-password';
    form.hidden = setup && !session.setupAllowed;
    $('#authSubmit').textContent = setup ? '建立帳號並登入' : '登入';
    $('#version').textContent = 'Version ' + (await fetch('/api/version', { cache: 'no-store' }).then(r => r.json())).version;
    if (session.authenticated) await signedIn(session);
  } catch (error) {
    $('#authDescription').textContent = '無法連線到後台伺服器。';
    message('#authMessage', error.message);
    $('#retryAuth').hidden = false;
  }
}

async function signedIn(session) {
  authenticated = true;
  csrf = session.csrf;
  $('#username').textContent = session.username;
  $('#authForm').reset();
  $('#authView').hidden = true;
  $('#appView').hidden = false;
  $('#accountActions').hidden = false;
  $('#detail').replaceChildren(element('p', '請選擇一筆詢問。', 'empty'));
  message('#listMessage', '');
  await loadList();
}

function filteredEntries() {
  const filter = new FormData($('#filters'));
  const search = String(filter.get('search')).trim().toLowerCase();
  return entries.filter(entry =>
    (!filter.get('state') || entry.state === filter.get('state')) &&
    (!filter.get('service') || String(entry.service) === filter.get('service')) &&
    (!filter.get('recipient') || String(entry.recipient) === filter.get('recipient')) &&
    (!search || [entry.reference, entry.company, entry.name, entry.email, entry.assignee]
      .some(value => String(value || '').toLowerCase().includes(search)))
  );
}

function renderList() {
  const counts = $('#counts');
  counts.replaceChildren();
  for (const [key, text] of [['all', '全部'], ...Object.entries(states)]) {
    const count = key === 'all' ? entries.length : entries.filter(entry => entry.state === key).length;
    const item = element('span', text);
    item.append(element('strong', String(count)));
    counts.append(item);
  }
  const filtered = filteredEntries();
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  page = Math.min(page, totalPages);
  const rows = $('#rows');
  rows.replaceChildren();
  for (const entry of filtered.slice((page - 1) * pageSize, page * pageSize)) {
    const row = element('tr');
    if (current?.record.reference === entry.reference) row.className = 'selected-row';
    const customer = element('td');
    const open = element('button', entry.name || '未填姓名');
    open.type = 'button';
    open.addEventListener('click', () => loadDetail(entry.reference));
    customer.append(open, element('span', entry.company || '—', 'muted'), element('span', entry.email || '', 'muted'));
    const service = element('td', services[entry.service] || '—');
    service.append(element('span', offices[entry.recipient] || '—', 'muted'));
    const state = element('td');
    state.append(element('span', states[entry.state], 'state state-' + entry.state));
    if (entry.assignee) state.append(element('span', entry.assignee, 'muted'));
    row.append(customer, service, state, element('td', date(entry.receivedAt)));
    rows.append(row);
  }
  $('#empty').hidden = filtered.length > 0;
  $('#empty').textContent = entries.length ? '沒有符合條件的詢問。' : '尚未收到詢問。';
  $('#pageInfo').textContent = filtered.length + ' 筆 · 第 ' + page + ' / ' + totalPages + ' 頁';
  $('#previous').disabled = page <= 1;
  $('#next').disabled = page >= totalPages;
}

async function loadList() {
  const sequence = ++loadSequence;
  $('#refresh').disabled = true;
  try {
    const result = await api('/enquiries');
    if (!authenticated || sequence !== loadSequence) return;
    entries = result.entries;
    renderList();
    message('#listMessage', result.unreadable ? result.unreadable + ' 筆資料無法讀取，請檢查伺服器收件檔。' : '');
  } catch (error) {
    message('#listMessage', error.message);
  } finally {
    $('#refresh').disabled = false;
  }
}

function allowDiscard() {
  return !dirty || confirm('尚有未儲存的修改，確定離開這筆詢問？');
}

async function loadDetail(reference) {
  if (detailLoading || saving || !allowDiscard()) return;
  detailLoading = true;
  message('#listMessage', '');
  try {
    const detail = await api('/enquiries/' + reference);
    if (!authenticated) return;
    current = detail;
    dirty = false;
    renderDetail();
    renderList();
    if (matchMedia('(max-width:1050px)').matches) $('#detail').scrollIntoView({ block: 'start', behavior: 'smooth' });
  } catch (error) {
    message('#listMessage', error.message);
  } finally {
    detailLoading = false;
  }
}

function inputField(name, label, value, options) {
  const wrapper = element('label', label);
  const control = options ? element('select') : element(name === 'requirements' || name === 'notes' ? 'textarea' : 'input');
  control.name = name;
  if (options) {
    options.forEach(([key, text]) => {
      const option = element('option', text);
      option.value = key;
      control.append(option);
    });
  } else {
    control.maxLength = { name: 100, company: 150, email: 200, requirements: 2000, notes: 10000, assignee: 100 }[name] || 150;
    if (name === 'email') control.type = 'email';
    control.required = ['name', 'company', 'email', 'requirements'].includes(name);
  }
  control.value = value ?? '';
  if (['requirements', 'notes'].includes(name)) wrapper.className = 'wide';
  wrapper.append(control);
  return wrapper;
}

function renderDetail() {
  const { record, original, management, history } = current;
  const section = $('#detail');
  section.replaceChildren(element('h2', record.company || '詢問詳情'), element('p', record.reference, 'reference'));
  const meta = element('dl');
  for (const [label, value] of [
    ['收件時間', date(original.receivedAt)], ['語系', original.language || '—'],
    ['投遞狀態', ({ received: '已收件', delivered: '已投遞', delivery_failed: '投遞失敗' })[original.status] || original.status || '—'],
    ['最後維護', management.updatedAt ? date(management.updatedAt) + ' · ' + management.updatedBy : '尚未修改']
  ]) meta.append(element('dt', label), element('dd', value));
  section.append(meta);
  const form = element('form');
  form.id = 'detailForm';
  const grid = element('div', undefined, 'edit-grid');
  grid.append(
    inputField('state', '處理狀態', management.state, Object.entries(states)),
    inputField('assignee', '負責人', management.assignee)
  );
  for (const [name, label] of Object.entries(fieldLabels)) {
    const options = name === 'service' ? services.map((s, i) => [String(i), s])
      : name === 'recipient' ? offices.map((s, i) => [String(i), s]) : null;
    grid.append(inputField(name, label, record[name], options));
  }
  grid.append(inputField('notes', '內部備註', management.notes));
  const status = element('p', '', 'message');
  status.id = 'saveMessage';
  status.setAttribute('role', 'status');
  const actions = element('div', undefined, 'actions');
  const reply = element('a', '撰寫回覆');
  reply.href = 'mailto:' + encodeURIComponent(record.email) + '?subject=' +
    encodeURIComponent('Northgo / ' + (services[record.service] || '詢問') + ' / ' + record.reference);
  const save = element('button', '儲存修改', 'primary');
  save.type = 'submit';
  const reload = element('button', '重新載入');
  reload.type = 'button';
  reload.addEventListener('click', () => loadDetail(record.reference));
  actions.append(save, reload, reply);
  form.append(grid, status, actions);
  form.addEventListener('input', () => { dirty = true; message('#saveMessage', '有未儲存的修改。'); });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (saving) return;
    saving = true;
    save.disabled = true;
    reload.disabled = true;
    grid.querySelectorAll('input,select,textarea').forEach(control => { control.readOnly = true; });
    try {
      const data = Object.fromEntries(new FormData(form));
      grid.querySelectorAll('select').forEach(control => { control.disabled = true; });
      const corrections = {};
      for (const name of Object.keys(fieldLabels)) {
        const value = ['service', 'recipient'].includes(name) ? Number(data[name]) : data[name].trim();
        if (String(value) !== String(original[name] ?? '')) corrections[name] = value;
      }
      current = await api('/enquiries/' + record.reference, {
        method: 'PATCH', body: JSON.stringify({
          revision: management.revision, state: data.state, assignee: data.assignee.trim(),
          notes: data.notes, corrections
        })
      });
      if (!authenticated) return;
      dirty = false;
      renderDetail();
      message('#saveMessage', '已儲存。', true);
      await loadList();
    } catch (error) {
      message('#saveMessage', error.message);
    } finally {
      saving = false;
      save.disabled = false;
      reload.disabled = false;
      grid.querySelectorAll('input,select,textarea').forEach(control => { control.readOnly = false; });
      grid.querySelectorAll('select').forEach(control => { control.disabled = false; });
    }
  });
  section.append(form);
  const originalDetails = element('details');
  originalDetails.append(element('summary', '客戶原始提交內容'), element('pre', Object.entries(fieldLabels)
    .map(([key, label]) => label + '　' + (key === 'service' ? services[original[key]] : key === 'recipient' ? offices[original[key]] : original[key] || '—')).join('\n')));
  const audit = element('details');
  audit.append(element('summary', '修改紀錄 (' + history.length + ')'));
  const items = element('ul', undefined, 'history');
  for (const entry of history) {
    const changes = [];
    if (entry.before.state !== entry.after.state) changes.push(states[entry.before.state] + ' → ' + states[entry.after.state]);
    if (entry.before.assignee !== entry.after.assignee) changes.push('負責人');
    if (entry.before.notes !== entry.after.notes) changes.push('內部備註');
    for (const [key, label] of Object.entries(fieldLabels)) {
      if (entry.before.corrections[key] !== entry.after.corrections[key]) changes.push(label);
    }
    items.append(element('li', date(entry.at) + ' · ' + entry.actor + '\n' + (changes.join('、') || '儲存')));
  }
  if (!history.length) items.append(element('li', '尚無修改紀錄。'));
  audit.append(items);
  section.append(originalDetails, audit);
}

$('#authForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  if (setup && data.password !== data.confirm) return message('#authMessage', '兩次密碼不一致。');
  $('#authSubmit').disabled = true;
  message('#authMessage', '');
  try {
    const session = await api(setup ? '/setup' : '/login', { method: 'POST', body: JSON.stringify(data) });
    setup = false;
    await signedIn(session);
  } catch (error) {
    message('#authMessage', error.message);
  } finally {
    $('#authSubmit').disabled = false;
  }
});
$('#retryAuth').addEventListener('click', start);
$('#refresh').addEventListener('click', loadList);
$('#filters').addEventListener('submit', event => event.preventDefault());
$('#filters').addEventListener('input', () => { page = 1; renderList(); });
$('#previous').addEventListener('click', () => { page--; renderList(); });
$('#next').addEventListener('click', () => { page++; renderList(); });
$('#logout').addEventListener('click', async () => {
  if (saving || !allowDiscard()) return;
  try {
    await api('/logout', { method: 'POST', body: '{}' });
    signedOut();
    await start();
  } catch (error) { message('#listMessage', error.message); }
});
$('#changePassword').addEventListener('click', () => {
  if (saving || !allowDiscard()) return;
  $('#passwordForm').reset();
  message('#passwordMessage', '');
  $('#passwordDialog').showModal();
});
$('#cancelPassword').addEventListener('click', () => $('#passwordDialog').close());
$('#passwordForm').addEventListener('submit', async event => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  if (data.password !== data.confirm) return message('#passwordMessage', '兩次新密碼不一致。');
  const button = event.currentTarget.querySelector('button[type=submit]');
  button.disabled = true;
  try {
    await api('/password', { method: 'POST', body: JSON.stringify(data) });
    signedOut();
    await start();
    message('#authMessage', '密碼已變更，請重新登入。', true);
  } catch (error) { message('#passwordMessage', error.message); }
  finally { button.disabled = false; }
});
window.addEventListener('beforeunload', event => {
  if (dirty) { event.preventDefault(); event.returnValue = ''; }
});
for (const [field, values] of [['service', services], ['recipient', offices]]) {
  values.forEach((text, index) => {
    const option = element('option', text);
    option.value = String(index);
    $('#filters').elements[field].append(option);
  });
}
start();
