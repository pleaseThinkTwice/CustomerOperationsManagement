# 客户运营平台 v2 · QA + NL2SQL

面向新能源汽车 B 端客户运营的轻量平台，聚焦两大能力：

- **QA 智能问答**：理解用户问题，基于知识库文档（pdf / docx / pptx / xlsx / html / txt）作答。库内标准答案优先直答（零幻觉），否则把整库作为上下文交给 LLM（配合 prompt cache，文档少时比 RAG 更省更全）。
- **NL2SQL 智能查数**：用自然语言查询 Doris（只读），自动生成 SQL、安全校验、执行，并整理成「分析报告 + 数据表」。表结构由外部 `schema_config.yaml` 统一维护，换表零改代码。

技术栈：Python 3.13 + Flask + SQLite + 外部 LLM 网关（OpenAI 兼容）+ Doris（MySQL 协议只读）。

---

## 模块地图

| 文件 | 职责 |
|---|---|
| `app.py` | Flask 主程序，全部 `/api/*` 路由 + 前端入口 |
| `config.py` | 配置（环境变量 / `config.local.py` 覆盖，凭据不进 Git） |
| `db.py` / `schema.sql` | SQLite 初始化与完整 v2 表结构（当前仅 QA/知识库/文档相关表被业务逻辑使用） |
| `seed.py` | 种子数据（默认用户 + 示例 Q&A） |
| `kb_parser.py` | 文档解析（pdf/docx/pptx/xlsx/html/txt） |
| `kb_router.py` | QA 路由：库内直答 → 整库 prompt LLM 兜底 |
| `llm_client.py` | LLM 客户端（OpenAI 兼容网关，稳定前缀利于缓存） |
| `nl2sql.py` | NL2SQL：生成 SQL → 安全校验 → 执行 → 报告 |
| `doris_client.py` | Doris 只读查询（pymysql） |
| `schema_config.yaml` | **NL2SQL 表结构配置（堡垒机统一维护）** |
| `static/` `templates/` | 前端（两 Tab：QA / NL2SQL） |
| `tests/smoke_test.py` | 离线冒烟测试 |

---

## Windows 堡垒机部署

### 1. 建虚拟环境 + 装依赖
```bat
cd /d 项目目录
python -m venv .venv
.venv\Scripts\activate.bat
pip install -U pip
pip install -r requirements.txt
```

### 2. 初始化数据库 + 种子
```bat
.venv\Scripts\python.exe db.py
.venv\Scripts\python.exe seed.py
```

### 3. 配置凭据（二选一）
- **方式 A**：直接改 `start.bat` 里的环境变量（`LLM_*` / `DORIS_*`）。
- **方式 B**：复制 `config.local.py.example` 为 `config.local.py` 填真实凭据（已被 `.gitignore` 忽略，不进 Git）。

### 4. 配置可查询的表（NL2SQL）
编辑 `schema_config.yaml`，把堡垒机真实库表名与字段填进去。**新增/修改表只改这个文件，代码无需改动。**

### 5. 启动
```bat
start.bat            :: 前台（调试）
start_flask.bat      :: 后台（日志 flask_out.log / flask_err.log）
```
默认自动探测端口 5020–5029；可 `set APP_PORT=5050` 指定。启动后访问控制台打印的地址。

---

## 关键环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `LLM_ENABLED` | 是否启用 LLM（0 时离线可用，QA 仅库内直答） | 0 |
| `LLM_API_KEY` / `LLM_API_URL` / `LLM_MODEL` | LLM 网关 | 见 config.py |
| `DORIS_ENABLED` / `DORIS_HOST` / `DORIS_PORT` / `DORIS_USER` / `DORIS_PASS` | Doris 只读 | 见 config.py |
| `SCHEMA_CONFIG_PATH` | schema 配置文件路径 | `schema_config.yaml` |
| `NL2SQL_MAX_LIMIT` | 自动补的 LIMIT 上限 | 1000 |
| `APP_PORT` / `FLASK_DEBUG` | 端口 / 调试 | 自动 / 0 |

---

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` `/api/status` | 健康 / 状态（含 LLM、Doris 配置情况） |
| POST | `/api/qa/search` | QA 核心：`{query}` → `{answer, mode, ...}` |
| GET/POST/PUT/DELETE | `/api/qa[/<id>]` | Q&A 标准库 CRUD |
| GET | `/api/knowledge` | 知识片段列表 |
| POST | `/api/knowledge/upload` | 上传文档（字段 `file`）→ 解析入库 |
| POST | `/api/knowledge/sync` | 重新同步 qa 表 + 知识库文件夹 |
| POST | `/api/nl2sql/query` | NL2SQL：`{query}` → `{sql, columns, rows, report, ...}` |
| GET | `/api/nl2sql/schema` | 查看已登记表结构 |
| GET | `/api/nl2sql/ping` | Doris 连通性自检 |

---

## 安全说明（NL2SQL）

生成的 SQL 经过强制校验：仅允许**单条 `SELECT`/`WITH`**、拦截一切写操作与危险关键字、表名必须在 `schema_config.yaml` 白名单内、自动补 `LIMIT`；执行使用 Doris **只读**账号，双重保险。

## 测试
```bat
.venv\Scripts\python.exe tests\smoke_test.py   :: 离线，不依赖 LLM/Doris
```
