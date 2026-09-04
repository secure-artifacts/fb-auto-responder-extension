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
        statusMessage: `⚡ 捕获到来自 [${userName}] 的最新评论通知，正在展开处理...`
      });

      console.log(`[Notification Monitor] 点击目标通知: ${targetNotif.text.substring(0, 40)}...`);
      console.log(`[Notification Monitor] 目标URL: ${targetNotif.targetUrl}`);

      // 会话级去重，60秒内不重复点击相同通知
      sessionClickedNotifs.add(targetNotif.notifKey);
      setTimeout(() => {
        sessionClickedNotifs.delete(targetNotif.notifKey);
      }, 60000);

      // 仅触发单次精准点击，避免双击导致弹窗闪退
      simulateHumanClick(targetNotif.linkElement);

      // 等待 Reels/贴文弹窗浮层展开或页面跳转
      let postOpened = false;
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 600));
        if (document.querySelector('div[role="dialog"]') || 
            document.querySelector('div[data-pagelet="Reels"]') || 
            document.querySelector('div[aria-label*="Reel"]') ||
            document.querySelector('form[role="presentation"]') ||
            !window.location.pathname.startsWith('/notifications')) {
          postOpened = true;
          break;
        }
      }

      if (postOpened) {
        console.log("[Notification Monitor] 检测到贴文/Reels 评论区已成功展开，调用私信引擎扫描...");
        if (window.FB_SCRUBBER && typeof window.FB_SCRUBBER.startSingleRun === 'function') {
          await window.FB_SCRUBBER.startSingleRun(targetNotif.targetUrl || window.location.href);
        }

        // 处理完成后，如果是通知页浮层，关闭该浮层返回通知列表
        if (window.location.pathname.startsWith('/notifications')) {
          closeCurrentOverlay();
          await new Promise(r => setTimeout(r, 1500));
        }
      } else {
        // 如果 6 秒后仍未展开任何弹窗，强制通过 location.href 跳转
        if (window.location.pathname.startsWith('/notifications') && targetNotif.targetUrl) {
          console.log("[Notification Monitor] 弹窗未展开，启动原生强制直达:", targetNotif.targetUrl);
          window.location.href = targetNotif.targetUrl;
          return;
        }
      }

      isProcessingNotification = false;
      // 等待自定义的通知检查间隔后继续扫描下一条
      const intervalSec = Math.max(3, settings.notificationCheckInterval || 5);
      await StorageUtil.saveSettings({
        statusMessage: `当前通知已处理，${intervalSec} 秒后检索下一条...`
      });
      setTimeout(checkAndRun, intervalSec * 1000);
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

  function closeCurrentOverlay() {
    console.log("[Notification Monitor] 正在关闭当前 Reels/贴文弹窗浮层...");
    const closeBtn = document.querySelector('div[aria-label="关闭"], div[aria-label="Close"], svg[aria-label="关闭"], button[aria-label="关闭"], div[role="button"][aria-label*="close" i]');
    if (closeBtn) {
      closeBtn.click();
    } else {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
    }
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

      // 精准寻找真正的贴文/Reels超链接，严格过滤掉头像链接与粉丝主页链接
      let linkElem = null;
      const isBadLink = (u) => {
        const s = (u || '').toLowerCase();
        return s.includes('/followers') || s.includes('/following') || s.includes('/friends') || s.includes('/photos') || s.includes('/about');
      };

      if (node.tagName === 'A' && node.href && !isBadLink(node.href)) {
        linkElem = node;
      } else {
        const allLinks = Array.from(node.querySelectorAll('a[href]')).filter(a => !isBadLink(a.href));
        // 优先锁定带有 notif_id、comment_id、reel、posts 或含有评论正文的链接
        linkElem = allLinks.find(a => {
          const h = (a.href || '').toLowerCase();
          const innerT = (a.innerText || a.textContent || '').trim();
          const isPostParam = h.includes('notif_id') || h.includes('comment_id') || h.includes('/reel/') || h.includes('/posts/') || h.includes('story_fbid');
          const hasText = commentKeywords.some(k => innerT.includes(k));
          return isPostParam || hasText;
        }) || allLinks[allLinks.length - 1]; // 通常最后一个链接才是内容主体，第一个往往是头像
      }

      if (!linkElem || !linkElem.href || isBadLink(linkElem.href)) continue;

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
