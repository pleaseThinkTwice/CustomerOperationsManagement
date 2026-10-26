# 小规模数据问答工作台（无 RAG）

这是一个**独立项目**，不依赖 `CustomerOperationsManagement`，也不运行 SQLBot。少量表结构和业务知识在每次提问时**完整放入模型的 system prompt**：没有向量数据库、embedding、相似度检索或按问题挑选知识片段。一个页面提供文档问答、Text-to-SQL 和参数化常用查询。

![智能问答界面](assets/chat.png)

[常用查询界面](assets/preview.png) · [知识说明界面](assets/knowledge.png)

## 启动

需要 Python 3.10+；首次安装依赖需要网络。不需要 Docker。

```bash
python bootstrap.py
python -m venv .venv
# macOS/Linux: source .venv/bin/activate
# Windows PowerShell: .venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python app.py
```

可在另一个终端运行 `.venv/bin/python -m unittest discover -s tests` 验证三条模型响应路径；Windows 请用 `.venv\Scripts\python`。

打开 **http://127.0.0.1:8000/saved/**。不配置模型时，“常用查询”可用合成订单数据演示；“智能问答”会明确提示模型未配置。填写本地 `.env` 中的 `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL` 后重启 `python app.py`，即可使用 OpenAI 兼容模型接口。API Key 只保存在本机 `.env`，不提交到 Git。

## 到公司后只需改三处

1. `.env`：设置模型信息、只读 `QUERY_DATABASE_URL`，以及允许模型查询的 `PROMPT_TABLES`（逗号分隔，最多 20 张表）。支持 SQLite、PostgreSQL、MySQL。连接串中的特殊字符需 URL 编码。数据库账号必须在数据库侧只读。
2. `knowledge/*.md`：修改表介绍、字段口径、业务术语、常见问答和已验证的 SQL 示例。无需复制进别的系统；每次新问题都会直接读取这些文件。当前总上下文超过 3 万字符时会明确报错，不会悄悄截断。
3. `queries/*.json`：把“常用查询”模板改成公司已确认的 SQL。用户只填参数，系统使用绑定变量、只读连接和结果行数限制。默认查询自动选择上一个完整月。

`PROMPT_TABLES` 对应的真实字段名与类型在每次提问时从数据库读取，再与 `knowledge/表与字段说明.md` 等文件一起放入 prompt。这样表结构变更能及时反映，同时业务含义仍由人维护。[知识文件说明](knowledge/README.md)。

## 实际处理流程

用户在“智能问答”提问 → 系统将**全部允许表的 schema + 四份知识文件**放进 prompt → 模型选择直接回答、追问，或生成只读 SQL → SQL 经 `sqlglot` 解析，只允许单条查询和白名单表 → 使用只读连接执行，最多返回 500 行；超过时页面会提示截断。问答内容没有检索步骤；“常用查询”完全不调用模型，重复执行已核对模板。目前聊天生成的 SQL 还不能一键转成常用查询，需要把审核过的 SQL 写入 `queries/*.json`。

当前没有公司真实数据库或已配置的模型，因此仓库只提供合成数据和模型配置入口。已通过模拟模型验证问答、追问、SQL 路径；真实模型的业务准确率仍需用你们自己的问题和正确结果验证。

## 文件

| 路径 | 用途 |
| --- | --- |
| `app.py`、`public/index.html` | 一个问答与常用查询页面 |
| `prompt_engine.py` | 全量 prompt、模型调用、SQL AST 校验 |
| `query_runner.py` | 数据库只读执行、参数绑定、超时和行数限制 |
| `knowledge/*.md` | 可直接编辑的业务知识 |
| `queries/*.json` | 已核对的常用查询 |
| `bootstrap.py` | 生成本地配置与合成订单数据 |

默认只监听 `127.0.0.1`，适合单机试用。若要供公司多人访问，需要接入公司的登录、权限、审计和密钥管理后再开放网络端口。模型会接收这些表结构和业务知识；使用外部模型前需选择公司允许发送此类信息的服务。
