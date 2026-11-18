const $ = selector => document.querySelector(selector);
const usersPage = /^\/admin\/users\/?$/.test(location.pathname);
if (!usersPage && location.hash === '#users') location.replace('/admin/users/');
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
let role = '';
let editingUser = null;
let usersSequence = 0;
let teamAccounts = [];
let assignableRoles = [];
let changingUser = false;
const roles = {
  owner: ['擁有者', '管理使用者及所有詢問'],
  admin: ['後台管理員', '管理客戶詢問、詢問管理員及唯讀人員'],
  manager: ['詢問管理員', '查看、新增、修改、刪除及還原詢問'],
  viewer: ['唯讀人員', '查看及搜尋詢問']
};
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
  role = '';
  usersSequence++;
  teamAccounts = [];
  assignableRoles = [];
  $('#userFilters').reset();
  $('#usersView').hidden = true;
  $('#userRows').replaceChildren();
  $('#userForm').reset();
  $('#userDialog').close();
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
  $('#createDialog').close();
  $('#createForm').reset();
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
      : usersPage ? '請使用擁有者或後台管理員帳號登入。' : '登入以查看及處理客戶詢問。';
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
  role = session.role;
  $('#accountRole').textContent = roles[role]?.[0] || '';
  $('#usersLink').hidden = usersPage || !canManageTeam();
  $('#createEnquiry').hidden = role === 'viewer';
  csrf = session.csrf;
  $('#username').textContent = session.username;
  $('#authForm').reset();
  $('#authView').hidden = true;
  $('#accountActions').hidden = false;
  $('#detail').replaceChildren(element('p', '請選擇一筆詢問。', 'empty'));
  message('#listMessage', '');
  if (usersPage) await renderAdminPage();
  else {
    $('#appView').hidden = false;
    await loadList();
  }
}

const canManageTeam = () => role === 'owner' || role === 'admin';

async function renderAdminPage() {
  if (!authenticated || !usersPage) return false;
  $('#usersView').hidden = false;
  if (!canManageTeam()) {
    $('#addUser').hidden = true;
    $('#usersTable').hidden = true;
    message('#usersMessage', '使用者管理限擁有者與後台管理員使用。');
    return false;
  }
  const sequence = ++usersSequence;
  const refresh = $('#refreshUsers');
  refresh.disabled = true;
  message('#usersMessage', '');
  try {
    const { users, availableRoles } = await api('/users');
    if (!authenticated || sequence !== usersSequence) return false;
    teamAccounts = users;
    assignableRoles = availableRoles;
    renderUserRows();
    $('#addUser').hidden = false;
    $('#usersTable').hidden = false;
    return true;
  } catch (error) {
    if (sequence === usersSequence) {
      message('#usersMessage', error.message);
      $('#addUser').hidden = true;
      if (error.status === 403) $('#usersTable').hidden = true;
    }
    return false;
  } finally {
    if (sequence === usersSequence) refresh.disabled = false;
  }
}

function renderUserRows() {
  const filters = $('#userFilters').elements;
  const search = filters.search.value.trim().toLowerCase();
  const status = filters.status.value;
  const visible = teamAccounts.filter(user =>
    user.username.toLowerCase().includes(search) &&
    (!filters.role.value || filters.role.value === user.role) &&
    (status === 'deleted' ? Boolean(user.deleted_at) :
      !user.deleted_at && (!status || status === (user.enabled ? 'enabled' : 'disabled')))
  );
  const rows = visible.map(user => {
    const row = element('tr');
    const account = element('td');
    const person = element('span', undefined, 'team-person');
    const avatar = element('span', user.username.slice(0, 2).toUpperCase(), 'team-avatar');
    avatar.setAttribute('aria-hidden', 'true');
    person.append(avatar, element('span', user.username));
    account.append(person);
    const [label, description] = roles[user.role];
    const permission = element('td', label);
    permission.append(element('span', description, 'muted'));
    const state = element('td');
    state.append(user.deleted_at ? element('span', '已移除', 'state state-archived') :
      user.enabled ? element('span', '啟用', 'state state-replied') : element('span', '停用', 'state state-archived'));
    const action = element('td');
    const actions = element('div', undefined, 'team-row-actions');
    if (user.canEdit) {
      if (user.deleted_at) actions.append(userButton('還原', () => changeUserState(user, true)));
      else actions.append(userButton('編輯', () => openUserForm(user)), userButton('移除', () => changeUserState(user, false), 'team-remove'));
    } else {
      actions.append(element('span', '—', 'muted'));
    }
    action.append(actions);
    row.append(account, permission, state, action);
    return row;

    function userButton(label, run, className) {
      const button = element('button', label, className);
      button.type = 'button';
      button.setAttribute('aria-label', label + ' ' + user.username);
      button.addEventListener('click', run);
      return button;
    }
  });
  $('#userRows').replaceChildren(...rows);
  $('#usersEmpty').hidden = visible.length > 0;
  $('#usersEmpty').textContent = status === 'deleted' ? '回收筒中沒有符合條件的帳號。' : '沒有符合條件的帳號。';
  $('#usersCount').textContent = '共 ' + visible.length + ' 個帳號';
}

async function changeUserState(user, restoring) {
  if (changingUser) return;
  if (!restoring && !window.confirm('要將「' + user.username + '」移至回收筒嗎？該帳號會立即登出。')) return;
  changingUser = true;
  try {
    await api('/users/' + user.id + (restoring ? '/restore' : ''), {
      method: restoring ? 'POST' : 'DELETE', body: JSON.stringify({ revision: user.revision })
    });
    if (await renderAdminPage()) message('#usersMessage', restoring ? '已還原帳號。請在停用清單中重新啟用。' : '帳號已移至回收筒。', true);
  } catch (error) { message('#usersMessage', error.message); }
  finally { changingUser = false; }
}

function openUserForm(user) {
  const form = $('#userForm');
  form.reset();
  editingUser = user || null;
  $('#userDialogTitle').textContent = user ? '編輯使用者' : '新增使用者';
  form.elements.username.value = user?.username || '';
  form.elements.role.replaceChildren(...assignableRoles.map(value => new Option(roles[value][0], value)));
  form.elements.role.value = user?.role || 'viewer';
  form.elements.enabled.value = user?.enabled === 0 ? 'false' : 'true';
  $('#userEnabled').hidden = !user;
  form.elements.password.required = !user;
  $('#teamPasswordLabel').textContent = user ? '重設密碼（留空則保留）' : '初始密碼（至少 12 字元）';
  $('#roleDescription').textContent = roles[form.elements.role.value][1];
  message('#userFormMessage', '');
  $('#userDialog').showModal();
}

$('#userDialog').addEventListener('close', () => { $('#userForm').elements.password.value = ''; });
$('#userFilters').addEventListener('input', renderUserRows);
$('#userFilters').addEventListener('submit', event => event.preventDefault());
$('#refreshUsers').addEventListener('click', renderAdminPage);
$('#addUser').addEventListener('click', () => openUserForm());
$('#cancelUser').addEventListener('click', () => $('#userDialog').close());
$('#userForm').elements.role.addEventListener('change', event => {
  $('#roleDescription').textContent = roles[event.target.value][1];
});
$('#userForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  const user = editingUser;
  const button = form.querySelector('button[type=submit]');
  button.disabled = true;
  try {
    await api(user ? '/users/' + user.id : '/users', {
      method: user ? 'PATCH' : 'POST',
      body: JSON.stringify({ username: data.username, role: data.role, enabled: data.enabled === 'true',
        password: data.password || undefined, revision: user?.revision })
    });
    form.reset();
    $('#userDialog').close();
    if (await renderAdminPage()) message('#usersMessage', user ? '已儲存使用者。' : '已新增使用者。', true);
  } catch (error) { message('#userFormMessage', error.message); }
  finally { button.disabled = false; }
});

function filteredEntries() {
  const filter = new FormData($('#filters'));
  const search = String(filter.get('search')).trim().toLowerCase();
  return entries.filter(entry =>
    (filter.get('deleted') === 'deleted' ? !!entry.deletedAt : !entry.deletedAt) &&
    (!filter.get('state') || entry.state === filter.get('state')) &&
    (!filter.get('service') || String(entry.service) === filter.get('service')) &&
    (!filter.get('recipient') || String(entry.recipient) === filter.get('recipient')) &&
    (!search || [entry.reference, entry.company, entry.name, entry.email, entry.assignee]
      .some(value => String(value || '').toLowerCase().includes(search)))
  );
}

function renderList() {
  const deleted = $('#filters').elements.deleted.value === 'deleted';
  const scope = entries.filter(entry => deleted ? !!entry.deletedAt : !entry.deletedAt);
  const counts = $('#counts');
  counts.replaceChildren();
  for (const [key, text] of [['all', '全部'], ...Object.entries(states)]) {
    const count = key === 'all' ? scope.length : scope.filter(entry => entry.state === key).length;
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
    const company = element('td', entry.company || '—');
    const contact = element('td');
    const open = element('button', entry.name || '未填聯絡人');
    open.type = 'button';
    open.addEventListener('click', () => loadDetail(entry.reference));
    contact.append(open);
    const state = element('td');
    state.append(element('span', states[entry.state], 'state state-' + entry.state));
    if (entry.assignee) state.append(element('span', entry.assignee, 'muted'));
    row.append(company, contact, element('td', services[entry.service] || '—'),
      element('td', offices[entry.recipient] || '—'), state, element('td', date(entry.receivedAt)));
    rows.append(row);
  }
  $('#empty').hidden = filtered.length > 0;
  $('#empty').textContent = scope.length ? '沒有符合條件的詢問。' : deleted ? '回收筒目前沒有詢問。' : '尚未收到詢問。';
  $('#pageInfo').textContent = filtered.length + ' 筆 · 第 ' + page + ' / ' + totalPages + ' 頁';
  $('#previous').disabled = page <= 1;
  $('#next').disabled = page >= totalPages;
}

async function loadList() {
  const sequence = ++loadSequence;
  $('#refresh').disabled = true;
  try {
    const result = await api('/enquiries?deleted=all');
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
    ['資料來源', original.source === 'admin' ? '後台建立 · ' + original.createdBy : '前台詢問'],
    ['投遞狀態', ({ received: '已收件', delivered: '已投遞', delivery_failed: '投遞失敗' })[original.status] || original.status || '—'],
    ['最後維護', management.updatedAt ? date(management.updatedAt) + ' · ' + management.updatedBy : '尚未修改']
  ]) meta.append(element('dt', label), element('dd', value));
  section.append(meta);
  const lifecycle = element('div', undefined, 'actions');
  const lifecycleButton = element('button', management.deletedAt ? '還原詢問' : '移至回收筒');
  lifecycleButton.type = 'button';
  lifecycleButton.addEventListener('click', () => changeDeletion(!!management.deletedAt));
  lifecycle.append(lifecycleButton);
  lifecycleButton.hidden = role === 'viewer';
  if (management.deletedAt) {
    lifecycle.append(element('span', '刪除時間 ' + date(management.deletedAt), 'muted'));
  }
  section.append(lifecycle);
  const form = element('form');
  form.id = 'detailForm';
  form.hidden = !!management.deletedAt;
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
  if (role === 'viewer') {
    grid.querySelectorAll('input,textarea').forEach(control => { control.readOnly = true; });
    grid.querySelectorAll('select').forEach(control => { control.disabled = true; });
  }
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
  save.hidden = role === 'viewer';
  reply.hidden = role === 'viewer';
  form.append(grid, status, actions);
  form.addEventListener('input', () => { dirty = true; message('#saveMessage', '有未儲存的修改。'); });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (saving || role === 'viewer') return;
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
    if (entry.before.deletedAt !== entry.after.deletedAt) changes.push(entry.after.deletedAt ? '移至回收筒' : '還原詢問');
    for (const [key, label] of Object.entries(fieldLabels)) {
      if (entry.before.corrections[key] !== entry.after.corrections[key]) changes.push(label);
    }
    items.append(element('li', date(entry.at) + ' · ' + entry.actor + '\n' + (changes.join('、') || '儲存')));
  }
  if (!history.length) items.append(element('li', '尚無修改紀錄。'));
  audit.append(items);
  section.append(originalDetails, audit);
}

async function changeDeletion(restore) {
  if (saving || !allowDiscard()) return;
  const text = restore ? '確定還原這筆詢問？' : '確定將這筆詢問移至回收筒？之後可還原。';
  if (!confirm(text)) return;
  saving = true;
  try {
    current = await api('/enquiries/' + current.record.reference + (restore ? '/restore' : ''), {
      method: restore ? 'POST' : 'DELETE', body: JSON.stringify({ revision: current.management.revision })
    });
    if (!authenticated) return;
    dirty = false;
    renderDetail();
    message('#listMessage', restore ? '詢問已還原。' : '詢問已移至回收筒。', true);
    await loadList();
  } catch (error) {
    message('#listMessage', error.message);
  } finally {
    saving = false;
  }
}

let createReference;
$('#createEnquiry').addEventListener('click', () => {
  if (saving || detailLoading || !allowDiscard()) return;
  if (dirty) { dirty = false; renderDetail(); }
  const form = $('#createForm');
  form.reset();
  const fields = $('#createFields');
  fields.replaceChildren();
  for (const [name, label] of Object.entries(fieldLabels)) {
    const options = name === 'service' ? services.map((text, i) => [String(i), text])
      : name === 'recipient' ? offices.map((text, i) => [String(i), text]) : null;
    fields.append(inputField(name, label, options ? '0' : '', options));
  }
  fields.append(inputField('language', '語系', 'zh', [['zh', '繁體中文'], ['en', 'English'], ['ja', '日本語'], ['vi', 'Tiếng Việt']]));
  createReference = undefined;
  message('#createMessage', '');
  $('#createDialog').showModal();
});
$('#cancelCreate').addEventListener('click', () => $('#createDialog').close());
$('#createForm').addEventListener('input', () => { createReference = undefined; });
$('#createForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (saving) return;
  createReference ||= Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('');
  const form = event.currentTarget;
  const payload = { ...Object.fromEntries(new FormData(form)), reference: createReference };
  saving = true;
  form.querySelectorAll('input,textarea,select,button').forEach(control => { control.disabled = true; });
  try {
    const result = await api('/enquiries', { method: 'POST', body: JSON.stringify(payload) });
    if (!authenticated) return;
    $('#createDialog').close();
    $('#filters').reset();
    page = 1;
    await loadList();
    saving = false;
    await loadDetail(result.reference);
  } catch (error) {
    message('#createMessage', error.message);
  } finally {
    saving = false;
    form.querySelectorAll('input,textarea,select,button').forEach(control => { control.disabled = false; });
  }
});

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
if (usersPage) {
  document.title = 'Northgo 使用者管理';
  $('#adminSection').textContent = '使用者管理';
}
start();
setInterval(() => {
  if (!usersPage && authenticated && !document.hidden && !saving && !detailLoading) loadList();
}, 15000);
