/**
 * FB 智能私信大师 - Comments Manager Content Script (v1.4.0)
 * 专为 Facebook 专业面板【评论管理工具】打造的集中式极速私信引擎
 * 页面地址: https://www.facebook.com/professional_dashboard/engagement/comments_manager/
 *
 * v1.3.0 重大升级：
 *   1. 【新客插队优先 / 抢鲜机制】(方案一，默认开启)：
 *      每发完一条私信或在防封等待时，自动嗅探列表最顶部；发现刚进来的新留言立即优先插队处理，
 *      抢占 1~3 分钟黄金转化期，发完新客再继续消化存量！
 *   2. 【时效窗口拦截过滤】(方案二，可选设置)：
 *      支持设置“仅回复最近 X 分钟内留言”（如 15 分钟），超过时效直接跳过，专攻在线活跃意向用户！
 *   3. 【修复历史留言过滤】：
 *      锚定留言者姓名精确提取评论时间，彻底杜绝误将帖子发布日期当做留言时间，严防回复几天前旧客！
 *   4. 【双重 24 小时冷却保护】：
 *      支持按“归一化姓名”和“数字 Facebook ID”双重冷却判定，并在内存实时同步，彻底杜绝 24H 内重复发送！
 */

(async function () {
  if (!window.location.pathname.includes('/comments_manager')) {
    return;
  }

  console.log("[Comments Manager Engine v1.5.1] 专业面板评论管理工具引擎已挂载！");

  let isProcessingLoop = false;
  let pollTimer = null;
  const sessionProcessedKeys = new Set();

  // ★ 统计已扫留言专用状态（疑问 1 选 A：全量扫描计数，跨自动刷新去重）
  let localTaskSessionId = null;
  let sessionScannedKeys = new Set();

  function initScannedKeys(settings) {
    const currentTaskSession = settings.taskSessionId || 0;
    if (localTaskSessionId !== currentTaskSession || (settings.stats && settings.stats.totalProcessed === 0)) {
      localTaskSessionId = currentTaskSession;
      sessionScannedKeys.clear();
      try { sessionStorage.removeItem('fb_cm_scanned_keys'); } catch(e) {}
    } else if (sessionScannedKeys.size === 0) {
      try {
        const cached = sessionStorage.getItem('fb_cm_scanned_keys');
        if (cached) {
          const arr = JSON.parse(cached);
          sessionScannedKeys = new Set(arr);
        }
      } catch(e) {}
    }
  }

  function persistScannedKey(key) {
    sessionScannedKeys.add(key);
    try {
      sessionStorage.setItem('fb_cm_scanned_keys', JSON.stringify(Array.from(sessionScannedKeys).slice(-2000)));
    } catch(e) {}
  }

  /**
   * 调度下一次巡检或自动刷新页面
   * @param {number} seconds 等待秒数
   * @param {boolean} shouldReload 是否在等待后执行页面完整刷新（方案 A：从 FB 服务器拉取最新数据）
   */
  function scheduleNextPollOrReload(seconds, shouldReload = false) {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }

    pollTimer = setTimeout(async () => {
      const current = await StorageUtil.getSettings();
      if (!current.isRunning || current.isPaused) {
        console.log("[Comments Manager Engine] 任务已停止或暂停，取消自动刷新/巡检");
        return;
      }

      if (shouldReload) {
        console.log("[Comments Manager Engine] 🔄 空闲等待结束，正在自动刷新页面向 Facebook 服务器同步最新留言...");
        await StorageUtil.saveSettings({
          statusMessage: "🔄 正在自动刷新页面，向 Facebook 服务器同步最新留言..."
        });
        window.location.reload();
      } else {
        runCommentsManagerLoop();
      }
    }, seconds * 1000);
  }

  chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    if (req.action === "SOFT_REFRESH_COMMENTS_MANAGER" || req.action === "SOFT_REFRESH_NOTIFICATIONS") {
      console.log("[Comments Manager Engine] 收到软巡检唤醒指令...");
      if (!isProcessingLoop) {
        runCommentsManagerLoop();
      }
      sendResponse({ status: "ACK" });
    }
    return true;
  });

  async function runCommentsManagerLoop() {
    if (isProcessingLoop) {
      console.log("[Comments Manager Engine] 任务循环进行中，跳过重复触发");
      return;
    }

    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }

    const settings = await StorageUtil.getSettings();
    if (!settings.isRunning || settings.isPaused) {
      console.log("[Comments Manager Engine] 任务未启动或已暂停");
      return;
    }

    if (settings.enableCommentsManagerMode === false) {
      console.log("[Comments Manager Engine] 评论管理工具监控已被用户设置关闭");
      return;
    }

    if (checkFacebookEmergencyBrake(settings)) return;

    isProcessingLoop = true;
    initScannedKeys(settings);

    try {
      await StorageUtil.saveSettings({
        statusMessage: "正在扫描评论管理工具，检索待回复留言...",
        currentWorkerMode: 'comments_manager'
      });

      // 1. 尝试确认并保持【你未回复】筛选器激活
      await ensureUnrepliedFilterActive();

      // 2. 扫描当前页面的所有留言卡片
      let rows = findCommentRows();
      console.log(`[Comments Manager Engine] 扫描到 ${rows.length} 条待处理留言卡片`);

      if (rows.length === 0) {
        window.scrollBy({ top: 500, behavior: 'smooth' });
        await new Promise(r => setTimeout(r, 1500));
        rows = findCommentRows();
      }

      if (rows.length === 0) {
        window.scrollTo({ top: 0, behavior: 'smooth' });
        const waitSec = Math.max(5, settings.notificationCheckInterval || 15);
        await StorageUtil.saveSettings({
          statusMessage: `暂无待回复新留言，${waitSec} 秒后自动刷新页面拉取最新留言...`
        });
        isProcessingLoop = false;
        scheduleNextPollOrReload(waitSec, true); // 触发方案 A 自动刷新
        return;
      }

      // 3. 读取规则、冷却记录、历史记录
      const rules = await StorageUtil.getRules();
      let processedComments = await StorageUtil.getProcessedComments();
      let userHistory = await StorageUtil.getUserHistory();
      const cooldownHours = settings.dmCooldownHours !== undefined
        ? settings.dmCooldownHours
        : (settings.globalCooldownHours !== undefined ? settings.globalCooldownHours : 24);
      const cooldownMs = cooldownHours * 3600 * 1000;

      let processedCountInBatch = 0;

      for (let i = 0; i < rows.length; i++) {
        if (checkFacebookEmergencyBrake(settings)) break;
        const currentSettings = await StorageUtil.getSettings();
        if (!currentSettings.isRunning || currentSettings.isPaused) break;
        if (currentSettings.enableCommentsManagerMode === false) break;

        // ★ v1.3.0 核心：顶部新客插队嗅探 (优先处理刚进来的新留言)
        if (i > 0) {
          const freshTopItem = await sniffTopForFreshComment(rules, processedComments, userHistory, currentSettings, cooldownMs);
          if (freshTopItem) {
            console.log(`🔥 [新客抢鲜插队] 发现列表顶部有新鲜留言 [${freshTopItem.parsed.userName}] (${freshTopItem.parsed.commentTime})，优先插队私信！`);
            await processSingleCommentItem(freshTopItem.rowItem, freshTopItem.parsed, freshTopItem.matchResult, currentSettings, processedComments, userHistory);
            processedCountInBatch++;
            // 重新获取最新列表以防 DOM 偏移
            rows = findCommentRows();
            continue;
          }
        }

        const rowItem = rows[i];
        const parsed = parseCommentRow(rowItem);

        // 视觉高亮当前正在检测的卡片（蓝色边框）
        if (rowItem.container) {
          rowItem.container.style.transition = 'box-shadow 0.3s ease';
          rowItem.container.style.boxShadow = '0 0 0 2px #3b82f6';
        }

        const commentKey = (parsed.userName + "_" + parsed.commentText).replace(/\s+/g, '_');

        // ★ 准确统计已扫留言（疑问 1 选 A：真实全量扫描数，每检测到一条独特留言即时 +1，刷新不重复累计）
        if (!sessionScannedKeys.has(commentKey)) {
          persistScannedKey(commentKey);
          const curSettings = await StorageUtil.getSettings();
          const stats = curSettings.stats || { totalProcessed: 0, totalDmSent: 0, totalErrors: 0 };
          stats.totalProcessed += 1;
          await StorageUtil.saveSettings({ stats });
        }

        const normName = (parsed.userName || '').toLowerCase().trim();
        const userKey = "usr_" + normName;
        const idKey = parsed.fbId ? ("id_" + parsed.fbId) : null;

        // 设置项检查 1：时效窗口拦截 (方案二，可选设置)
        if (currentSettings.enableTimeWindowFilter) {
          const maxMinutes = currentSettings.maxCommentAgeMinutes || 15;
          const ageMinutes = parseCommentAgeMinutes(parsed.commentTime);
          if (ageMinutes > maxMinutes) {
            console.log(`[时效过滤] 用户 [${parsed.userName}] 留言发布于 ${parsed.commentTime} (约 ${ageMinutes} 分钟前)，超过设定的 ${maxMinutes} 分钟时效上限，已自动跳过`);
            if (rowItem.container) rowItem.container.style.boxShadow = '';
            continue;
          }
        }

        // 设置项检查 2：处理历史留言开关 (超过24小时或包含几天前)
        if (!currentSettings.includeHistory) {
          const isHistorical = isHistoricalTime(parsed.commentTime) || parseCommentAgeMinutes(parsed.commentTime) >= 1440;
          if (isHistorical) {
            console.log(`[历史留言过滤] 用户 [${parsed.userName}] 留言为历史旧留言 (${parsed.commentTime})，已根据设置跳过`);
            if (rowItem.container) rowItem.container.style.boxShadow = '';
            continue;
          }
        }

        // 设置项检查 3：单条留言查重（本会话已发、历史已发）
        if (sessionProcessedKeys.has(commentKey)) {
          if (rowItem.container) rowItem.container.style.boxShadow = '';
          continue;
        }

        const isCommentAlreadyProcessed = Array.isArray(processedComments)
          ? processedComments.includes(commentKey)
          : !!processedComments[commentKey];
        if (isCommentAlreadyProcessed) {
          if (rowItem.container) rowItem.container.style.boxShadow = '';
          continue;
        }

        // 设置项检查 4：全局用户 24 小时冷却时间 (双重姓名与ID检索)
        const userTouchByName = userHistory[userKey];
        const userTouchById = idKey ? userHistory[idKey] : null;
        const lastDmTime = Math.max(
          userTouchByName?.lastDmTime || 0,
          userTouchById?.lastDmTime || 0
        );

        if (cooldownHours > 0 && lastDmTime > 0 && (Date.now() - lastDmTime < cooldownMs)) {
          const remainingHours = Math.round((cooldownMs - (Date.now() - lastDmTime)) / (3600 * 100)) / 10;
          console.log(`[Comments Manager Engine] 用户 [${parsed.userName}] 处于 24h 私信冷却期内 (还剩约 ${remainingHours} 小时)，跳过防打扰`);
          if (rowItem.container) rowItem.container.style.boxShadow = '';
          continue;
        }

        // 设置项检查 5：关键词规则匹配
        const matchResult = findMatchingRule(parsed.commentText, rules);
        if (!matchResult) {
          console.log(`[Comments Manager Engine] 用户 [${parsed.userName}] 留言 "${parsed.commentText}" 未匹配任何关键词规则，跳过`);
          sessionProcessedKeys.add(commentKey);
          if (rowItem.container) rowItem.container.style.boxShadow = '';
          continue;
        }

        // 执行单条私信处理
        await processSingleCommentItem(rowItem, parsed, matchResult, currentSettings, processedComments, userHistory);
        processedCountInBatch++;

        // 连续私信防封间隔时间 (秒)
        const dmIntervalSec = currentSettings.dmIntervalSeconds !== undefined ? currentSettings.dmIntervalSeconds : 10;
        const dmIntervalMs = dmIntervalSec * 1000 + Math.floor(Math.random() * 2000);
        await StorageUtil.saveSettings({
          statusMessage: `已向 [${parsed.userName}] 发送私信，等待 ${Math.round(dmIntervalMs / 1000)} 秒后继续...`
        });
        await new Promise(r => setTimeout(r, dmIntervalMs));
      }

      // 本轮遍历完成后，检查页面上是否还有残留未回复留言
      console.log(`[Comments Manager Engine] 当前批次处理完成，处理数: ${processedCountInBatch}`);

      // 检查当前屏幕是否有任何尚未处理的留言
      const allRows = findCommentRows();
      let hasPending = false;
      for (const r of allRows) {
        const p = parseCommentRow(r);
        const k = (p.userName + "_" + p.commentText).replace(/\s+/g, '_');
        if (!sessionProcessedKeys.has(k) && !processedComments.includes(k)) {
          hasPending = true;
          break;
        }
      }

      if (!hasPending) {
        // 全部处理完毕，进入空闲状态，等待设定秒数后自动刷新页面拉取服务器最新留言
        window.scrollTo({ top: 0, behavior: 'smooth' });
        const waitSec = Math.max(5, settings.notificationCheckInterval || 15);
        await StorageUtil.saveSettings({
          statusMessage: `当前页面留言已全部处理完毕，${waitSec} 秒后自动刷新页面同步最新留言...`
        });
        isProcessingLoop = false;
        scheduleNextPollOrReload(waitSec, true); // 触发方案 A 自动刷新
        return;
      } else {
        // 还有未处理的留言，滚动加载下一页并继续
        window.scrollBy({ top: 600, behavior: 'smooth' });
        await new Promise(r => setTimeout(r, 1500));
        isProcessingLoop = false;
        scheduleNextPollOrReload(2, false);
        return;
      }

    } catch (err) {
      console.error("[Comments Manager Engine] 巡检循环异常:", err);
      isProcessingLoop = false;
      const waitSec = Math.max(5, settings.notificationCheckInterval || 15);
      scheduleNextPollOrReload(waitSec, true);
    }
  }

  // ===========================================================================
  // 单条留言处理主程序
  // ===========================================================================

  async function processSingleCommentItem(rowItem, parsed, matchResult, currentSettings, processedComments, userHistory) {
    const commentKey = (parsed.userName + "_" + parsed.commentText).replace(/\s+/g, '_');
    const normName = (parsed.userName || '').toLowerCase().trim();
    const userKey = "usr_" + normName;
    const idKey = parsed.fbId ? ("id_" + parsed.fbId) : null;

    await StorageUtil.saveSettings({
      statusMessage: `正在私信 [${parsed.userName}]: 匹配 "${matchResult.matchedKeyword}"...`
    });

    const dmTemplate = getRandomItem(matchResult.rule.dmTemplates, parsed.userName);
    if (!dmTemplate) {
      console.warn("[Comments Manager Engine] 规则未配置私信话术模板");
      sessionProcessedKeys.add(commentKey);
      if (rowItem.container) rowItem.container.style.boxShadow = '';
      return;
    }

    const firstName = parsed.userName.split(' ')[0] || parsed.userName;
    let finalDmText = dmTemplate
      .replace(/\[Name\]/ig, parsed.userName)
      .replace(/\{Name\}/ig, parsed.userName)
      .replace(/\{userName\}/ig, parsed.userName)
      .replace(/\[FullName\]/ig, parsed.userName)
      .replace(/\{FullName\}/ig, parsed.userName)
      .replace(/\[FirstName\]/ig, firstName)
      .replace(/\{FirstName\}/ig, firstName)
      .replace(/\[姓名\]/g, parsed.userName)
      .replace(/\{姓名\}/g, parsed.userName)
      .replace(/\[名\]/g, firstName)
      .replace(/\{名\}/g, firstName);

    if (rowItem.container) rowItem.container.style.boxShadow = '0 0 0 2px #10b981';

    console.log(`[Comments Manager Engine] 开始对用户 [${parsed.userName}] 执行原生弹窗私信...`);
    const dmResult = await performNativeDialogDm(rowItem, parsed.userName, finalDmText);

    if (rowItem.container) rowItem.container.style.boxShadow = '';

    // 记录状态
    sessionProcessedKeys.add(commentKey);
    await StorageUtil.markCommentProcessed(commentKey);
    if (Array.isArray(processedComments) && !processedComments.includes(commentKey)) {
      processedComments.push(commentKey);
    }

    // 记录触达并实时同步内存
    const nowTs = dmResult.success ? Date.now() : 0;
    await StorageUtil.recordUserTouch(userKey, {
      userName: parsed.userName,
      fbId: parsed.fbId || "",
      dmSentSuccess: dmResult.success
    });
    userHistory[userKey] = { userName: parsed.userName, lastDmTime: nowTs };

    if (idKey) {
      await StorageUtil.recordUserTouch(idKey, {
        userName: parsed.userName,
        fbId: parsed.fbId,
        dmSentSuccess: dmResult.success
      });
      userHistory[idKey] = { userName: parsed.userName, lastDmTime: nowTs };
    }

    // 更新统计数据
    const stats = currentSettings.stats || { totalProcessed: 0, totalDmSent: 0, totalErrors: 0 };
    // 注意：totalProcessed 已在扫描阶段即时增加，此处仅负责更新成功与异常计数
    if (dmResult.success) stats.totalDmSent += 1;
    else stats.totalErrors += 1;
    await StorageUtil.saveSettings({ stats });

    // 添加详细日志
    await StorageUtil.addLog({
      userName: parsed.userName,
      commentText: parsed.commentText,
      postUrl: parsed.postUrl || window.location.href,
      profileLink: parsed.profileLink,
      matchedKeyword: matchResult.matchedKeyword,
      dmStatus: dmResult.statusText,
      level: dmResult.success ? "info" : "error"
    });

    // 异步同步到 Google 表格
    try {
      const now = new Date();
      const timeStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
      const dateStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;

      const rowData = [
        timeStr,
        dateStr,
        parsed.fbId || "",
        parsed.userName,
        parsed.profileLink || "",
        parsed.postUrl || window.location.href,
        parsed.commentText || "",
        "FB评论管理工具",
        matchResult.rule.name || matchResult.matchedKeyword,
        parsed.commentTime || "刚刚",
        parsed.pageId || ""
      ];

      chrome.runtime.sendMessage({ action: "SYNC_GOOGLE_SHEETS", payload: rowData }, () => {
        if (chrome.runtime.lastError) { /* ignore */ }
      });
    } catch (e) {
      console.warn("[Comments Manager Engine] 同步 Google Sheets 异常:", e);
    }
  }

  // ===========================================================================
  // v1.3.0: 顶部新客插队嗅探器 (Option 1)
  // ===========================================================================

  async function sniffTopForFreshComment(rules, processedComments, userHistory, currentSettings, cooldownMs) {
    try {
      const topRows = findCommentRows();
      if (topRows.length === 0) return null;

      // 仅嗅探前 2 条
      for (let i = 0; i < Math.min(2, topRows.length); i++) {
        const item = topRows[i];
        const parsed = parseCommentRow(item);
        if (!parsed || !parsed.userName || parsed.userName === "未知用户") continue;

        const commentKey = (parsed.userName + "_" + parsed.commentText).replace(/\s+/g, '_');
        if (!sessionScannedKeys.has(commentKey)) {
          persistScannedKey(commentKey);
          const curSettings = await StorageUtil.getSettings();
          const stats = curSettings.stats || { totalProcessed: 0, totalDmSent: 0, totalErrors: 0 };
          stats.totalProcessed += 1;
          await StorageUtil.saveSettings({ stats });
        }
        if (sessionProcessedKeys.has(commentKey)) continue;

        const isCommentAlreadyProcessed = Array.isArray(processedComments)
          ? processedComments.includes(commentKey)
          : !!processedComments[commentKey];
        if (isCommentAlreadyProcessed) continue;

        // 判定是否属于极度新鲜的新客 (5 分钟以内)
        const ageMinutes = parseCommentAgeMinutes(parsed.commentTime);
        if (ageMinutes > 5 && !isFreshTimeString(parsed.commentTime)) continue;

        // 检查冷却
        const normName = (parsed.userName || '').toLowerCase().trim();
        const userKey = "usr_" + normName;
        const idKey = parsed.fbId ? ("id_" + parsed.fbId) : null;
        const lastDm = Math.max(userHistory[userKey]?.lastDmTime || 0, idKey ? (userHistory[idKey]?.lastDmTime || 0) : 0);
        if (lastDm > 0 && (Date.now() - lastDm < cooldownMs)) continue;

        // 检查关键词匹配
        const matchResult = findMatchingRule(parsed.commentText, rules);
        if (!matchResult) continue;

        return { rowItem: item, parsed, matchResult };
      }
    } catch (e) {
      console.warn("[Sniffer] 顶部新客嗅探异常:", e);
    }
    return null;
  }

  function isFreshTimeString(timeStr) {
    if (!timeStr) return false;
    const s = timeStr.trim().toLowerCase();
    return /^(刚刚|just now|now|agora|d+s*(秒|s|sec|m|min|分|分钟))$/i.test(s);
  }

  // ===========================================================================
  // 核心原生弹窗私信引擎：点击【发消息】-> 弹窗 -> 输入 -> 发送 -> 关闭
  // ===========================================================================

  async function performNativeDialogDm(rowItem, userName, dmText) {
    try {
      const container = rowItem.container;
      const sendBtn = findSendMessageButton(container, rowItem.sendBtn);

      if (!sendBtn) {
        console.warn(`[Native DM] 未在卡片中定位到【发消息】按钮: ${userName}`);
        return {
          success: false,
          statusText: "⚠️ 跳过：未定位到【发消息】按钮"
        };
      }

      // 1. 关闭可能还残留的旧弹窗
      const existingDialog = findOpenDmDialog();
      if (existingDialog) {
        closeDialog(existingDialog);
        await new Promise(r => setTimeout(r, 400));
      }

      // 2. 将【发消息】按钮平滑滚入视口中央
      sendBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await new Promise(r => setTimeout(r, 500));

      // 3. 计算真实屏幕物理坐标并获取承接点击的顶层元素
      const rect = sendBtn.getBoundingClientRect();
      const clientX = Math.round(rect.left + rect.width / 2);
      const clientY = Math.round(rect.top + rect.height / 2);
      const hitTarget = document.elementFromPoint(clientX, clientY) || sendBtn;

      console.log(`[Native DM] 准备点击【发消息】按钮，目标元素: ${sendBtn.tagName}, 顶层命中元素: ${hitTarget.tagName}`);

      if (sendBtn.getAttribute && sendBtn.getAttribute('target') === '_blank') {
        sendBtn.removeAttribute('target');
      }

      // 4. 精准派发单次完整物理鼠标交互事件流
      const evCommons = {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: clientX,
        clientY: clientY,
        screenX: clientX + window.screenX,
        screenY: clientY + window.screenY
      };

      try { hitTarget.focus(); } catch(e) {}

      hitTarget.dispatchEvent(new PointerEvent('pointerover', { ...evCommons, pointerId: 1, pointerType: 'mouse' }));
      hitTarget.dispatchEvent(new MouseEvent('mouseover', evCommons));
      hitTarget.dispatchEvent(new PointerEvent('pointerdown', { ...evCommons, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, pressure: 0.5 }));
      hitTarget.dispatchEvent(new MouseEvent('mousedown', { ...evCommons, button: 0, buttons: 1 }));

      await new Promise(r => setTimeout(r, 80));

      hitTarget.dispatchEvent(new PointerEvent('pointerup', { ...evCommons, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 0 }));
      hitTarget.dispatchEvent(new MouseEvent('mouseup', { ...evCommons, button: 0, buttons: 0 }));
      hitTarget.dispatchEvent(new MouseEvent('click', { ...evCommons, button: 0, buttons: 0 }));

      // 5. 等待私信弹窗展开 (首轮探测 2.5 秒)
      let dialog = await waitForNativeDmDialog(2500);

      if (!dialog) {
        console.log("[Native DM] 首轮事件流未展开，尝试 sendBtn.click() 一级兜底...");
        sendBtn.click();
        dialog = await waitForNativeDmDialog(2500);
      }

      if (!dialog && hitTarget !== sendBtn) {
        console.log("[Native DM] 尝试 hitTarget.click() 二级兜底...");
        hitTarget.click();
        dialog = await waitForNativeDmDialog(2500);
      }

      if (!dialog) {
        console.warn("[Native DM] 等待私信弹窗超时，未检测到弹窗");
        return {
          success: false,
          statusText: "❌ 发送失败：未弹出私信窗口 (网络延迟或受 FB 频率限制)"
        };
      }

      console.log("[Native DM] ✅ 私信弹窗已成功展开！寻找输入框...");

      // 6. 定位弹窗中的输入框
      const inputElem = findDialogInputField(dialog);
      if (!inputElem) {
        console.warn("[Native DM] 弹窗已展开，但未找到输入框");
        closeDialog(dialog);
        return {
          success: false,
          statusText: "❌ 发送失败：未定位到私信输入框"
        };
      }

      // 7. 填写私信内容
      console.log("[Native DM] 正在输入私信内容...");
      await injectTextToInput(inputElem, dmText);
      await new Promise(r => setTimeout(r, 800));

      // 8. 点击弹窗中的蓝色【发消息】按钮
      console.log("[Native DM] 正在点击弹窗中的【发消息】发送按钮...");
      const sent = await clickDialogSendButton(dialog);

      if (!sent) {
        console.log("[Native DM] 未能点击发送按钮，尝试回车发送...");
        inputElem.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
        }));
      }

      // 9. 等待 2.5 秒确保网络请求已发送
      await new Promise(r => setTimeout(r, 2500));

      // 10. 检查弹窗是否仍处于打开状态，若仍打开则优雅关闭
      const dialogStillOpen = document.contains(dialog) && isVisible(dialog);
      if (dialogStillOpen) {
        console.log("[Native DM] 发送完成，正在关闭弹窗...");
        closeDialog(dialog);
        await new Promise(r => setTimeout(r, 500));
      }

      console.log(`[Native DM] ✅ 成功向用户 [${userName}] 发送私信！`);
      return {
        success: true,
        statusText: "✅ 私信发送成功"
      };

    } catch (e) {
      console.error("[Native DM] performNativeDialogDm 发生异常:", e);
      return {
        success: false,
        statusText: "❌ 发送异常: " + (e.message || "未知错误")
      };
    }
  }

  // ---------------------------------------------------------------------------
  // 弹窗与输入辅助函数
  // ---------------------------------------------------------------------------

  function findSendMessageButton(container, cachedBtn) {
    const sendKeywords = ['发消息', '发送消息', '發送訊息', '发讯息', '發訊息', '傳送訊息', '发送', '發送', 'send message', 'message', 'enviar mensagem', 'enviar mensaje', 'envoyer un message', 'kirim pesan'];

    if (cachedBtn && document.contains(cachedBtn) && isVisible(cachedBtn)) {
      return cachedBtn;
    }

    if (!container || !document.contains(container)) return null;

    const clickables = Array.from(container.querySelectorAll('div[role="button"], a[role="link"], a, button, span[role="button"]'));
    for (const el of clickables) {
      if (!isVisible(el)) continue;
      const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
      if (sendKeywords.some(k => txt === k)) {
        return el;
      }
    }

    const allEls = Array.from(container.querySelectorAll('*'));
    for (const el of allEls) {
      if (el.children.length > 0) continue;
      if (!isVisible(el)) continue;
      const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
      if (sendKeywords.some(k => txt === k)) {
        const parentBtn = el.closest('div[role="button"], a, button, span[role="button"]');
        return parentBtn || el;
      }
    }

    return null;
  }

  async function waitForNativeDmDialog(timeoutMs = 6000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const dialog = findOpenDmDialog();
      if (dialog) return dialog;
      await new Promise(r => setTimeout(r, 250));
    }
    return null;
  }

  function findOpenDmDialog() {
    const titleKeywords = ['发消息给', '发送消息给', '發送訊息給', '發訊息給', '傳送訊息給', 'Send message to', 'Enviar mensagem para', 'Enviar mensaje a', 'Envoyer un message à'];
    
    const dialogs = Array.from(document.querySelectorAll('div[role="dialog"], div[aria-modal="true"]'));
    for (const d of dialogs) {
      if (!isVisible(d)) continue;
      const txt = d.innerText || d.textContent || '';
      if (titleKeywords.some(k => txt.includes(k))) {
        return d;
      }
      if ((txt.includes('返回评论') || txt.includes('返回留言') || txt.includes('返回評論') || txt.includes('Back to comment') || txt.includes('Voltar ao comentário')) &&
          d.querySelector('[contenteditable="true"], textarea')) {
        return d;
      }
    }

    const allDivs = Array.from(document.querySelectorAll('div'));
    for (const d of allDivs) {
      if (!isVisible(d)) continue;
      const txt = d.innerText || '';
      if (titleKeywords.some(k => txt.includes(k)) && 
          (txt.includes('返回评论') || txt.includes('返回留言') || txt.includes('返回評論') || txt.includes('Messenger') || txt.includes('Back')) &&
          d.querySelector('[contenteditable="true"], textarea')) {
        return d;
      }
    }

    return null;
  }

  function findDialogInputField(dialog) {
    const selectors = [
      '[contenteditable="true"][aria-multiline="true"]',
      '[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"]',
      'div[aria-label*="消息"][contenteditable]',
      'div[aria-label*="Message"][contenteditable]',
      'textarea',
    ];
    for (const s of selectors) {
      const el = dialog.querySelector(s);
      if (el && isVisible(el)) return el;
    }
    return null;
  }

  async function injectTextToInput(inputElem, text) {
    inputElem.scrollIntoView({ behavior: 'smooth', block: 'center' });
    inputElem.focus();
    inputElem.click();
    await new Promise(r => setTimeout(r, 200));

    try {
      document.execCommand('selectAll', false, null);
    } catch(e) {}

    let success = false;

    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      const pasteEv = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dt
      });
      inputElem.dispatchEvent(pasteEv);
      await new Promise(r => setTimeout(r, 300));
      const content = inputElem.textContent || inputElem.value || '';
      if (content.includes(text.substring(0, Math.min(6, text.length)))) {
        success = true;
      }
    } catch (e) {}

    if (!success) {
      try {
        document.execCommand('insertText', false, text);
        await new Promise(r => setTimeout(r, 300));
        const content = inputElem.textContent || inputElem.value || '';
        if (content.includes(text.substring(0, Math.min(6, text.length)))) {
          success = true;
        }
      } catch (e) {}
    }

    if (!success) {
      try {
        const textEvent = document.createEvent('TextEvent');
        textEvent.initTextEvent('textInput', true, true, window, text, 9, "en-US");
        inputElem.dispatchEvent(textEvent);
        await new Promise(r => setTimeout(r, 300));
      } catch (e) {}
    }

    if (!success) {
      if (inputElem.tagName === 'TEXTAREA' || inputElem.tagName === 'INPUT') {
        inputElem.value = text;
      } else {
        inputElem.innerText = text;
      }
      inputElem.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      inputElem.dispatchEvent(new Event('input', { bubbles: true }));
      inputElem.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
    }
  }

  async function clickDialogSendButton(dialog) {
    const sendKeywords = ['发消息', '发送消息', '發送訊息', '发送', '發送', '發訊息', '傳送訊息', 'Send message', 'Send Message', 'Message', 'Enviar mensagem', 'Enviar mensaje', 'Envoyer un message', 'Kirim Pesan'];
    const skipKeywords = ['返回', '取消', 'Back', 'Cancel', 'Voltar', '返回评论', '返回留言', '返回評論'];

    const allButtons = Array.from(dialog.querySelectorAll('div[role="button"], a[role="link"], button, span[role="button"]'));
    let sendBtn = null;

    for (const btn of allButtons) {
      if (!isVisible(btn)) continue;
      const txt = (btn.innerText || btn.textContent || '').trim();
      if (skipKeywords.some(k => txt.includes(k))) continue;
      if (sendKeywords.some(kw => txt === kw || txt.includes(kw))) {
        sendBtn = btn;
        break;
      }
    }

    if (!sendBtn) {
      for (const btn of allButtons) {
        if (!isVisible(btn)) continue;
        const label = (btn.getAttribute('aria-label') || '').trim();
        if (skipKeywords.some(k => label.includes(k))) continue;
        if (sendKeywords.some(kw => label === kw || label.includes(kw))) {
          sendBtn = btn;
          break;
        }
      }
    }

    if (sendBtn) {
      console.log("[Comments Manager Engine] 找到弹窗发送按钮:", sendBtn.innerText || sendBtn.getAttribute('aria-label'));

      const startWait = Date.now();
      while (Date.now() - startWait < 3000) {
        const isDisabled = sendBtn.getAttribute('aria-disabled') === 'true' || 
                           sendBtn.disabled || 
                           sendBtn.classList.contains('disabled');
        if (!isDisabled) break;
        await new Promise(r => setTimeout(r, 300));
      }

      sendBtn.click();
      await new Promise(r => setTimeout(r, 500));
      return true;
    }

    return false;
  }

  function closeDialog(dialog) {
    const closeBtn = dialog.querySelector('div[aria-label="关闭"], div[aria-label="Close"], svg[aria-label="关闭"], button[aria-label="关闭"]');
    if (closeBtn) {
      closeBtn.click();
    } else {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
    }
  }

  // ---------------------------------------------------------------------------
  // DOM 提取与列表解析辅助函数
  // ---------------------------------------------------------------------------

  function findCommentRows() {
    const sendKeywords = ['发消息', '发送消息', '發送訊息', '发讯息', '發訊息', '傳送訊息', '发送', '發送', 'send message', 'message', 'enviar mensagem', 'enviar mensaje', 'envoyer un message', 'kirim pesan'];
    const allClickables = Array.from(document.querySelectorAll('div[role="button"], span[role="button"], a[role="link"], a, button, span, div'));
    
    const sendButtons = allClickables.filter(el => {
      if (!isVisible(el)) return false;
      if (el.children.length > 2) return false;
      const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
      return sendKeywords.some(k => txt === k.toLowerCase());
    });

    const rows = [];
    const seenContainers = new Set();

    for (const btn of sendButtons) {
      let curr = btn.parentElement;
      let cardContainer = null;

      while (curr && curr !== document.body) {
        const text = curr.innerText || '';
        if ((text.includes('·') || text.includes('•') || /\d+\s*(小时|小時|天|周|週|月|年|h|d|m|s|min)/i.test(text)) && 
            (text.includes('回复') || text.includes('回覆') || text.includes('Reply') || 
             text.includes('隐藏') || text.includes('隱藏') || text.includes('Hide') || 
             text.includes('赞') || text.includes('讚') || text.includes('Like'))) {
          const innerSendCount = Array.from(curr.querySelectorAll('*')).filter(el => {
            const t = (el.innerText || '').trim();
            return t === '发消息' || t === '發送訊息' || t === '發訊息' || t === '傳送訊息' || t === 'Send message';
          }).length;

          if (innerSendCount <= 4) {
            cardContainer = curr;
            break;
          }
        }
        curr = curr.parentElement;
      }

      if (cardContainer && !seenContainers.has(cardContainer)) {
        seenContainers.add(cardContainer);
        rows.push({
          container: cardContainer,
          sendBtn: btn
        });
      }
    }

    return rows;
  }

  /**
   * 精确解析评论行：锚定留言者姓名提取评论时间和评论内容，彻底杜绝误读帖子日期
   */
  function parseCommentRow(rowObj) {
    const { container, sendBtn } = rowObj;

    let userName = "未知用户";
    let commentTime = "刚刚";
    let commentText = "";
    let profileLink = "";
    let postUrl = "";

    // 1. 查找所有链接
    const links = Array.from(container.querySelectorAll('a[href]'));
    const postKeywords = ['/posts/', '/reel/', '/videos/', 'permalink.php', 'story_fbid'];
    const postLinkEl = links.find(a => postKeywords.some(k => (a.href || '').toLowerCase().includes(k)));
    if (postLinkEl) postUrl = postLinkEl.href;

    const userLinks = links.filter(a => {
      if (a === postLinkEl) return false;
      const h = (a.href || '').toLowerCase();
      if (!h) return false;
      if (h.includes('/professional_dashboard/')) return false;
      if (h.includes('/messages/')) return false;
      if (postKeywords.some(k => h.includes(k))) return false;
      return true;
    });

    // 优先从 <a> 文本提取用户名
    for (const a of userLinks) {
      const rawA = (a.innerText || a.textContent || '').trim();
      if (!rawA) continue;
      const namePart = rawA.split(/[·•]/)[0].trim();
      const actionWords = ['赞', '讚', '回复', '回覆', '发消息', '發送訊息', '發訊息', '傳送訊息', '隐藏', '隱藏', '...', 'Like', 'Reply', 'Send message', 'Hide', '翻譯年糕', '查看回覆', '查看更多回覆', '查看更多回复'];
      if (namePart.length > 0 && !actionWords.includes(namePart) && !namePart.includes('条评论') && !namePart.includes('則留言') && !namePart.includes('comentários') && !namePart.includes('comments') && namePart !== '没有文字内容') {
        userName = namePart;
        profileLink = a.href;
        break;
      }
    }

    if (!profileLink && userLinks.length > 0) profileLink = userLinks[0].href;

    // 2. 文本行分析：锚定 用户名 所在行精确提取时间与内容
    const rawText = container.innerText || '';
    const lines = rawText.split('\n').map(s => s.trim()).filter(Boolean);

    // 找到包含 用户名 的行索引
    let userLineIdx = -1;
    if (userName !== "未知用户") {
      userLineIdx = lines.findIndex(l => l.includes(userName));
    }

    if (userLineIdx !== -1) {
      const uLine = lines[userLineIdx];
      // 形式 A: "Beto Rockfeler · 18分钟"
      if (uLine.includes('·') || uLine.includes('•')) {
        const sep = uLine.includes('·') ? '·' : '•';
        const parts = uLine.split(sep);
        if (parts[1] && parts[1].trim()) {
          commentTime = parts[1].trim();
        }
      } else if (lines.length > userLineIdx + 1) {
        // 形式 B: 下一行是时间戳
        const nextLine = lines[userLineIdx + 1];
        if (isPossibleTimeLine(nextLine)) {
          commentTime = nextLine;
        }
      }
    } else {
      // 兜底：寻找非帖子信息的包含 "·" 的时间行
      const timeCandidateIdx = lines.findIndex(l => (l.includes('·') || l.includes('•')) && !l.includes('条评论') && !l.includes('則留言') && !l.includes('comentário') && !l.includes('comment'));
      if (timeCandidateIdx !== -1) {
        const line = lines[timeCandidateIdx];
        const sep = line.includes('·') ? '·' : '•';
        const parts = line.split(sep);
        if (parts[0] && parts[0].trim() && userName === "未知用户") {
          userName = parts[0].trim();
        }
        if (parts[1] && parts[1].trim()) {
          commentTime = parts[1].trim();
        }
      }
    }

    // 3. 精准提取留言内容（在时间之后、动作按钮之前）
    const actionWords = ['赞', '讚', '回复', '回覆', '发消息', '發送訊息', '發訊息', '傳送訊息', '隐藏', '隱藏', 'Like', 'Reply', 'Send message', 'Hide', '翻譯年糕', '查看回覆', '查看更多回覆', '查看更多回复', '...'];
    const candidateLines = [];
    let startCollecting = (userLineIdx !== -1) ? (userLineIdx + 1) : 1;

    for (let i = startCollecting; i < lines.length; i++) {
      const line = lines[i];
      if (actionWords.includes(line)) break;
      if (line === commentTime || line === userName || line.includes(userName)) continue;
      if (line.includes('条评论') || line.includes('則留言') || line.includes('comentário') || line.includes('comment') || line === '没有文字内容' || line === '翻譯年糕') continue;
      if (isPossibleTimeLine(line)) {
        if (commentTime === "刚刚" || commentTime === "剛剛") commentTime = line;
        continue;
      }
      candidateLines.push(line);
    }

    if (candidateLines.length > 0) {
      commentText = candidateLines.join(' ').trim();
    }

    // 清理可能混入的开头时间戳
    if (commentText) {
      commentText = commentText.replace(/^(刚刚|剛剛|\d+\s*(秒|分钟|分鐘|小时|小時|天|周|週|月|年|s|m|h|d|w|y|min|mins|hr|hrs|day|days))\s*[·•\s]*/i, '').trim();
    }

    if (!commentText) {
      const contentEls = Array.from(container.querySelectorAll('div[dir="auto"], span[dir="auto"]'));
      for (const el of contentEls) {
        const t = (el.innerText || '').trim();
        if (!t) continue;
        if (t === userName || t.includes('·') || t === '没有文字内容' || actionWords.includes(t)) continue;
        commentText = t;
        break;
      }
    }

    // 提取用户 ID
    let fbId = "";
    if (profileLink) {
      try {
        const u = new URL(profileLink);
        fbId = u.searchParams.get('id') || u.pathname.split('/').filter(Boolean)[0] || "";
      } catch (e) { fbId = profileLink; }
    }

    let pageId = "";
    if (postUrl) {
      try {
        const u = new URL(postUrl);
        const parts = u.pathname.split('/').filter(Boolean);
        if (parts.length > 0 && !['reel', 'watch', 'groups', 'permalink.php'].includes(parts[0])) pageId = parts[0];
      } catch(e) {}
    }

    return { userName, commentTime, commentText, profileLink, postUrl, fbId, pageId, sendBtn };
  }

  function isPossibleTimeLine(line) {
    if (!line) return false;
    const s = line.trim().toLowerCase();
    if (/^(刚刚|剛剛|just now|now|agora)$/.test(s)) return true;
    if (/^\d+\s*(秒|分|分钟|分鐘|小时|小時|天|周|週|月|年|s|m|h|d|w|y|min|mins|hr|hrs|day|days|hora|horas|dia|dias|sem|semana|mês|meses|ano|anos)$/i.test(s)) return true;
    if (/^(昨天|前天|yesterday|ontem|anteontem)/i.test(s)) return true;
    return false;
  }

  /**
   * 计算留言距离现在的分钟数
   */
  function parseCommentAgeMinutes(timeStr) {
    if (!timeStr) return 0;
    const s = timeStr.trim().toLowerCase();

    if (/^(刚刚|剛剛|just now|now|agora)/i.test(s)) return 0;

    const secMatch = s.match(/^(\d+)\s*(秒|s|sec|seg)/i);
    if (secMatch) return Math.round(parseInt(secMatch[1], 10) / 60);

    const minMatch = s.match(/^(\d+)\s*(分|分钟|分鐘|m|min)/i);
    if (minMatch) return parseInt(minMatch[1], 10);

    const hrMatch = s.match(/^(\d+)\s*(小时|小時|h|hr|hora)/i);
    if (hrMatch) return parseInt(hrMatch[1], 10) * 60;

    const dayMatch = s.match(/^(\d+)\s*(天|d|day|dia)/i);
    if (dayMatch) return parseInt(dayMatch[1], 10) * 1440;

    if (/(昨天|yesterday|ontem)/i.test(s)) return 1440;
    if (/(前天|anteontem)/i.test(s)) return 2880;

    if (/(周|週|w|week|sem)/i.test(s)) return 10080;
    if (/(月|mo|month|mês)/i.test(s)) return 43200;
    if (/(年|y|year|ano)/i.test(s)) return 525600;

    if (/\d{4}[-/.]|\d{1,2}[-/.]\d{1,2}/.test(s)) return 2880;

    return 0;
  }

  /**
   * 判定是否属于超过 24 小时的历史旧留言
   */
  function isHistoricalTime(timeStr) {
    if (!timeStr) return false;
    const s = timeStr.trim().toLowerCase();

    if (/^(刚刚|剛剛|just now|now|agora|moments ago)/i.test(s)) return false;
    if (/^\d+\s*(秒|s|sec|secs|second|seconds|seg|segundos)$/i.test(s)) return false;
    if (/^\d+\s*(分|分钟|分鐘|m|min|mins|minute|minutes|minuto|minutos)$/i.test(s)) return false;
    if (/^\d+\s*(小时|小時|h|hr|hrs|hour|hours|hora|horas)$/i.test(s)) return false;

    if (/[天周週月年]/.test(s)) return true;
    if (/(昨天|前天|yesterday|ontem|anteontem)/i.test(s)) return true;
    if (/\b\d+\s*(d|day|days|w|week|weeks|mo|mon|month|months|y|yr|yrs|year|years)\b/i.test(s)) return true;
    if (/^\d+[dwy]$/i.test(s) || /^\d+mo$/i.test(s)) return true;
    if (/(dia|dias|sem|semana|semanas|mês|meses|mes|ano|anos)/i.test(s)) return true;
    if (/\d{4}[-/.]|\d{1,2}[-/.]\d{1,2}/.test(s)) return true;
    if (/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|janeiro|fevereiro|março|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)/i.test(s)) return true;

    return false;
  }

  async function ensureUnrepliedFilterActive() {
    try {
      const allButtons = Array.from(document.querySelectorAll('div[role="button"], span[role="button"], div[role="tab"], button, span'));
      const unrepliedBtn = allButtons.find(b => {
        const txt = (b.innerText || b.textContent || '').trim();
        return txt === '你未回复' || txt === '未回复' || txt === '尚未回覆' || txt === '你尚未回覆' || txt === '未回覆' || txt === 'Unreplied' || txt === 'Não respondidas' || txt === 'No respondidos';
      });

      if (unrepliedBtn) {
        const isSelected = unrepliedBtn.getAttribute('aria-pressed') === 'true' || 
                           unrepliedBtn.getAttribute('aria-selected') === 'true' ||
                           unrepliedBtn.classList.contains('active');
        if (!isSelected && unrepliedBtn.getAttribute('aria-pressed') !== 'true') {
          console.log("[Comments Manager Engine] 尝试激活【你未回复】筛选器...");
          unrepliedBtn.click();
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    } catch (e) {
      console.warn("[Comments Manager Engine] 筛选器检测异常:", e);
    }
  }

  function findMatchingRule(commentText, rules) {
    const normalize = (s) => (s || '').normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
    const textNorm = normalize(commentText);
    for (const r of rules) {
      if (!r.keywords || r.keywords.length === 0) continue;
      for (const kw of r.keywords) {
        const kwNorm = normalize(kw);
        if (!kwNorm) continue;
        if (r.matchType === 'exact' ? textNorm === kwNorm : textNorm.includes(kwNorm)) {
          return { rule: r, matchedKeyword: kw };
        }
      }
    }
    return null;
  }

  function getRandomItem(array, userName) {
    if (!array || array.length === 0) return null;
    const raw = array[Math.floor(Math.random() * array.length)];
    return raw ? raw.replace(/{userName}/g, userName) : null;
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  function checkFacebookEmergencyBrake(settings) {
    if (settings && settings.emergencyBrakeEnabled === false) return false;
    const pageText = document.body ? document.body.innerText : "";
    const warningKeywords = ["验证码", "Security Check Required", "您已被限制使用此功能", "You're Temporarily Blocked", "Action Blocked"];
    for (const kw of warningKeywords) {
      if (pageText.includes(kw)) {
        chrome.runtime.sendMessage({ action: "TRIGGER_EMERGENCY_BRAKE", reason: `检测到安全拦截: "${kw}"` });
        return true;
      }
    }
    return false;
  }

  // 启动巡检
  scheduleNextPollOrReload(2, false);

})();
