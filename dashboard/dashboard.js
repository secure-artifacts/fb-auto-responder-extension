document.addEventListener('DOMContentLoaded', async () => {
  // Navigation Tabs
  const navItems = document.querySelectorAll('.nav-item');
  const tabPanels = document.querySelectorAll('.tab-panel');
  const pageTitle = document.getElementById('pageTitle');

  const tabTitles = {
    'tab-urls': '目标贴文管理',
    'tab-rules': '关键词与回复规则',
    'tab-antiban': '防封与去重策略',
    'tab-logs': '运行日志与导出',
    'tab-backup': '配置导入与备份'
  };

  navItems.forEach(item => {
    item.addEventListener('click', () => {
      const targetTab = item.getAttribute('data-tab');

      navItems.forEach(i => i.classList.remove('active'));
      tabPanels.forEach(p => p.classList.remove('active'));

      item.classList.add('active');
      document.getElementById(targetTab).classList.add('active');
      pageTitle.textContent = tabTitles[targetTab] || '控制台';

      if (targetTab === 'tab-logs') renderLogs();
      if (targetTab === 'tab-urls') loadUrls();
    });
  });

  // Top Bar Tasks & Visual Indicators
  const topBtnStart = document.getElementById('topBtnStart');
  const topBtnStartText = document.getElementById('topBtnStartText');
  const topBtnStop = document.getElementById('topBtnStop');
  const sideStatusDot = document.getElementById('sideStatusDot');
  const sideStatusText = document.getElementById('sideStatusText');
  const topStatusPill = document.getElementById('topStatusPill');
  const topStatusPillText = document.getElementById('topStatusPillText');

  async function updateStatusIndicator() {
    const settings = await StorageUtil.getSettings();

    if (settings.isRunning && !settings.isPaused) {
      sideStatusDot.className = 'status-indicator-dot active';
      sideStatusText.textContent = '任务正在运行';

      topBtnStart.className = 'btn-top btn-top-start running';
      topBtnStartText.textContent = '🟢 监控进行中';

      topBtnStop.disabled = false;

      topStatusPill.className = 'live-status-pill running';
      topStatusPillText.textContent = '🟢 自动监控运行中';
    } else if (settings.isRunning && settings.isPaused) {
      sideStatusDot.className = 'status-indicator-dot';
      sideStatusText.textContent = '任务已暂停';

      topBtnStart.className = 'btn-top btn-top-start idle';
      topBtnStartText.textContent = '继续运行';

      topBtnStop.disabled = false;

      topStatusPill.className = 'live-status-pill idle';
      topStatusPillText.textContent = '⏸ 任务已暂停';
    } else {
      sideStatusDot.className = 'status-indicator-dot';
      sideStatusText.textContent = '系统就绪';

      topBtnStart.className = 'btn-top btn-top-start idle';
      topBtnStartText.textContent = '启动任务';

      topBtnStop.disabled = true;

      topStatusPill.className = 'live-status-pill idle';
      topStatusPillText.textContent = '系统就绪 (已停机)';
    }
  }

  topBtnStart.addEventListener('click', async () => {
    const settings = await StorageUtil.getSettings();
    if (settings.targetUrls.length === 0) {
      alert("请先添加并保存至少一条目标贴文链接！");
      return;
    }
    await StorageUtil.saveSettings({ isRunning: true, isPaused: false, statusMessage: "正在启动自动化监控..." });
    chrome.runtime.sendMessage({ action: "START_MONITOR" });
    updateStatusIndicator();
  });

  topBtnStop.addEventListener('click', async () => {
    await StorageUtil.saveSettings({ isRunning: false, isPaused: false, statusMessage: "任务已手动终止" });
    chrome.runtime.sendMessage({ action: "STOP_MONITOR" });
    updateStatusIndicator();
  });

  // 定时轮询状态面板
  setInterval(updateStatusIndicator, 1500);

  // ==================== TAB 1: 贴文管理 ====================
  const inputTargetUrls = document.getElementById('inputTargetUrls');
  const inputActiveUrls = document.getElementById('inputActiveUrls');
  const btnSaveUrls = document.getElementById('btnSaveUrls');
  const btnClearTargetUrls = document.getElementById('btnClearTargetUrls');
  const btnClearActiveUrls = document.getElementById('btnClearActiveUrls');
  const tipSaveUrls = document.getElementById('tipSaveUrls');

  async function loadUrls() {
    const settings = await StorageUtil.getSettings();
    inputTargetUrls.value = (settings.targetUrls || []).join('\n');
    inputActiveUrls.value = (settings.activeUrls || []).join('\n');
  }

  btnSaveUrls.addEventListener('click', async () => {
    const targetLines = inputTargetUrls.value.split('\n').map(s => s.trim()).filter(Boolean);
    const activeLines = inputActiveUrls.value.split('\n').map(s => s.trim()).filter(Boolean);
    await StorageUtil.saveSettings({ targetUrls: targetLines, activeUrls: activeLines });
    tipSaveUrls.textContent = `✓ 已成功保存 ${targetLines.length} 条监控贴文，${activeLines.length} 条伪装链接！`;
    setTimeout(() => tipSaveUrls.textContent = '', 3000);
  });

  btnClearTargetUrls.addEventListener('click', async () => {
    if (confirm("确定要清空所有监控贴文链接吗？")) {
      inputTargetUrls.value = '';
      const activeLines = inputActiveUrls.value.split('\n').map(s => s.trim()).filter(Boolean);
      await StorageUtil.saveSettings({ targetUrls: [], activeUrls: activeLines });
      tipSaveUrls.textContent = `✓ 已清空监控贴文！`;
      setTimeout(() => tipSaveUrls.textContent = '', 3000);
    }
  });

  btnClearActiveUrls.addEventListener('click', async () => {
    if (confirm("确定要清空所有伪装链接吗？")) {
      inputActiveUrls.value = '';
      const targetLines = inputTargetUrls.value.split('\n').map(s => s.trim()).filter(Boolean);
      await StorageUtil.saveSettings({ targetUrls: targetLines, activeUrls: [] });
      tipSaveUrls.textContent = `✓ 已清空伪装链接！`;
      setTimeout(() => tipSaveUrls.textContent = '', 3000);
    }
  });

  // 监听 Storage 变化，如果在当前页面停留，实现自动刷新
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.settings) {
      // 只有当前选中目标贴文 Tab 才自动刷新（避免打断用户输入）
      if (document.getElementById('tab-urls').classList.contains('active') && document.activeElement !== inputTargetUrls) {
        loadUrls();
      }
    }
  });

  // 初始化加载
  loadUrls();

  // ==================== 谷歌表格高阶单元格网格 Component ====================

  function renderKeywordGrid(containerId, items = []) {
    const container = document.getElementById(containerId);
    container.innerHTML = '';
    if (!items || items.length === 0) items = [''];

    items.forEach(val => addKeywordCell(containerId, val));
  }

  function renderTemplateGrid(containerId, items = []) {
    const container = document.getElementById(containerId);
    container.innerHTML = '';
    if (!items || items.length === 0) items = [''];

    items.forEach(val => addTemplateCell(containerId, val));
  }

  function addKeywordCell(containerId, val = '') {
    const container = document.getElementById(containerId);

    const cell = document.createElement('div');
    cell.className = 'grid-cell';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'grid-cell-input';
    input.value = val;
    input.placeholder = '关键词';

    const btnDel = document.createElement('button');
    btnDel.className = 'btn-delete-cell';
    btnDel.innerHTML = '&times;';
    btnDel.addEventListener('click', () => {
      cell.remove();
      if (container.children.length === 0) addKeywordCell(containerId, '');
    });

    cell.appendChild(input);
    cell.appendChild(btnDel);
    container.appendChild(cell);
  }

  function insertTextAtCursor(textarea, text) {
    const startPos = textarea.selectionStart;
    const endPos = textarea.selectionEnd;
    textarea.value = textarea.value.substring(0, startPos) + text + textarea.value.substring(endPos, textarea.value.length);
    textarea.selectionStart = startPos + text.length;
    textarea.selectionEnd = startPos + text.length;
    textarea.focus();
  }

  function addTemplateCell(containerId, val = '') {
    const container = document.getElementById(containerId);

    const cell = document.createElement('div');
    cell.className = 'grid-cell-template';

    const contentDiv = document.createElement('div');
    contentDiv.className = 'template-content';

    const textarea = document.createElement('textarea');
    textarea.className = 'grid-cell-textarea';
    textarea.value = val;
    textarea.placeholder = '在此粘贴你的私信内容（支持多行/换行）...';

    const toolbar = document.createElement('div');
    toolbar.className = 'template-toolbar';

    const btnFirstName = document.createElement('button');
    btnFirstName.className = 'btn-tool';
    btnFirstName.innerHTML = '🧑 插入名字 (First Name)';
    btnFirstName.addEventListener('click', () => insertTextAtCursor(textarea, '[FirstName]'));

    const btnFullName = document.createElement('button');
    btnFullName.className = 'btn-tool';
    btnFullName.innerHTML = '👤 插入全名 (Full Name)';
    btnFullName.addEventListener('click', () => insertTextAtCursor(textarea, '[FullName]'));

    toolbar.appendChild(btnFirstName);
    toolbar.appendChild(btnFullName);

    contentDiv.appendChild(textarea);
    contentDiv.appendChild(toolbar);

    const btnDel = document.createElement('button');
    btnDel.className = 'btn-delete-cell';
    btnDel.innerHTML = '&times;';
    btnDel.addEventListener('click', () => {
      cell.remove();
      if (container.children.length === 0) addTemplateCell(containerId, '');
    });

    cell.appendChild(contentDiv);
    cell.appendChild(btnDel);
    container.appendChild(cell);
  }

  function clearGrid(containerId, isKeywordMode = false) {
    if (isKeywordMode) {
      renderKeywordGrid(containerId, ['']);
    } else {
      renderTemplateGrid(containerId, ['']);
    }
  }

  function getGridValues(containerId) {
    const container = document.getElementById(containerId);
    const inputs = container.querySelectorAll('.grid-cell-input, .grid-cell-textarea');
    const list = [];
    inputs.forEach(inp => {
      const val = inp.value.trim();
      if (val) list.push(val);
    });
    return list;
  }

  function parsePastedData(text, isKeywordMode = false) {
    if (!text) return [];

    if (isKeywordMode) {
      return text.split(/[\n\r\t,，]/).map(s => s.trim()).filter(Boolean);
    }

    const cleanText = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const cells = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < cleanText.length; i++) {
      const ch = cleanText[i];

      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if ((ch === '\t' || ch === '\n') && !inQuotes) {
        let val = current.trim();
        if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
          val = val.slice(1, -1).replace(/""/g, '"');
        }
        if (val) cells.push(val);
        current = '';
      } else {
        current += ch;
      }
    }

    let lastVal = current.trim();
    if (lastVal.startsWith('"') && lastVal.endsWith('"') && lastVal.length >= 2) {
      lastVal = lastVal.slice(1, -1).replace(/""/g, '"');
    }
    if (lastVal) cells.push(lastVal);

    return cells;
  }

  document.addEventListener('paste', (e) => {
    const targetGrid = e.target.closest('.sheets-grid-container');
    if (!targetGrid) return;

    const containerId = targetGrid.id;
    const isKeywordMode = containerId === 'keywordsGrid';

    // 只有关键词网格才拦截粘贴（实现 Excel 拆分功能）
    // 私信话术网格 (dmTemplatesGrid) 允许用户原生粘贴大段换行文本，不拦截！
    if (!isKeywordMode) return;

    const clipboardData = e.clipboardData || window.clipboardData;
    if (!clipboardData) return;

    const pastedText = clipboardData.getData('text');
    if (!pastedText) return;

    if (pastedText.includes('\n') || pastedText.includes('\t') || (isKeywordMode && pastedText.includes(','))) {
      e.preventDefault();
      e.stopPropagation();

      const newItems = parsePastedData(pastedText, isKeywordMode);
      if (newItems.length > 0) {
        const existing = getGridValues(containerId);
        const combined = [...existing, ...newItems];

        if (isKeywordMode) {
          renderKeywordGrid(containerId, combined);
        } else {
          renderTemplateGrid(containerId, combined);
        }
      }
    }
  }, true);

  document.getElementById('btnAddKeywordCell').addEventListener('click', () => addKeywordCell('keywordsGrid', ''));
  document.getElementById('btnAddDmCell').addEventListener('click', () => addTemplateCell('dmTemplatesGrid', ''));

  document.getElementById('btnClearKeywordsGrid').addEventListener('click', () => clearGrid('keywordsGrid', true));
  document.getElementById('btnClearDmGrid').addEventListener('click', () => clearGrid('dmTemplatesGrid', false));

  // ==================== TAB 2: 规则管理 ====================
  const rulesContainer = document.getElementById('rulesContainer');
  const btnAddRule = document.getElementById('btnAddRule');
  const ruleModal = document.getElementById('ruleModal');
  const btnModalClose = document.getElementById('btnModalClose');
  const btnModalCancel = document.getElementById('btnModalCancel');
  const btnModalSave = document.getElementById('btnModalSave');

  const ruleName = document.getElementById('ruleName');
  const ruleMatchType = document.getElementById('ruleMatchType');

  let editingRuleId = null;

  async function renderRules() {
    const rules = await StorageUtil.getRules();
    rulesContainer.innerHTML = '';

    if (rules.length === 0) {
      rulesContainer.innerHTML = `<div class="empty-cell">尚无触发规则，点击右上角“新建触发规则”添加</div>`;
      return;
    }

    rules.forEach(r => {
      const card = document.createElement('div');
      card.className = 'rule-item-card';

      card.innerHTML = `
        <div class="rule-item-info">
          <h4>${r.name || '未命名规则'}</h4>
          <div class="rule-tags">
            <span class="tag tag-cyan">模式: ${r.matchType === 'exact' ? '精准匹配' : '包含关键词'}</span>
            <span class="tag tag-purple">动作: 仅发私信</span>
          </div>
          <div style="font-size:12px; color:var(--text-muted); margin-top:6px;">
            关键词 (${(r.keywords || []).length}个) | 私信模板 (${(r.dmTemplates || []).length}套)
          </div>
        </div>
        <div class="rule-actions">
          <button class="btn btn-secondary btn-edit-rule" data-id="${r.id}">编辑</button>
          <button class="btn btn-danger-outline btn-del-rule" data-id="${r.id}">删除</button>
        </div>
      `;
      rulesContainer.appendChild(card);
    });

    document.querySelectorAll('.btn-edit-rule').forEach(b => {
      b.addEventListener('click', () => openRuleModal(b.getAttribute('data-id')));
    });
    document.querySelectorAll('.btn-del-rule').forEach(b => {
      b.addEventListener('click', () => deleteRule(b.getAttribute('data-id')));
    });
  }

  function openRuleModal(ruleId = null) {
    editingRuleId = ruleId;
    if (ruleId) {
      StorageUtil.getRules().then(rules => {
        const r = rules.find(item => item.id === ruleId);
        if (!r) return;
        document.getElementById('modalTitle').textContent = "编辑规则";
        ruleName.value = r.name || '';
        ruleMatchType.value = r.matchType || 'contains';

        renderKeywordGrid('keywordsGrid', r.keywords || []);
        renderTemplateGrid('dmTemplatesGrid', r.dmTemplates || []);

        ruleModal.classList.add('active');
      });
    } else {
      document.getElementById('modalTitle').textContent = "新建规则";
      ruleName.value = '新关键词规则';
      ruleMatchType.value = 'contains';

      renderKeywordGrid('keywordsGrid', ['Amen', 'Amém', '领用', '资料']);
      renderTemplateGrid('dmTemplatesGrid', [
        '😍 ❤️ Olá {userName}, que Deus abençoe você — e liberte você e sua família de uma vida de sofrimento. 💖 Hoje realizaremos uma pregação online gratuita pelo WhatsApp, onde compartilharemos a Palavra de Deus e oraremos por você e pelas situações difíceis que está enfrentando 🧘.'
      ]);

      ruleModal.classList.add('active');
    }
  }

  async function saveRuleFromModal() {
    const rules = await StorageUtil.getRules();

    const ruleObj = {
      id: editingRuleId || ("rule_" + Date.now()),
      name: ruleName.value.trim() || '未命名规则',
      matchType: ruleMatchType.value,

      keywords: getGridValues('keywordsGrid'),
      dmTemplates: getGridValues('dmTemplatesGrid')
    };

    if (editingRuleId) {
      const idx = rules.findIndex(r => r.id === editingRuleId);
      if (idx !== -1) rules[idx] = ruleObj;
    } else {
      rules.push(ruleObj);
    }

    await StorageUtil.saveRules(rules);
    ruleModal.classList.remove('active');
    renderRules();
  }

  async function deleteRule(ruleId) {
    if (!confirm("确定要删除此条规则吗？")) return;
    let rules = await StorageUtil.getRules();
    rules = rules.filter(r => r.id !== ruleId);
    await StorageUtil.saveRules(rules);
    renderRules();
  }

  btnAddRule.addEventListener('click', () => openRuleModal(null));
  btnModalClose.addEventListener('click', () => ruleModal.classList.remove('active'));
  btnModalCancel.addEventListener('click', () => ruleModal.classList.remove('active'));
  btnModalSave.addEventListener('click', saveRuleFromModal);

  // ==================== TAB 3: 防封与去重设置 ====================
  const inputDmInterval = document.getElementById('inputDmInterval');
  const inputCooldown = document.getElementById('inputCooldown');
  const inputSwitchInterval = document.getElementById('inputSwitchInterval');
  const inputFillerWaitMin = document.getElementById('inputFillerWaitMin');
  const inputFillerWaitMax = document.getElementById('inputFillerWaitMax');
  const checkIncludeHistory = document.getElementById('checkIncludeHistory');
  const checkEmergencyBrake = document.getElementById('checkEmergencyBrake');
  const btnSaveAntiban = document.getElementById('btnSaveAntiban');
  const tipSaveAntiban = document.getElementById('tipSaveAntiban');
  const btnResetUserHistory = document.getElementById('btnResetUserHistory');

  async function loadAntibanSettings() {
    const settings = await StorageUtil.getSettings();
    inputDmInterval.value = settings.dmIntervalSeconds || 10;
    inputCooldown.value = settings.globalCooldownHours !== undefined ? settings.globalCooldownHours : 24;
    inputSwitchInterval.value = settings.switchIntervalSeconds || 15;
    inputFillerWaitMin.value = settings.fillerWaitMin || 15;
    inputFillerWaitMax.value = settings.fillerWaitMax || 45;
    if (checkIncludeHistory) checkIncludeHistory.checked = !!settings.includeHistory;
    if (checkEmergencyBrake) checkEmergencyBrake.checked = settings.emergencyBrakeEnabled !== false;
  }

  async function saveAntibanSettings() {
    const dmSec = parseInt(inputDmInterval.value, 10) || 10;
    const cdHr = parseInt(inputCooldown.value, 10) || 24;
    const switchSec = parseInt(inputSwitchInterval.value, 10) || 15;
    const fillerMin = parseInt(inputFillerWaitMin.value, 10) || 15;
    const fillerMax = parseInt(inputFillerWaitMax.value, 10) || 45;
    const includeHistory = checkIncludeHistory ? checkIncludeHistory.checked : false;
    const emergencyBrake = checkEmergencyBrake ? checkEmergencyBrake.checked : true;

    await StorageUtil.saveSettings({
      dmIntervalSeconds: dmSec,
      globalCooldownHours: cdHr,
      dmCooldownHours: cdHr,
      switchIntervalSeconds: switchSec,
      fillerWaitMin: fillerMin,
      fillerWaitMax: Math.max(fillerMin, fillerMax),
      includeHistory: includeHistory,
      emergencyBrakeEnabled: emergencyBrake
    });

    tipSaveAntiban.textContent = "✓ 防封与去重策略已保存！";
    setTimeout(() => tipSaveAntiban.textContent = '', 3000);
  }

  if (btnSaveAntiban) btnSaveAntiban.addEventListener('click', saveAntibanSettings);
  inputDmInterval.addEventListener('change', saveAntibanSettings);
  inputCooldown.addEventListener('change', saveAntibanSettings);
  inputSwitchInterval.addEventListener('change', saveAntibanSettings);
  if (checkIncludeHistory) checkIncludeHistory.addEventListener('change', saveAntibanSettings);
  if (checkEmergencyBrake) checkEmergencyBrake.addEventListener('change', saveAntibanSettings);

  async function handleResetUserHistory() {
    if (confirm("确定重置/清空已触达用户的去重冷却记录吗？重置后所有用户均可重新触发回复！")) {
      await StorageUtil.clearUserHistory();
      alert("✓ 已成功清空用户去重记录！现在所有留言均可重新触发！");
    }
  }

  btnResetUserHistory.addEventListener('click', handleResetUserHistory);

  // ==================== TAB 4: 日志与导出 ====================
  const logsTableBody = document.getElementById('logsTableBody');
  const btnExportExcel = document.getElementById('btnExportExcel');
  const btnClearLogs = document.getElementById('btnClearLogs');
  const btnResetHistoryLogs = document.getElementById('btnResetHistoryLogs');

  async function renderLogs() {
    const logs = await StorageUtil.getLogs();
    logsTableBody.innerHTML = '';

    if (logs.length === 0) {
      logsTableBody.innerHTML = `<tr><td colspan="6" class="empty-cell">暂无日志数据</td></tr>`;
      return;
    }

    logs.forEach(item => {
      const tr = document.createElement('tr');
      const profileLinkHtml = item.profileLink ? `<a href="${escapeHtml(item.profileLink)}" target="_blank">主页</a>` : '-';
      const postUrlHtml = item.postUrl ? `<a href="${escapeHtml(item.postUrl)}" target="_blank">贴文</a>` : '-';
      
      const safeUserName = escapeHtml(item.userName);
      const safeKeyword = escapeHtml(item.matchedKeyword);
      const safeComment = escapeHtml(item.commentText);
      const safeStatus = escapeHtml(item.dmStatus);

      tr.innerHTML = `
        <td>${escapeHtml(item.timestamp)}</td>
        <td><b>${safeUserName}</b></td>
        <td>${profileLinkHtml}</td>
        <td>${postUrlHtml}</td>
        <td><span class="tag tag-cyan">${safeKeyword}</span></td>
        <td><div style="max-height: 40px; overflow-y: auto; font-size: 0.9em;" title="${safeComment}">${safeComment}</div></td>
        <td style="color:${safeStatus.includes('成功') ? 'var(--accent-green)' : (safeStatus.includes('失败') ? 'var(--accent-red)' : 'var(--text-muted)')}">${safeStatus}</td>
      `;
      logsTableBody.appendChild(tr);
    });
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>'"]/g, tag => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;'
      }[tag] || tag));
  }

  btnExportExcel.addEventListener('click', async () => {
    const logs = await StorageUtil.getLogs();
    ExcelExporter.exportLogsToCSV(logs);
  });

  btnResetHistoryLogs.addEventListener('click', handleResetUserHistory);

  btnClearLogs.addEventListener('click', async () => {
    if (confirm("确定清空所有运行日志吗？")) {
      await StorageUtil.clearLogs();
      renderLogs();
    }
  });

  // ==================== TAB 5: 备份与恢复 ====================
  const btnExportConfig = document.getElementById('btnExportConfig');
  const btnImportConfig = document.getElementById('btnImportConfig');
  const fileImportConfig = document.getElementById('fileImportConfig');

  btnExportConfig.addEventListener('click', async () => {
    const settings = await StorageUtil.getSettings();
    const rules = await StorageUtil.getRules();
    const backupData = { settings, rules, exportDate: new Date().toISOString() };

    const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `FB_AutoResponder_Config_${Date.now()}.json`;
    a.click();
  });

  btnImportConfig.addEventListener('click', () => fileImportConfig.click());

  fileImportConfig.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const data = JSON.parse(evt.target.result);
        if (data.settings) await StorageUtil.saveSettings(data.settings);
        if (data.rules) await StorageUtil.saveRules(data.rules);
        alert("✓ 配置文件导入成功！规则和参数已更新。");
        loadUrls();
        renderRules();
        loadAntibanSettings();
      } catch (err) {
        alert("配置文件格式错误，导入失败！");
      }
    };
    reader.readAsText(file);
  });

  // 初次加载数据
  loadUrls();
  renderRules();
  loadAntibanSettings();
  renderLogs();
  updateStatusIndicator();
});
