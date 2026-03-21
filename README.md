# Memos 企业微信机器人

[![Docker Pulls](https://img.shields.io/badge/docker-镜像-blue)](https://hub.docker.com/r/huohen92/memos-wechat-bot)
[![License](https://img.shields.io/badge/license-GPLv3-blue.svg)](LICENSE)

将企业微信自建应用与 Memos 深度集成，支持文本自动保存、命令交互、动态菜单、多模式查询等功能。通过 Docker 一键部署，数据持久化存储。

---

## ✨ 功能特性

- ✅ **文本自动保存**：直接发送文本消息，自动添加标签并保存到 Memos。
- ✅ **完整命令系统**：支持 `/start`、`/list`、`/search`、`/today`、`/week` 等 20+ 命令。
- ✅ **智能导航**：列表模式与详细模式自由切换，支持翻页和上下条浏览。
- ✅ **动态菜单**：通过 `/bot_menu` 或底部菜单开关，可一键切换完整菜单与极简菜单。
- ✅ **多用户支持**：每个用户独立设置 Memos 令牌、默认可见性和标签。
- ✅ **时区自适应**：自动将 UTC 时间转换为本地时间（东八区）。
- ✅ **数据持久化**：用户配置存储在 `./data/config.json`，重启不丢失。
- ✅ **无菜单模式**：通过 `NO_MENU` 环境变量完全禁用动态菜单，适合纯文本交互。
- ✅ **日志级别控制**：支持 `error`、`warn`、`info`、`debug` 四种级别，灵活控制输出。

---

## 📦 前置要求

- Docker 及 Docker Compose
- 企业微信自建应用（已配置回调 URL）
- Memos 实例（v0.20+）

---

## 🚀 快速开始

### 1. 克隆仓库

```bash
git clone https://github.com/huohen92/memos-wechat-bot.git
cd memos-wechat-bot
```

### 2. 复制配置文件并修改

```bash
cp docker-compose.yml.example docker-compose.yml
```

编辑 `docker-compose.yml`，填写你的企业微信和 Memos 配置。

### 3. 启动容器

```bash
docker-compose up -d
```

### 4. 在企业微信中测试

向自建应用发送以下命令初始化：

```text
/start <你的Memos令牌>
```

- 发送任意文本，机器人自动保存到 Memos
- 发送 `/help` 查看全部命令

---

### 方式 A：使用 Docker Compose（推荐）

将以下内容保存为 `docker-compose.yml`（或参考 `docker-compose.yml.example` 进行修改），然后执行 `docker-compose up -d`：

```yaml
version: '3.3'

services:
  memos-wechat-bot:
    build: .
    container_name: memos-wechat-bot
    restart: unless-stopped
    ports:
      - "6330:3000"          # 宿主机端口映射，可根据需要修改左侧端口
    volumes:
      - ./data:/data          # 持久化目录，存放用户配置（令牌、可见性等）
    environment:
      # -------------------- 企业微信应用配置（必须）--------------------
      - WECOM_CORP_ID=your_corp_id          # 企业微信企业ID
      - WECOM_AGENT_ID=your_agent_id        # 自建应用AgentId
      - WECOM_SECRET=your_secret            # 自建应用Secret
      - WECOM_TOKEN=your_token              # 回调配置的Token（需与企业微信后台一致）
      - WECOM_ENCODING_AES_KEY=your_encoding_aes_key  # 回调配置的EncodingAESKey（43位）

      # -------------------- Memos 配置（必须）--------------------
      - MEMOS_URL=http://your-memos-ip:5230/api/v1/memos   # Memos API地址
      - MEMOS_WEB_URL=http://your-memos-ip:5230            # Memos 网页地址（用于生成分享链接）

      # -------------------- 可选配置（已标注默认值）--------------------
      # - PROXY_URL=http://your-proxy:80       # 企业微信 API 代理地址（默认直连官方API）
      # - NO_MENU=false                       # 是否禁用动态菜单（默认 false）
      # - LOG_LEVEL=info                      # 日志级别：error/warn/info/debug（默认 info）
      # - WECOM_TOUSER=@all                  # 主动发送消息的默认接收者（默认 @all）
      # - MEMOS_DEFAULT_TAG=#企业微信机器人   # 保存笔记时默认添加的标签（默认 #企业微信机器人）
      # - MEMOS_VISIBILITY=PRIVATE           # 新用户默认可见性（默认 PRIVATE，可选 PROTECTED/PUBLIC）
```

### 方式 B：使用 Docker run

如果你不想使用 Compose，可以用下面两步完成同样的部署。

1）先构建镜像（对应 `build: .`）：

```bash
docker build -t memos-wechat-bot .
```

2）运行容器（对应 `ports/volumes/environment/restart`）：

```bash
docker run -d   --name memos-wechat-bot   --restart unless-stopped   -p 6330:3000   -v "$(pwd)/data:/data"   -e WECOM_CORP_ID=your_corp_id   -e WECOM_AGENT_ID=your_agent_id   -e WECOM_SECRET=your_secret   -e WECOM_TOKEN=your_token   -e WECOM_ENCODING_AES_KEY=your_encoding_aes_key   -e MEMOS_URL=http://your-memos-ip:5230/api/v1/memos   -e MEMOS_WEB_URL=http://your-memos-ip:5230   memos-wechat-bot
```

> 可选配置同理用 `-e` 追加，例如：`-e LOG_LEVEL=debug`、`-e NO_MENU=true`。

---

## 🧩 企业微信自建应用回调配置示例

在企业微信管理后台为**自建应用**配置「接收消息服务器」时，可按如下示例填写：

- **URL**：`http://ip:6330/callback`
  - 将 `ip` 替换为你的服务器公网 IP 或可被企业微信访问到的域名
  - 端口 `6330` 需与部署时对外暴露端口一致（示例：`-p 6330:3000`）

同时你需要在企业微信侧设置：

- **Token**：与环境变量 `WECOM_TOKEN` 保持一致
- **EncodingAESKey**：与环境变量 `WECOM_ENCODING_AES_KEY` 保持一致（43 位）

> 提示：企业微信服务器需要能访问该 URL（通常要求公网可达）。若后台要求使用 HTTPS，请将 URL 改为 `https://你的域名/callback` 并配置好证书/反向代理。

---

## ⚙️ 环境变量说明

| 变量名 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| WECOM_CORP_ID | ✅ | 无 | 企业微信企业ID |
| WECOM_AGENT_ID | ✅ | 无 | 自建应用AgentId |
| WECOM_SECRET | ✅ | 无 | 自建应用Secret |
| WECOM_TOKEN | ✅ | 无 | 回调配置的Token |
| WECOM_ENCODING_AES_KEY | ✅ | 无 | 回调配置的EncodingAESKey（43位） |
| MEMOS_URL | ✅ | 无 | Memos API地址，例如 `http://192.168.1.100:5230/api/v1/memos` |
| MEMOS_WEB_URL | ✅ | 无 | Memos 网页地址，例如 `http://192.168.1.100:5230` |
| PROXY_URL | ❌ | 无 | 企业微信API代理地址（如无法直连时使用） |
| NO_MENU | ❌ | false | 是否禁用动态菜单（true=禁用） |
| LOG_LEVEL | ❌ | info | 日志级别：error、warn、info、debug |
| WECOM_TOUSER | ❌ | @all | 主动发送消息的默认接收者 |
| MEMOS_DEFAULT_TAG | ❌ | #企业微信机器人 | 保存笔记时默认添加的标签 |
| MEMOS_VISIBILITY | ❌ | PRIVATE | 新用户默认可见性（PRIVATE/PROTECTED/PUBLIC） |

---

## 📋 命令列表

### 基础命令

| 命令 | 说明 |
|---|---|
| `/start <令牌>` | 设置你的 Memos 令牌 |
| `/set_visibility <私有/工作区/公开>` | 修改默认可见性 |
| `/get_visibility` | 查询当前默认可见性 |
| `/set_tag <新标签>` | 设置默认标签 |
| `/bot_version` | 查看机器人版本 |
| `/mode` | 查询当前模式 |
| `/exit` | 切换到日常模式 |
| `/bot_menu` | 开启动态菜单（再次执行关闭） |
| `/help` | 显示基础帮助 |
| `/help_more` | 显示完整帮助 |

### 查询类

| 命令 | 说明 |
|---|---|
| `/list [页码]` | 列出最近的备忘录 |
| `/search <关键词> [页码]` | 搜索包含关键词的备忘录 |
| `/search_all <关键词> [页码]` | 显示所有匹配备忘录的完整内容 |
| `/today` | 查看今日备忘录 |
| `/week` | 查看本周备忘录 |
| `/filter <CEL表达式>` | 高级过滤 |

### 智能导航

| 命令 | 说明 |
|---|---|
| `/view <序号>` | 查看指定序号的完整内容，进入详细模式 |
| `/up` | 列表模式下翻上一页，详细模式下查看上一条 |
| `/down` | 列表模式下翻下一页，详细模式下查看下一条 |
| `/id` | 返回当前笔记的 ID（仅详细模式） |
| `/pure` | 返回简洁的“创建时间+笔记原文”（仅详细模式） |

### 直接操作

| 命令 | 说明 |
|---|---|
| `/get <memoId>` | 通过 ID 获取单条备忘录 |
| `/update <memoId> <新内容>` | 更新备忘录 |
| `/delete <memoId>` | 删除备忘录 |
| `/pin <memoId>` | 切换置顶状态 |
| `/visibility <memoId> <PUBLIC/PRIVATE>` | 修改可见性 |

### 其他

| 命令 | 说明 |
|---|---|
| `/stats` | 统计备忘录总数（最多1000条） |
| `/tags` | 列出最近50条笔记中的常用标签 |
| `/random` | 随机返回一条备忘录 |

---

## 🛠️ 开发与构建

### 手动构建镜像

```bash
docker build -t memos-wechat-bot .
```

### 运行容器

```bash
docker run -d   --name memos-wechat-bot   -p 6330:3000   -v $(pwd)/data:/data   --env-file .env   memos-wechat-bot
```

---

## 📁 目录结构

```text
.
├── app.js                  # 主程序
├── Dockerfile              # Docker 构建文件
├── package.json            # 依赖声明
├── docker-compose.yml.example  # 配置示例
├── .gitignore              # Git 忽略规则
├── LICENSE                 # 开源许可证
└── README.md               # 本文件
```

---

## 🙏 致谢（Acknowledgements）

感谢以下项目与工具，为本项目的实现与使用体验提供了重要支持：

- **Memos**  
  一个简洁、高效的自托管备忘录系统，为个人知识记录与管理提供了优秀的基础能力。

- **DeepSeek AI**  
  本项目的核心代码逻辑由 AI 协助并完成，实现了从需求梳理到完整功能代码输出的全过程支持。

---

## 📌 备注（Notes）

- **本项目由deepseekAI完整代码编写**  
  包括整体架构设计、核心业务逻辑实现以及功能细节完善，人工仅参与需求描述与使用场景确认。

- **项目编写目的**  
  编写此项目只是便于自己使用memos，用于日常记录、整理与快速访问个人备忘信息。

- **使用性质说明**  
  本项目为个人使用与实践性质，不以商业化或通用化产品为目标，如有不足之处欢迎交流与改进。

---

## 📖 免责声明（Disclaimer）

本项目为个人使用与学习性质项目，不保证在所有环境下的稳定性、兼容性或持续维护能力。  
因使用本项目所产生的任何数据、配置或安全相关问题，请使用者自行评估并承担相应责任。

---

## 🤝 贡献

欢迎提交 Issue 和 Pull Request。请确保代码风格一致，并更新相应文档。

---

## 📄 许可证

本程序是自由软件，您可以遵照自由软件基金会发布的 **GNU 通用公共许可证 (GPL) 第 3 版** 或（您选择的）任何更高版本来重新发布和/或修改它。

本程序发布的目的是希望它能对您有用，但 **不提供任何形式的担保**，包括但不限于适销性及适合特定用途的隐含担保。详情请参阅 GNU 通用公共许可证。

您应该已经收到了一份 GNU 通用公共许可证的副本。如果没有，请访问 <https://www.gnu.org/licenses/>。

**版权 (C) 2026 huohen92**

---

## 👤 作者

huohen92 · GitHub
