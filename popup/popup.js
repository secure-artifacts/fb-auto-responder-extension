document.addEventListener('DOMContentLoaded', async () => {

  const statusBadge = document.getElementById('statusBadge');
  const statusText = document.getElementById('statusText');
  const liveStatusContent = document.getElementById('liveStatusContent');
  const statProcessed = document.getElementById('statProcessed');
  const statDm = document.getElementById('statDm');
  const statErrors = document.getElementById('statErrors');
  const emergencyAlert = document.getElementById('emergencyAlert');
  const emergencyDesc = document.getElementById('emergencyDesc');
  const btnResetBrake = document.getElementById('btnResetBrake');
  const btnStart = document.getElementById('btnStart');
  const btnPause = document.getElementById('btnPause');
  const btnStop = document.getElementById('btnStop');
  const btnOpenDashboard = document.getElementById('btnOpenDashboard');

  // 只有这些元素存在时才继续
  if (!btnStart) return;

  async function refreshUI() {
    let settings;
    try {
      settings = await StorageUtil.getSettings();
    } catch (e) {
      liveStatusContent.textContent = "存储读取失败，请检查插件权限";
      return;
    }

    const stats = settings.stats || { totalProcessed: 0, totalDmSent: 0, totalErrors: 0 };
    statProcessed.textContent = stats.totalProcessed || 0;
    statDm.textContent = stats.totalDmSent || 0;
    statErrors.textContent = stats.totalErrors || 0;

    liveStatusContent.textContent = settings.statusMessage || "等待任务启动...";

    // 熔断警报
    if (settings.emergencyBrakeReason) {
      statusBadge.className = 'status-badge brake';
      statusText.textContent = '熔断锁定';
      emergencyAlert.style.display = 'block';
      emergencyDesc.textContent = settings.emergencyBrakeReason;
      setButtonState(false, false, false);
      return;
    }

    emergencyAlert.style.display = 'none';

    if (settings.isRunning && !settings.isPaused) {
      // 运行中状态
      statusBadge.className = 'status-badge running';
      statusText.textContent = '运行中 🟢';
      btnStart.style.background = 'linear-gradient(135deg, #059669, #10b981)';
      btnStart.style.boxShadow = '0 0 14px rgba(16,185,129,0.5)';
      btnStart.querySelector('span:last-child').textContent = '🟢 监控运行中';
      setButtonState(false, false, false); // start=disabled(visual only), pause=enabled, stop=enabled
      btnPause.disabled = false;
      btnStop.disabled = false;
    } else if (settings.isRunning && settings.isPaused) {
      statusBadge.className = 'status-badge paused';
      statusText.textContent = '已暂停 ⏸';
      btnStart.style.background = '';
      btnStart.style.boxShadow = '';
      btnStart.querySelector('span:last-child').textContent = '▶ 继续运行';
      setButtonState(false, true, false);
    } else {
      statusBadge.className = 'status-badge';
      statusText.textContent = '就绪';
      btnStart.style.background = '';
      btnStart.style.boxShadow = '';
      btnStart.querySelector('span:last-child').textContent = '一键启动监控';
      setButtonState(false, true, true);
    }
  }

  function setButtonState(startDisabled, pauseDisabled, stopDisabled) {
    btnStart.disabled = startDisabled;
    btnPause.disabled = pauseDisabled;
    btnStop.disabled = stopDisabled;
  }

  function sendMessageSafe(msg) {
    try {
      chrome.runtime.sendMessage(msg, () => {
        // 静默处理 service worker 未响应的情况
        if (chrome.runtime.lastError) { /* ignore */ }
      });
    } catch (e) { /* ignore */ }
  }

  btnStart.addEventListener('click', async () => {
    const settings = await StorageUtil.getSettings();
    if (!settings.targetUrls || settings.targetUrls.length === 0) {
      if (confirm("⚠️ 您尚未配置监控贴文链接！\n是否立即打开管理控制台添加链接？")) {
        chrome.runtime.openOptionsPage();
      }
      return;
    }

    await StorageUtil.saveSettings({
      isRunning: true,
      isPaused: false,
      statusMessage: "🚀 正在启动自动化监控..."
    });

    sendMessageSafe({ action: "START_MONITOR" });
    await refreshUI();
  });

  btnPause.addEventListener('click', async () => {
    await StorageUtil.saveSettings({ isPaused: true, statusMessage: "⏸ 任务已暂停" });
    sendMessageSafe({ action: "PAUSE_MONITOR" });
    await refreshUI();
  });

  btnStop.addEventListener('click', async () => {
    await StorageUtil.saveSettings({
      isRunning: false,
      isPaused: false,
      statusMessage: "⏹ 任务已手动终止"
    });
    sendMessageSafe({ action: "STOP_MONITOR" });
    await refreshUI();
  });

  btnResetBrake.addEventListener('click', async () => {
    await StorageUtil.saveSettings({
      emergencyBrakeReason: "",
      statusMessage: "已解除熔断锁定，系统恢复就绪"
    });
    await refreshUI();
  });

  btnOpenDashboard.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // 初始化 UI
  await refreshUI();

  // 每 1.5 秒轮询刷新状态
  const timer = setInterval(refreshUI, 1500);
  window.addEventListener('unload', () => clearInterval(timer));
});
