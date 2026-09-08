/**
 * FB 智能私信大师 - 本地存储封装 (V5.0 纯私信单签页架构)
 */

const DEFAULT_SETTINGS = {
  isRunning: false,
  isPaused: false,
  targetUrls: [],
  activeUrls: [
    "https://www.facebook.com/",
    "https://www.facebook.com/reels",
    "https://www.facebook.com/events"
  ],
  globalCooldownHours: 24,
  dmCooldownHours: 24, // 私信专属 24 小时冷却
  dmIntervalSeconds: 10, // 连续发私信的时间间隔
  switchIntervalSeconds: 15, // 页面停留与切换间隔（秒）
  enableFillerUrls: true, // 是否开启伪装链接防封浏览
  fillerWaitMin: 15, // 伪装页面最短停留时间（秒）
  fillerWaitMax: 45, // 伪装页面最长停留时间（秒）
  emergencyBrakeEnabled: true,
  emergencyBrakeReason: "",
  enableCommentsManagerMode: true, // 是否开启专业面板【评论管理工具】监控 (首选)
  enableTargetUrlsMode: false, // 是否开启指定贴文列表循环监控
  notificationCheckInterval: 15, // 空闲自动刷新间隔（秒，默认15秒）
  enableTimeWindowFilter: false, // 是否开启时效过滤 (方案二：仅回复最近X分钟内留言)
  maxCommentAgeMinutes: 15, // 时效过滤最大分钟数 (默认15分钟)
  statusMessage: "系统就绪，等待启动任务...",
  taskSessionId: 0,
  stats: {
    totalProcessed: 0,
    totalDmSent: 0,
    totalErrors: 0
  }
};

const DEFAULT_RULES = [
  {
    id: "default_rule_1",
    name: "通用关键词触发",
    matchType: "contains",
    keywords: ["Amen", "Amém", "领用", "资料", "价格", "想了解"],
    dmTemplates: [
      "Hi {userName}，非常感谢您的留言！这是您需要的专属资料链接，请查收：https://example.com/info",
      "你好 {userName}！已收到您的需求，小帮手已将详细内容发到您的私信中咯~"
    ]
  }
];

function sanitizeTargetUrls(urls) {
  if (!Array.isArray(urls)) return [];
  const cleaned = [];
  for (const raw of urls) {
    if (!raw || typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    // 严格过滤 profile.php 占位或个人主页
    if (trimmed.includes('profile.php#') || trimmed.includes('profile.php?')) continue;
    try {
      const u = new URL(trimmed);
      if (u.pathname.includes('profile.php')) continue;
      const paramsToDelete = [
        '__cft__[0]', '__tn__', 'fbclid', 'ref', 'source', 'mibextid', 'rdid',
        'comment_id', 'reply_comment_id', 'notif_id', 'notif_t', 'refid', 'paipv', 'locale'
      ];
      for (const p of paramsToDelete) {
        u.searchParams.delete(p);
      }
      u.hash = '';
      const finalUrl = u.href;
      if (!cleaned.includes(finalUrl)) {
        cleaned.push(finalUrl);
      }
    } catch (e) {
      if (!cleaned.includes(trimmed)) cleaned.push(trimmed);
    }
  }
  return cleaned;
}

const StorageUtil = {
  sanitizeTargetUrls,

  async getSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['settings'], (res) => {
        const data = { ...DEFAULT_SETTINGS, ...(res.settings || {}) };
        if (Array.isArray(data.targetUrls)) {
          const originalCount = data.targetUrls.length;
          const originalJson = JSON.stringify(data.targetUrls);
          data.targetUrls = sanitizeTargetUrls(data.targetUrls);
          // 若发现 profile.php# 等脏数据或未清洗的参数，立即自动清洗并静默持久化回 storage
          if (data.targetUrls.length !== originalCount || JSON.stringify(data.targetUrls) !== originalJson) {
            chrome.storage.local.set({ settings: data });
          }
        }
        resolve(data);
      });
    });
  },

  async saveSettings(newSettings) {
    const current = await this.getSettings();
    if (Array.isArray(newSettings.targetUrls)) {
      newSettings.targetUrls = sanitizeTargetUrls(newSettings.targetUrls);
    }
    const updated = { ...current, ...newSettings };
    return new Promise((resolve) => {
      chrome.storage.local.set({ settings: updated }, () => resolve(updated));
    });
  },

  async getRules() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['rules'], (res) => {
        resolve(res.rules || DEFAULT_RULES);
      });
    });
  },

  async saveRules(rules) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ rules }, () => resolve(rules));
    });
  },

  async getUserHistory() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['userHistory'], (res) => {
        resolve(res.userHistory || {});
      });
    });
  },

  /**
   * 记录某个用户的触达记录
   */
  async recordUserTouch(userKey, record) {
    const history = await this.getUserHistory();
    const current = history[userKey] || {};

    history[userKey] = {
      ...current,
      ...record,
      lastTriggerTime: Date.now(),
      lastDmTime: record.dmSentSuccess ? Date.now() : (current.lastDmTime || 0)
    };

    return new Promise((resolve) => {
      chrome.storage.local.set({ userHistory: history }, () => resolve(history));
    });
  },

  async clearUserHistory() {
    return new Promise((resolve) => {
      chrome.storage.local.set({ userHistory: {}, processedComments: [] }, () => resolve({}));
    });
  },

  /**
   * 私信专属 24 小时冷却检测
   */
  async isUserInDmCooldown(userKey, dmCooldownHours) {
    if (dmCooldownHours <= 0) return false; // 0 小时代表测试模式禁用冷却

    const history = await this.getUserHistory();
    const userRec = history[userKey];
    if (!userRec || !userRec.lastDmTime) return false;

    const elapsedMs = Date.now() - userRec.lastDmTime;
    const cooldownMs = dmCooldownHours * 60 * 60 * 1000;
    return elapsedMs < cooldownMs;
  },

  async getProcessedComments() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['processedComments'], (res) => {
        resolve(res.processedComments || []);
      });
    });
  },

  async markCommentProcessed(commentId) {
    const list = await this.getProcessedComments();
    if (!list.includes(commentId)) {
      list.push(commentId);
      if (list.length > 5000) list.shift();
      return new Promise((resolve) => {
        chrome.storage.local.set({ processedComments: list }, () => resolve(list));
      });
    }
  },

  async getLogs() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['logs'], (res) => {
        resolve(res.logs || []);
      });
    });
  },

  async addLog(logEntry) {
    const logs = await this.getLogs();
    const now = new Date();
    const timeStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;

    const item = {
      id: "log_" + Date.now() + "_" + Math.floor(Math.random()*1000),
      timestamp: timeStr,
      userName: logEntry.userName || "未知用户",
      postUrl: logEntry.postUrl || "",
      profileLink: logEntry.profileLink || "",
      commentText: logEntry.commentText || "",
      matchedKeyword: logEntry.matchedKeyword || "-",
      dmStatus: logEntry.dmStatus || "未发送",
      level: logEntry.level || "info"
    };

    logs.unshift(item);
    if (logs.length > 1000) logs.pop();

    return new Promise((resolve) => {
      chrome.storage.local.set({ logs }, () => resolve(item));
    });
  },

  async clearLogs() {
    return new Promise((resolve) => {
      chrome.storage.local.set({ logs: [] }, () => resolve([]));
    });
  },

  async getGoogleSheets() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['googleSheets'], (res) => {
        resolve(res.googleSheets || []);
      });
    });
  },

  async saveGoogleSheets(googleSheets) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ googleSheets }, () => resolve(googleSheets));
    });
  }
};

// 兼容 Service Worker (无 window) 与 content script / popup (有 window) 两种环境
if (typeof globalThis !== 'undefined') {
  globalThis.StorageUtil = StorageUtil;
}
if (typeof window !== 'undefined') {
  window.StorageUtil = StorageUtil;
}
