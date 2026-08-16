/* CrystalGate v4 — 前端逻辑 */
const API = '';
let token = localStorage.getItem('cg_token') || '';
let currentPanel = localStorage.getItem('cg_panel') || '';
let captchaTokens = { login: '', reg: '' };

// ─── 初始化 ───
window.onload = () => {
  if (token) {
    checkToken();
  } else {
    showLogin();
  }
};

function checkToken() {
  fetch(`${API}/api/panel/list`, { headers: { Authorization: `Bearer ${token}` } })
    .then(r => {
      if (r.ok) {
        showMain();
      } else {
        showLogin();
      }
    })
    .catch(() => showLogin());
}

// ─── 登录/注册 ───
function showLogin() {
  document.getElementById('loginPage').classList.remove('hidden');
  document.getElementById('mainPage').classList.add('hidden');
  refreshCaptcha('login');
}

function showMain() {
  document.getElementById('loginPage').classList.add('hidden');
  document.getElementById('mainPage').classList.remove('hidden');
  document.getElementById('userName').textContent = '欢迎';
  loadPanels();
  checkAdmin();
}

function showTab(tab) {
  document.getElementById('loginForm').classList.toggle('hidden', tab !== 'login');
  document.getElementById('registerForm').classList.toggle('hidden', tab !== 'register');
  document.querySelectorAll('.tab').forEach((t, i) =>
    t.classList.toggle('active', (tab === 'login' ? 0 : 1) === i));
  refreshCaptcha(tab);
}

async function refreshCaptcha(which) {
  try {
    const r = await fetch(`${API}/api/auth/captcha`);
    const d = await r.json();
    captchaTokens[which] = d.token;
    const el = document.getElementById(`${which}CaptchaImg`);
    if (d.chars) {
      el.innerHTML = `<span class="capchar">${d.chars}</span><span class="noise">${d.noise || ''}</span>`;
    } else if (d.image) {
      el.textContent = d.image;
    }
  } catch (e) { /* 忽略 */ }
}

async function doLogin() {
  const err = document.getElementById('loginError');
  err.textContent = '';
  try {
    const r = await fetch(`${API}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: document.getElementById('loginUser').value,
        password: document.getElementById('loginPwd').value,
      })
    });
    const d = await r.json();
    if (!r.ok) { err.textContent = d.detail || d.message || '登录失败'; return; }
    token = d.token;
    localStorage.setItem('cg_token', token);
    showMain();
  } catch (e) { err.textContent = '网络错误'; }
}

async function doRegister() {
  const err = document.getElementById('regError');
  err.textContent = '';
  try {
    const r = await fetch(`${API}/api/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: document.getElementById('regUser').value,
        password: document.getElementById('regPwd').value,
        code: document.getElementById('regCode').value,
        captcha_token: captchaTokens.reg,
        captcha_answer: document.getElementById('regCaptcha').value,
      })
    });
    const d = await r.json();
    if (!r.ok) { err.textContent = d.detail || '注册失败'; refreshCaptcha('reg'); return; }
    token = d.token;
    localStorage.setItem('cg_token', token);
    showMain();
  } catch (e) { err.textContent = '网络错误'; }
}

function logout() {
  localStorage.removeItem('cg_token');
  localStorage.removeItem('cg_panel');
  token = '';
  currentPanel = '';
  showLogin();
}

// ─── 导航 ───
function showMainTab(tab) {
  ['panels', 'console', 'files', 'admin'].forEach(t => {
    document.getElementById(`tab${t[0].toUpperCase()}${t.slice(1)}`).classList.toggle('hidden', t !== tab);
  });
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  if (tab === 'console') loadConsole();
  if (tab === 'files') loadFiles();
  if (tab === 'admin') { loadAdminUsers(); loadAdminPanels(); loadCodes(); }
}

// ─── 面板 ───
function showCreatePanel(hide) {
  document.getElementById('createPanelForm').classList.toggle('hidden', !!hide);
}

async function createPanel() {
  try {
    const r = await fetch(`${API}/api/panel/create`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        server_code: document.getElementById('newServerCode').value,
        server_password: document.getElementById('newServerPwd').value,
        panel_code: document.getElementById('newPanelCode').value,
      })
    });
    const d = await r.json();
    if (!r.ok) { alert(d.detail || '创建失败'); return; }
    alert(`面板创建成功! ID: ${d.panel_id}`);
    showCreatePanel(true);
    loadPanels();
  } catch (e) { alert('网络错误'); }
}

async function loadPanels() {
  try {
    const r = await fetch(`${API}/api/panel/list`, { headers: { Authorization: `Bearer ${token}` } });
    const d = await r.json();
    const grid = document.getElementById('panelList');
    if (!d.panels || d.panels.length === 0) {
      grid.innerHTML = '<div class="card">暂无面板，点击右上角创建</div>';
      return;
    }
    grid.innerHTML = d.panels.map(p => {
      const st = p.runtime_status || p.status || 'stopped';
      const expireText = p.expire_at ? new Date(p.expire_at * 1000).toLocaleString() : '永久';
      return `<div class="panel-card" onclick="openConsole('${p.id}','${p.server_code}')">
        <div class="panel-title">租赁服 ${p.server_code}</div>
        <div class="panel-code">${p.id}</div>
        <div class="panel-meta">
          <span class="status-badge status-${st}">${st === 'running' ? '运行中' : st === 'stopped' ? '已停止' : st === 'expired' ? '已过期' : '已封禁'}</span>
          <span>到期: ${expireText}</span>
          ${p.bot_name ? `<span>机器人: ${p.bot_name}</span>` : ''}
        </div>
      </div>`;
    }).join('');
  } catch (e) { /* 忽略 */ }
}

// ─── 控制台 ───
function openConsole(panelId, serverCode) {
  currentPanel = panelId;
  localStorage.setItem('cg_panel', panelId);
  document.getElementById('consoleTitle').textContent = `面板 ${panelId} · 租赁服 ${serverCode}`;
  showMainTab('console');
}

async function startPanel() {
  if (!currentPanel) return;
  try {
    const r = await fetch(`${API}/api/panel/${currentPanel}/start`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }
    });
    const d = await r.json();
    if (!r.ok) { appendConsole(`❌ ${d.detail || '启动失败'}`); return; }
    appendConsole(`✅ ${d.message}${d.bot_name ? ' · 机器人: ' + d.bot_name : ''}`);
    pollConsole();
  } catch (e) { appendConsole('❌ 网络错误'); }
}

async function stopPanel() {
  if (!currentPanel) return;
  try {
    const r = await fetch(`${API}/api/panel/${currentPanel}/stop`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }
    });
    const d = await r.json();
    appendConsole(`⏹ ${d.message || '已关闭'}`);
    loadConsole();
  } catch (e) { /* 忽略 */ }
}

function convertColorCodes(text) {
  // §0-§f 转换HTML颜色
  const colors = {
    '§0': '#000000', '§1': '#0000AA', '§2': '#00AA00', '§3': '#00AAAA',
    '§4': '#AA0000', '§5': '#AA00AA', '§6': '#FFAA00', '§7': '#AAAAAA',
    '§8': '#555555', '§9': '#5555FF', '§a': '#55FF55', '§b': '#55FFFF',
    '§c': '#FF5555', '§d': '#FF55FF', '§e': '#FFFF55', '§f': '#FFFFFF',
    '§l': '', '§o': '', '§k': '', '§m': '', '§n': '', '§r': '',
  };
  let out = '';
  let currentColor = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '§' && i + 1 < text.length) {
      const code = text.slice(i, i + 2);
      if (code in colors) {
        if (code.length === 2 && code[1] >= '0' && code[1] <= 'f') {
          currentColor = colors[code];
          out += `<span style="color:${currentColor}">`;
        }
        i += 2;
        continue;
      }
    }
    out += text[i];
    i++;
  }
  if (currentColor) out += '</span>';
  return out;
}

function formatLogLine(line) {
  // TEXT:<type>:<source>:<msg> → 1:1 打印
  // type 1=玩家聊天 2=翻译/系统 6=系统 7=私聊 10=命令输出
  const m = line.match(/^TEXT:(\d+):([^:]*):(.*)$/);
  if (m) {
    const type = parseInt(m[1]);
    const source = m[2];
    const msg = m[3];
    if (type === 1 && source) {
      return `<span style="color:#7ecbff">‹${escapeHtml(source)}›</span> <span>${convertColorCodes(escapeHtml(msg))}</span>`;
    }
    if (type === 2 || type === 6) {
      return `<span style="color:#a8b4c8">[系统] ${convertColorCodes(escapeHtml(msg))}</span>`;
    }
    if (type === 7) {
      return `<span style="color:#c9a2ff">[私聊] ${escapeHtml(source)}: ${escapeHtml(msg)}</span>`;
    }
    if (type === 10) {
      return `<span style="color:#8b93a7">[命令] ${escapeHtml(msg)}</span>`;
    }
    return escapeHtml(line);
  }
  return escapeHtml(line);
}

let consolePollFailures = 0;

async function loadConsole() {
  if (!currentPanel) return;
  try {
    const r = await fetch(`${API}/api/panel/${currentPanel}/console`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (r.status === 401) {
      // 会话过期
      clearInterval(consoleTimer);
      showLogin();
      return;
    }
    const d = await r.json();
    consolePollFailures = 0;
    const body = document.getElementById('consoleBody');
    if (d.logs) {
      const lines = d.logs.split('\n')
      .filter(l => !l.includes('连接保持中'))
      .map(formatLogLine).join('\n');
      body.innerHTML = `<pre style="color:#c8d0e0;line-height:1.7">${lines}</pre>`;
    } else {
      body.innerHTML = '<div class="console-hint">暂无日志</div>';
    }
    body.scrollTop = body.scrollHeight;
    document.getElementById('consoleTitle').textContent =
      `面板 ${currentPanel} · 状态: ${d.status}${d.bot_name ? ' · 机器人: ' + d.bot_name : ''}`;
    if (d.status === 'running') scheduleConsolePoll();
  } catch (e) {
    consolePollFailures++;
    if (consolePollFailures > 10) {
      // 连续失败10次, 停止轮询并提示
      const body = document.getElementById('consoleBody');
      if (body) body.innerHTML += '\n<span style="color:#f85149">⚠️ 连接中断 (可能是网络问题或面板已停止)</span>';
    } else {
      scheduleConsolePoll();
    }
  }
}

let consoleTimer = null;
function scheduleConsolePoll() {
  clearTimeout(consoleTimer);
  consoleTimer = setTimeout(loadConsole, 3000);
}

function pollConsole() {
  scheduleConsolePoll();
}

function appendConsole(msg) {
  const body = document.getElementById('consoleBody');
  const pre = body.querySelector('pre');
  if (pre) {
    pre.textContent += '\n' + msg;
    body.scrollTop = body.scrollHeight;
  }
}

function clearConsole() {
  if (!currentPanel) return;
  fetch(`${API}/api/panel/${currentPanel}/console/clear`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }
  }).then(() => loadConsole());
}

async function sendCmd() {
  const inp = document.getElementById('cmdInput');
  const cmd = inp.value.trim();
  if (!cmd || !currentPanel) return;
  inp.value = '';
  try {
    const r = await fetch(`${API}/api/panel/${currentPanel}/command`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ command: cmd })
    });
    const d = await r.json();
    if (!d.success) appendConsole(`❌ ${d.message}`);
  } catch (e) { /* 忽略 */ }
}

// ─── 文件 ───
async function uploadFile() {
  if (!currentPanel) { alert('请先在控制台选择一个面板'); return; }
  const fileInput = document.getElementById('fileInput');
  if (!fileInput.files.length) { alert('请选择文件'); return; }
  const fd = new FormData();
  fd.append('file', fileInput.files[0]);
  fd.append('file_type', document.getElementById('fileType').value);
  try {
    const r = await fetch(`${API}/api/panel/${currentPanel}/upload`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd
    });
    const d = await r.json();
    alert(d.detail || d.message || (d.success ? '上传成功' : '上传失败'));
    loadFiles();
  } catch (e) { alert('网络错误'); }
}

async function loadFiles() {
  if (!currentPanel) { document.getElementById('fileList').innerHTML = '<div class="card">请先在控制台选择面板</div>'; return; }
  try {
    const r = await fetch(`${API}/api/panel/${currentPanel}/files`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const d = await r.json();
    const types = { structure: '建筑', plugin: '插件', plugin_data: '插件数据' };
    document.getElementById('fileList').innerHTML = (d.files || []).map(f => `
      <div class="file-item">
        <span class="file-type-badge file-type-${f.file_type}">${types[f.file_type] || f.file_type}</span>
        <span>${escapeHtml(f.filename)}</span>
        <span style="color:var(--text2);font-size:12px">${new Date(f.uploaded_at * 1000).toLocaleString()}</span>
      </div>`).join('') || '<div class="card">暂无文件</div>';
  } catch (e) { /* 忽略 */ }
}

// ─── 管理后台 ───
function showAdminTab(tab) {
  ['users', 'panels', 'codes', 'bots'].forEach(t => {
    document.getElementById(`admin${t[0].toUpperCase()}${t.slice(1)}`).classList.toggle('hidden', t !== tab);
  });
}

async function checkAdmin() {
  // 通过 users 接口探测管理员权限
  try {
    const r = await fetch(`${API}/api/admin/users`, { headers: { Authorization: `Bearer ${token}` } });
    if (r.ok) {
      document.getElementById('adminNav').style.display = '';
    }
  } catch (e) { /* 忽略 */ }
}

async function loadAdminUsers() {
  const search = document.getElementById('userSearch')?.value || '';
  try {
    const r = await fetch(`${API}/api/admin/users?search=${encodeURIComponent(search)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const d = await r.json();
    document.getElementById('adminUserList').innerHTML = `
      <table class="admin-table">
        <tr><th>ID</th><th>用户名</th><th>邮箱</th><th>管理员</th><th>注册时间</th><th>封禁至</th><th>操作</th></tr>
        ${(d.users || []).map(u => `
          <tr>
            <td>${u.id}</td><td>${escapeHtml(u.username)}</td><td>${escapeHtml(u.email || '-')}</td>
            <td>${u.is_admin ? '✅' : '-'}</td>
            <td>${u.created_at ? new Date(u.created_at * 1000).toLocaleDateString() : '-'}</td>
            <td>${u.banned_until > Date.now() / 1000 ? new Date(u.banned_until * 1000).toLocaleString() : '-'}</td>
            <td>
              <button class="btn-ghost" onclick="banUser('${u.username}')">封禁</button>
              <button class="btn-ghost" onclick="unbanUser('${u.username}')">解封</button>
            </td>
          </tr>`).join('')}
      </table>`;
  } catch (e) { /* 忽略 */ }
}

async function loadAdminPanels() {
  const search = document.getElementById('panelSearch')?.value || '';
  try {
    const r = await fetch(`${API}/api/admin/panels?search=${encodeURIComponent(search)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const d = await r.json();
    document.getElementById('adminPanelList').innerHTML = `
      <table class="admin-table">
        <tr><th>面板ID</th><th>服务器号</th><th>状态</th><th>到期</th><th>操作</th></tr>
        ${(d.panels || []).map(p => `
          <tr>
            <td>${p.id}</td><td>${p.server_code}</td><td>${p.status}</td>
            <td>${new Date(p.expire_at * 1000).toLocaleString()}</td>
            <td>
              <button class="btn-ghost" onclick="banPanel('${p.id}')">封禁</button>
              <button class="btn-ghost" onclick="extendPanel('${p.id}')">续期</button>
            </td>
          </tr>`).join('')}
      </table>`;
  } catch (e) { /* 忽略 */ }
}

async function loadCodes() {
  try {
    const r = await fetch(`${API}/api/admin/codes`, { headers: { Authorization: `Bearer ${token}` } });
    const d = await r.json();
    document.getElementById('codeList').innerHTML = (d.codes || []).map(c => `
      <div class="code-item">
        <span class="code-value">${c.code}</span>
        <span>类型: ${c.type === 'register' ? '注册码' : '面板码'}</span>
        <span>剩余: ${c.uses_left}/${c.max_uses}</span>
        <span>时长: ${c.duration_hours}h</span>
        <span>过期: ${c.expire_at ? new Date(c.expire_at * 1000).toLocaleDateString() : '-'}</span>
      </div>`).join('') || '<div class="card">暂无兑换码</div>';
  } catch (e) { /* 忽略 */ }
}

async function genCodes() {
  try {
    const r = await fetch(`${API}/api/admin/codes/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        code_type: document.getElementById('codeType').value,
        count: parseInt(document.getElementById('codeCount').value) || 1,
        uses: parseInt(document.getElementById('codeUses').value) || 1,
        duration_hours: parseInt(document.getElementById('codeHours').value) || 24,
      })
    });
    const d = await r.json();
    alert(`已生成:\n${d.codes.join('\n')}`);
    loadCodes();
  } catch (e) { /* 忽略 */ }
}

async function banUser(name) {
  const hours = prompt(`封禁用户 ${name} 多少小时?`, '24');
  if (!hours) return;
  await fetch(`${API}/api/admin/ban`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ target: name, target_type: 'user', hours: parseInt(hours), reason: '管理员封禁' })
  });
  loadAdminUsers();
}

async function unbanUser(name) {
  await fetch(`${API}/api/admin/unban`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ target: name, target_type: 'user' })
  });
  loadAdminUsers();
}

async function banPanel(id) {
  const hours = prompt(`封禁面板 ${id} 多少小时?`, '24');
  if (!hours) return;
  await fetch(`${API}/api/admin/ban`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ target: id, target_type: 'panel', hours: parseInt(hours), reason: '管理员封禁' })
  });
  loadAdminPanels();
}

async function extendPanel(id) {
  const hours = prompt(`面板 ${id} 续期多少小时?`, '24');
  if (!hours) return;
  await fetch(`${API}/api/admin/panel/${id}/extend`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ hours: parseInt(hours) })
  });
  loadAdminPanels();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}


// ─── 导入系统 ───
let importTimer = null;
let importStartTime = 0;
let importStats = null;

async function previewImport() {
  if (!currentPanel) { alert('请先在控制台选择一个面板'); return; }
  try {
    const r = await fetch(`${API}/api/panel/${currentPanel}/import/preview`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const d = await r.json();
    if (!d.success) { alert(d.detail || '预览失败'); return; }
    importStats = d;
    // 显示导入面板
    document.getElementById('importPanel').style.display = 'flex';
    // 去掉后缀
    let fname = d.filename || '';
    fname = fname.replace(/\.[^.]+$/, '');
    document.getElementById('importFileName').textContent = fname;
    document.getElementById('importChunks').textContent = d.chunk_count;
    document.getElementById('importCommands').textContent = d.command_count;
    document.getElementById('importNbt').textContent = d.nbt_count;
    document.getElementById('importNbtStatus').textContent = d.nbt_count > 0 ? '待导入' : '无NBT';
    document.getElementById('importProgressFill').style.width = '0%';
    document.getElementById('importPercent').textContent = '0%';
    document.getElementById('importElapsed').textContent = '0s';
    document.getElementById('importEta').textContent = '-';
  } catch (e) { alert('预览失败: ' + e.message); }
}

async function startImport() {
  if (!currentPanel) return;
  try {
    const r = await fetch(`${API}/api/panel/${currentPanel}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        x: parseInt(document.getElementById('importX').value) || -2000,
        y: parseInt(document.getElementById('importY').value) || -60,
        z: parseInt(document.getElementById('importZ').value) || 2000,
      })
    });
    const d = await r.json();
    if (!d.success) { alert(d.detail || '导入失败'); return; }
    importStartTime = Date.now();
    importTimer = setInterval(updateImportProgress, 1000);
  } catch (e) { alert('导入失败: ' + e.message); }
}

async function updateImportProgress() {
  try {
    const r = await fetch(`${API}/api/panel/${currentPanel}/console`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const d = await r.json();
    const logs = d.logs || '';
    // 统计已发送的指令数
    const sentMatches = logs.match(/CMD_SENT/g);
    const sentCount = sentMatches ? sentMatches.length : 0;
    const totalCommands = parseInt(document.getElementById('importCommands').textContent) || 0;
    const pct = totalCommands > 0 ? Math.min(100, Math.round(sentCount / totalCommands * 100)) : 0;
    document.getElementById('importProgressFill').style.width = pct + '%';
    document.getElementById('importPercent').textContent = pct + '%';
    const elapsed = Math.floor((Date.now() - importStartTime) / 1000);
    document.getElementById('importElapsed').textContent = elapsed + 's';
    if (pct > 0) {
      const eta = Math.floor(elapsed * (100 - pct) / pct);
      document.getElementById('importEta').textContent = eta + 's';
    }
    if (logs.includes('导入完成')) {
      clearInterval(importTimer);
      document.getElementById('importProgressFill').style.width = '100%';
      document.getElementById('importPercent').textContent = '100%';
      document.getElementById('importNbtStatus').textContent = '已处理';
      alert('🎉 导入完成!');
    }
  } catch (e) { /* 忽略 */ }
}

function closeImport() {
  if (importTimer) clearInterval(importTimer);
  document.getElementById('importPanel').style.display = 'none';
}

// 上传后自动预览
const origUploadFile = uploadFile;
uploadFile = async function() {
  await origUploadFile();
  // 检查是否是建筑文件
  if (document.getElementById('fileType').value === 'structure') {
    setTimeout(previewImport, 800);
  }
};
