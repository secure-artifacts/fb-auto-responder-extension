/**
 * FB 智能私信大师 - Messenger Sender Content Script (v1.1.4)
 * 运行于 facebook.com/messages/* 页面
 * 等待后台通过 chrome.scripting.executeScript 或消息注入私信文本并发送
 */

(function () {
  if (!window.location.pathname.startsWith('/messages')) return;

  // 此脚本作为"待命状态"运行，后台将通过 chrome.scripting.executeScript 直接注入发送函数
  // 无需在此预加载任何逻辑，仅在页面加载完成后标记页面就绪状态
  console.log("[Messenger Sender] Messenger 页面 Content Script 已就位 (v1.1.4)");
})();
