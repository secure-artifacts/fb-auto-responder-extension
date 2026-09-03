/**
 * FB 智能私信大师 - Notification Monitor Content Script
 * 驻留 https://www.facebook.com/notifications 页面，秒级捕获最新留言通知并直达私信
 */

(async function () {
  // 只在通知页面生效
  if (!window.location.pathname.startsWith('/notifications')) {
    return;
  }

  console.log("[Notification Monitor] 已加载，准备监听全主页通知流...");

  let isProcessingNotification = false;
  const sessionClickedNotifs = new Set();

  async function checkAndRun() {
    const settings = await StorageUtil.getSettings();
    if (!settings.isRunning || settings.isPaused) return;
    if (settings.enableNotificationMode === false) return;

    if (isProcessingNotification) return;

    await StorageUtil.saveSettings({
      statusMessage: "正在监听全主页通知流，检索未读留言...",
      currentWorkerMode: 'notification'
    });

    // 1. 尝试定位并优先切换至【未读 (Unread)】标签
    await trySwitchToUnreadTab();

    // 2. 扫描可见的通知列表
    let commentNotifs = await findEligibleCommentNotifications(settings);

    // 如果首屏没发现，尝试向下滚动寻找较早（如今天上午、昨天）的未读留言
    if (commentNotifs.length === 0) {
      console.log("[Notification Monitor] 首屏暂无新通知，向下滚动寻找较早未读通知...");
      window.scrollBy({ top: 600, behavior: 'smooth' });
      await new Promise(r => setTimeout(r, 1500));
      commentNotifs = await findEligibleCommentNotifications(settings);
    }

    if (commentNotifs.length > 0) {
      const targetNotif = commentNotifs[0];
      isProcessingNotification = true;

      const userName = targetNotif.userName || "通知用户";
      await StorageUtil.saveSettings({
        statusMessage: `⚡ 捕获到来自 [${userName}] 的最新评论通知，正在跳转处理...`
      });

      console.log(`[Notification Monitor] 点击目标通知: ${targetNotif.text.substring(0, 40)}...`);
      console.log(`[Notification Monitor] 目标URL: ${targetNotif.targetUrl}`);

      // 会话级去重，60秒内不重复点击相同通知
      sessionClickedNotifs.add(targetNotif.notifKey);
      setTimeout(() => {
        sessionClickedNotifs.delete(targetNotif.notifKey);
      }, 60000);

      // 第一重手段：仿真人类点击目标 <a> 链接及内部子元素
      simulateHumanClick(targetNotif.linkElement);
      if (targetNotif.linkElement.firstElementChild) {
        simulateHumanClick(targetNotif.linkElement.firstElementChild);
      }

      // 第二重保障：若 Facebook React 未触发内部路由跳转，1 秒后直接通过 location.href 强制直达
      setTimeout(() => {
        if (window.location.pathname.startsWith('/notifications') && targetNotif.targetUrl) {
          console.log("[Notification Monitor] 仿真点击未跳转，启动原生强制导航直达:", targetNotif.targetUrl);
          window.location.href = targetNotif.targetUrl;
        }
      }, 1000);

      // 重置锁，防止极端异常卡死
      setTimeout(() => {
        isProcessingNotification = false;
      }, 8000);
      return;
    }

    // 如果未读通知全部处理完毕，回到顶部并等待下一次检查
    window.scrollTo({ top: 0, behavior: 'smooth' });
    const intervalSec = Math.max(3, settings.notificationCheckInterval || 5);
    await StorageUtil.saveSettings({
      statusMessage: `暂无新未读留言，${intervalSec} 秒后再次巡检...`
    });

    setTimeout(checkAndRun, intervalSec * 1000);
  }

  // 尝试点击切换【未读】标签
  async function trySwitchToUnreadTab() {
    try {
      const buttons = Array.from(document.querySelectorAll('div[role="tab"], div[role="button"], a[role="tab"], span'));
      const unreadBtn = buttons.find(b => {
        const txt = (b.innerText || b.textContent || '').trim();
        return txt === '未读' || txt === 'Unread' || txt === 'Não lidas' || txt === 'No leídas';
      });

      if (unreadBtn && !unreadBtn.getAttribute('aria-selected')) {
        // 如果未读按钮存在且当前未处于选中状态，点击它
        unreadBtn.click();
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (e) {
      console.warn("[Notification Monitor] 切换未读标签异常:", e);
    }
  }

  // 筛选出符合规则的评论通知
  async function findEligibleCommentNotifications(settings) {
    const candidateNodes = Array.from(document.querySelectorAll('a[href*="notif_id"], a[role="link"], div[role="row"], div[role="listitem"]'));
    const commentKeywords = ['评论了', 'commented on', 'comentou', 'ha comentado', 'ha fatto un commento'];
    const excludeKeywords = ['赞了', 'liked', 'curtiu', '关注', 'followed', 'seguindo', '发了消息', 'sent a message', '播放', 'views', 'visualizações'];

    const eligible = [];

    for (const node of candidateNodes) {
      const text = (node.innerText || node.textContent || '').trim();
      if (!text) continue;

      // 必须包含评论关键词
      const isComment = commentKeywords.some(k => text.includes(k));
      if (!isComment) continue;

      // 严苛排除点赞、关注等干扰通知
      const isExcluded = excludeKeywords.some(k => text.includes(k));
      if (isExcluded) continue;

      // 寻找真正的 <a> 链接元素
      const linkElem = (node.tagName === 'A' && node.href) ? node : node.querySelector('a[href]');
      if (!linkElem || !linkElem.href) continue;

      const targetUrl = linkElem.href;

      // 生成唯一识别 Key 用于去重
      const notifKey = text.replace(/\s+/g, '_').substring(0, 50);
      if (sessionClickedNotifs.has(notifKey)) {
        continue;
      }

      // 时间过滤：如果未勾选【处理历史留言】，则排除带“天、周、月、年”的历史通知
      if (!settings.includeHistory) {
        const isHistorical = ['天', '周', '月', '年', 'd', 'w', 'm', 'y'].some(unit => {
          const regex = new RegExp(`\\d+\\s*${unit}`, 'i');
          return regex.test(text);
        });
        if (isHistorical) {
          continue;
        }
      }

      // 提取可能的用户名
      let userName = "通知用户";
      const parts = text.split('评论了');
      if (parts.length > 1) {
        userName = parts[0].trim().replace(/^未读\s*/, '');
      }

      if (isVisible(node) || isVisible(linkElem)) {
        eligible.push({
          element: node,
          linkElement: linkElem,
          targetUrl: targetUrl,
          text: text,
          userName: userName,
          notifKey: notifKey
        });
        break; // 优先获取首条最新
      }
    }

    return eligible;
  }

  function simulateHumanClick(el) {
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
    el.click();
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  // 页面加载就绪后启动监听循环
  setTimeout(checkAndRun, 2000);

})();
