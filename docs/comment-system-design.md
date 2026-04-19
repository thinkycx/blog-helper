# 评论系统设计

状态：v1 已实现

## 设计原则

1. **零门槛留言** — 不需要注册/登录/OAuth，填邮箱+昵称即可评论
2. **零外部依赖** — 复用 blog-helper 现有架构（Go + SQLite 单二进制）
3. **隐私优先** — 邮箱/IP/UA 等敏感信息仅博主后台可见，前端只暴露昵称、头像、签名
4. **身份可恢复** — Cookie token 实现同设备免登录，换设备通过邮箱恢复身份
5. **渐进增强** — 核心功能（留言+展示+反应）已完成，审核/通知按需迭代

---

## 已实现功能

### 评论核心
- 评论发布：邮箱+昵称，Cookie token 免登录
- 引用回复：parent_id 单层嵌套
- Markdown 渲染：marked.js（本地加载，非 CDN）+ 白名单 HTML 净化
- 评论表单：编写/预览 tab 切换，实时 Markdown 预览
- 审核模式：`off` / `auto-approve` / `moderation` 三种模式
- 锚点定位：`#comment-{id}` URL 分享，自动滚动高亮

### Emoji 反应
- 评论级：❤️ 爱心反应（fingerprint 去重，乐观 UI 更新）
- 文章级：❤️ 文章喜欢按钮（文章底部右下角，乐观 UI 更新）
- 文章右上角 stats 展示喜欢数（只读，不可点击）
- 防重复：后端 UNIQUE 约束 + fingerprint 去重

### 反垃圾
- Proof-of-Work：SHA-256 前缀挑战（客户端 ~50-200ms 计算）
- Rate limit：每 IP 每分钟最多 5 条评论
- 蜜罐字段：hidden input 反机器人

### 侧边栏
- Recent Comments：最新 5 条评论
- Hot Comments：emoji 反应最多的 5 条评论
- 多行展示（最多 3 行，超出省略）
- 格式：`昵称回复: 内容` + 时间/emoji 信息

### 安全
- Markdown 白名单净化：只允许安全标签（p, a, code, pre, img, blockquote, ul, ol, h1-h6 等）
- 拦截 `javascript:` / `data:` URL
- 链接强制 `target="_blank" rel="noopener noreferrer"`
- `<script>`, `<iframe>`, `onerror` 等事件属性全部过滤
- marked.js 本地加载，避免 CDN 供应链投毒风险

---

## 数据模型

```sql
commenters (
  id, email UNIQUE, nickname, avatar_seed, blog_url, bio,
  reg_ip, reg_ua, reg_fp, created_at, updated_at, last_seen_at
)

commenter_tokens (
  token PRIMARY KEY, commenter_id, site_id, device_info, created_at
)

comments (
  id, site_id, page_slug, commenter_id, parent_id,
  content, status, ip, user_agent, fingerprint, created_at
)

comment_reactions (
  id, comment_id, emoji, fingerprint, created_at,
  UNIQUE(comment_id, emoji, fingerprint)
)

page_reactions (
  id, site_id, page_slug, emoji, fingerprint, created_at,
  UNIQUE(site_id, page_slug, emoji, fingerprint)
)
```

---

## API

### 公开接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/comments?slug=&site_id=&fp=` | 获取评论列表 |
| POST | `/api/v1/comments/post` | 提交评论（需 PoW） |
| GET | `/api/v1/comments/count?site_id=&slugs=` | 批量获取评论数 |
| GET | `/api/v1/comments/challenge` | 获取 PoW 挑战 |
| POST | `/api/v1/comments/react` | 评论 emoji 反应 |
| GET | `/api/v1/comments/recent?site_id=&limit=` | 最新评论 |
| GET | `/api/v1/comments/hot?site_id=&limit=` | 热门评论 |
| GET | `/api/v1/comments/config` | 评论系统配置 |
| POST | `/api/v1/page/react` | 文章 emoji 反应 |
| GET | `/api/v1/page/reactions?slug=&site_id=&fp=` | 获取文章反应 |
| GET | `/api/v1/commenter/lookup?email=` | 邮箱查身份 |
| PUT | `/api/v1/commenter/profile` | 修改资料（需 token） |

### Dashboard 接口（需认证）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/comments/pending?site_id=` | 待审核列表 |
| POST | `/api/v1/comments/approve?id=` | 通过 |
| POST | `/api/v1/comments/reject?id=` | 拒绝 |
| POST | `/api/v1/comments/delete?id=` | 删除 |
| GET | `/api/v1/comments/all?site_id=&limit=&offset=` | 分页获取全部评论 |
| POST | `/api/v1/comments/admin-reply` | 管理员回复（以"作者"身份） |
| GET | `/api/v1/comments/mode` | 获取当前评论模式 |
| POST | `/api/v1/comments/mode` | 运行时切换评论模式 |
| GET | `/api/v1/commenters/all?limit=&offset=` | 分页获取评论用户列表 |

---

## 配置

| 参数 | 环境变量 | 默认值 | 说明 |
|------|----------|--------|------|
| `-comment-mode` | `BH_COMMENT_MODE` | `off` | `off` / `auto-approve` / `moderation` |

---

## Dashboard 评论管理

Dashboard 新增 Comments 面板，提供以下功能：

### 功能
- **All 子面板**：分页浏览全部评论（含 IP / FP / UA / Status），支持按 Page 点击过滤
- **Pending 子面板**：待审核评论列表，支持通过 / 拒绝 / 删除
- **Commenters 子面板**：查看所有评论用户详情（email、注册 IP/UA/FP 等）
- **管理员回复**：以"作者"身份回复评论（textarea，支持 Markdown）
- **模式切换**：运行时在 off / auto-approve / moderation 间切换（内存级，不持久化）
- **顶部统计**：新增 ❤️ Article Likes 和 Commenters 卡片（支持时间筛选）
- **Tab 计数**：Comments 标签显示 `(all N | N pending | N users)`

### 管理员"作者"身份
- 数据库中 `commenter_id = 0` 表示管理员
- API 返回时自动填充 `{id: 0, nickname: "作者", avatar_seed: "admin"}`
- 前端 SDK 识别 `author.id === 0` 显示 Author badge
- 只能在 Dashboard 后台回复，不暴露给前端
- admin-reply 走 dashAuth 中间件

### UA 解析
所有表格（Visitors / Raw Views / Comments）的 UA 列统一使用 `parseUA()` 解析为 `OS · Browser` 格式（如 `Mac · Chrome 146`），hover 显示完整原始 UA。

---

## 文件结构

```
internal/model/comment.go      — 数据模型（Commenter, Comment, Reaction 等）
internal/store/store.go         — Store 接口定义
internal/store/sqlite.go        — SQLite 实现（表创建 + CRUD）
internal/service/comment.go     — 业务逻辑（发布、审核、反应、速率限制）
internal/handler/comment.go     — HTTP 处理器（路由、PoW 验证、admin auth）
internal/handler/dashboard.go   — Dashboard UI（含评论管理面板）
sdk/blog-helper.js              — 前端 SDK（评论 UI、Markdown、反应、侧边栏）
sdk/blog-helper.css             — SDK 样式（admin badge、pending notice 等）
sdk/lib/marked.min.js           — Markdown 解析库（本地，v15）
```
