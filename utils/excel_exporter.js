/**
 * FB 智能贴文自动回复与私信大师 - Excel / CSV 导出会话工具
 */

const ExcelExporter = {
  /**
   * 将日志数组导出为 CSV 文件 (带有 UTF-8 BOM，原生支持 Excel 打开中文不乱码)
   */
  exportLogsToCSV(logs, filename = 'FB_AutoResponder_Logs.csv') {
    if (!logs || logs.length === 0) {
      alert("当前没有可导出的日志数据！");
      return;
    }

    const headers = [
      "序号",
      "记录时间",
      "留言用户",
      "匹配关键词",
      "留言内容",
      "私信触发状态",
      "公开评论状态",
      "贴文链接",
      "日志级别"
    ];

    const rows = logs.map((item, index) => [
      index + 1,
      `"${item.timestamp || ''}"`,
      `"${(item.userName || '').replace(/"/g, '""')}"`,
      `"${(item.matchedKeyword || '').replace(/"/g, '""')}"`,
      `"${(item.commentText || '').replace(/"/g, '""')}"`,
      `"${(item.dmStatus || '').replace(/"/g, '""')}"`,
      `"${(item.commentStatus || '').replace(/"/g, '""')}"`,
      `"${(item.postUrl || '').replace(/"/g, '""')}"`,
      `"${item.level || 'info'}"`
    ]);

    // UTF-8 BOM
    const BOM = "\uFEFF";
    const csvContent = BOM + [headers.join(","), ...rows.map(r => r.join(","))].join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
};

if (typeof window !== 'undefined') {
  window.ExcelExporter = ExcelExporter;
}
