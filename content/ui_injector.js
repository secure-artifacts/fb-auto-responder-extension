/**
 * FB 智能私信大师 - UI 注入模块
 * 在贴文底部（互动区）自动注入“一键加入监控”按钮
 */

let toastTimer = null;

function showToast(message, type = 'success') {
  let toast = document.getElementById('fb-auto-dm-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'fb-auto-dm-toast';
    toast.className = 'fb-auto-dm-toast';
    document.body.appendChild(toast);
  }
  
  toast.textContent = message;
  toast.style.backgroundColor = type === 'success' ? '#2e7d32' : '#c62828';
  toast.classList.add('show');
  
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('show');
  }, 3000);
}

function cleanFbUrl(rawUrl) {
  try {
    const url = new URL(rawUrl, window.location.origin);
    url.searchParams.delete('__cft__[0]');
    url.searchParams.delete('__tn__');
    url.searchParams.delete('fbclid');
    return url.href;
  } catch (e) {
    return rawUrl;
  }
}

function extractPostUrl(actionBar) {
  // 1. 如果当前页面已经是单独的 Reel 或 视频页
  if (window.location.href.includes('/reel/') || window.location.href.includes('/videos/')) {
    // 检查是否是主页信息流中的弹出框，如果是单页直接返回
    return cleanFbUrl(window.location.href);
  }

  // 2. 向上寻找贴文容器 (通常是 role="article" 或者是某个较大的容器)
  let container = actionBar.closest('div[role="article"]');
  if (!container) {
    // 如果没有 role="article"（有些 Reels 或新版 UI 没有），尝试向上找包含发帖人信息的块
    container = actionBar.parentElement;
    for (let i = 0; i < 8; i++) {
      if (container && container.parentElement) container = container.parentElement;
    }
  }

  if (container) {
    // 寻找时间戳链接，通常包含 posts, videos, permalink, story
    const links = Array.from(container.querySelectorAll('a[href]'));
    for (let a of links) {
      const href = a.getAttribute('href');
      if (!href || href === '#') continue;
      if (href.includes('/posts/') || 
          href.includes('/videos/') || 
          href.includes('/reel/') || 
          href.includes('permalink.php') || 
          href.includes('story.php')) {
        
        // 排除掉一些无关的分享或回复链接
        if (href.includes('comment_id=')) continue;

        return cleanFbUrl(a.href);
      }
    }
  }

  // 兜底：如果实在找不到，就用当前页面的 URL
  return cleanFbUrl(window.location.href);
}

async function toggleMonitorStatus(btn, postUrl) {
  try {
    const settings = await StorageUtil.getSettings();
    let urls = settings.targetUrls || [];
    const isActive = btn.classList.contains('state-active');
    
    if (isActive) {
      // 取消监控
      urls = urls.filter(u => u !== postUrl);
      await StorageUtil.saveSettings({ targetUrls: urls });
      
      btn.classList.remove('state-active');
      btn.classList.add('state-idle');
      btn.title = '🌟 开启监控';
      showToast('❌ 已取消监控该贴文');
    } else {
      // 加入监控
      if (!urls.includes(postUrl)) {
        urls.push(postUrl);
        await StorageUtil.saveSettings({ targetUrls: urls });
      }
      
      btn.classList.remove('state-idle');
      btn.classList.add('state-active');
      btn.title = '✓ 取消监控';
      showToast('✅ 已成功加入智能监控队列！');
    }
  } catch (err) {
    console.error("操作失败", err);
    showToast('操作失败，请重试', 'error');
  }
}

function getPostContainer(btn) {
  let c = btn.closest('div[role="article"]') || 
          btn.closest('div[data-pagelet^="FeedUnit"]') ||
          btn.closest('div[data-pagelet*="Reel"]') ||
          btn.closest('div[aria-label*="Reel"]');
  if (!c) {
    c = btn.parentElement;
    for (let i = 0; i < 6; i++) {
      if (c && c.parentElement && c.parentElement !== document.body) {
        c = c.parentElement;
      }
    }
  }
  return c;
}

function getBestTargetButton(container) {
  const share = container.querySelector('div[role="button"][aria-label*="分享"], div[role="button"][aria-label*="Share"], div[role="button"][aria-label*="发送"], div[role="button"][aria-label*="Send"]');
  if (share) return share;

  const comment = container.querySelector('div[role="button"][aria-label*="留言"], div[role="button"][aria-label*="Comment"], div[role="button"][aria-label*="评论"]');
  if (comment) return comment;

  const like = container.querySelector('div[role="button"][aria-label*="赞"], div[role="button"][aria-label*="Like"], div[role="button"][aria-label*="讚"]');
  if (like) return like;

  return null;
}

async function injectButtons() {
  const settings = await StorageUtil.getSettings();
  const monitoredUrls = settings.targetUrls || [];

  const ariaKeywords = [
    '赞', 'Like', '讚', 
    '留言', 'Comment', '评论',
    '分享', 'Share', '发送', 'Send'
  ];
  
  const selectors = ariaKeywords.map(k => `div[role="button"][aria-label^="${k}"], div[role="button"][aria-label*="${k}"]`).join(', ');
  const candidateButtons = document.querySelectorAll(selectors);

  candidateButtons.forEach(btnElement => {
    if (!btnElement) return;
    
    // 严苛排除：评论区、回复区、发评论输入框
    if (btnElement.closest('form') || 
        btnElement.closest('ul') || 
        btnElement.closest('div[role="article"] div[role="article"]')) {
      return;
    }

    // 向上穿透寻找真正的横向按钮排列栏 (跳过只有1个子元素的单按钮包装层)
    let actionBar = btnElement.parentElement;
    while (actionBar && actionBar !== document.body && actionBar.children.length === 1) {
      actionBar = actionBar.parentElement;
    }

    if (!actionBar || actionBar.hasAttribute('data-dm-injected')) return;

    // 标记当前贴文互动栏，确保单条贴文绝对只加一个按钮，绝不遗漏也绝重复
    actionBar.setAttribute('data-dm-injected', 'true');

    // 提取贴文链接
    const postUrl = extractPostUrl(btnElement);
    if (!postUrl) return;

    const isMonitored = monitoredUrls.some(u => postUrl.includes(u) || u.includes(postUrl));

    // 创建精致图标按钮
    const btn = document.createElement('div');
    btn.className = 'fb-auto-dm-btn ' + (isMonitored ? 'state-active' : 'state-idle');
    btn.title = isMonitored ? '✓ 取消监控' : '🌟 开启监控';
    
    const img = document.createElement('img');
    img.src = chrome.runtime.getURL("assets/icon48.png");
    btn.appendChild(img);

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      toggleMonitorStatus(btn, postUrl);
    });

    // 强制把容器设为单行横向 Flex 排版，防止把 Facebook 的分享等按钮挤压折行
    try {
      actionBar.style.setProperty('display', 'flex', 'important');
      actionBar.style.setProperty('flex-direction', 'row', 'important');
      actionBar.style.setProperty('flex-wrap', 'nowrap', 'important');
      actionBar.style.setProperty('align-items', 'center', 'important');
    } catch (e) {}

    // 追加挂载到互动栏末尾
    actionBar.appendChild(btn);
  });
}

// 持续监听页面变化（无限滚动）
const observer = new MutationObserver(() => {
  injectButtons();
});

observer.observe(document.body, { childList: true, subtree: true });

// 初始执行
setTimeout(injectButtons, 2000);
