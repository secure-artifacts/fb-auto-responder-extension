# Facebook 私信自动回复扩展 (fb-auto-responder-extension)

面向 Facebook 贴文与主页留言的智能防封自动化私信与监控扩展程序。

## 如何发布新版本

本项目使用 GitHub Actions 自动构建和发布。每次发布新版本只需要创建一个 Git Tag 并推送即可。

### 发布步骤

#### 1. 确保代码已提交并推送

在发布之前，确保你的所有代码改动已经提交并推送到 GitHub：

```bash
# 查看当前状态
git status

# 添加所有改动
git add .

# 提交改动
git commit -m "更新说明"

# 推送到主分支
git push origin main
```

#### 2. 创建并推送版本 Tag

创建版本号 Tag（必须以 `v` 开头，如 `v1.0.1`）：

```bash
# 创建本地 tag
git tag -a v1.0.1 -m "Release version 1.0.1"

# 推送 tag 到远程
git push origin v1.0.1
```

#### 3. 自动构建与发布

推送 tag 后，GitHub Actions 会自动触发构建、生成 Attestation 安全签名并发布二进制 zip 到 GitHub Release 页面。
