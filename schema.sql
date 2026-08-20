-- 客户运营管理平台 数据库表结构
-- SQLite
-- 全站客户标识 = oem（对齐 Doris tab1.oem）

-- 用户表（内部PQM账号，用于用户切换下拉）
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    department TEXT,
    position TEXT,
    phone TEXT,
    email TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 客户基本信息（主键=oem，档案字段本地维护，播种时留空）
CREATE TABLE IF NOT EXISTS customers (
    oem TEXT PRIMARY KEY,            -- tab1.oem 客户英文简称（主键）
    oem_ch TEXT,                    -- tab1.oem_ch 客户中文名
    name_cn TEXT,                   -- 客户中文名称（可编辑，默认同 oem_ch）
    name_en TEXT,                   -- 客户英文名
    address TEXT,                   -- 地址
    level TEXT DEFAULT '一般',      -- 客户等级：重要/一般
    cooperation_scope TEXT,         -- 合作界面（除安全问题）
    relationship_status TEXT,       -- 客户关系状态
    market_quality TEXT,            -- 市场质量表现
    algorithm_capability TEXT,      -- 算法能力
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 关键人矩阵（外部客户关键人 + 内部PQM负责人，type区分）
CREATE TABLE IF NOT EXISTS key_persons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    oem TEXT NOT NULL,              -- 客户 oem
    type TEXT NOT NULL,             -- 'external' 外部客户关键人 / 'internal' 内部PQM负责人
    name TEXT NOT NULL,
    department TEXT,
    position TEXT,
    style TEXT,                     -- 风格
    phone TEXT,
    email TEXT
);

-- 会议纪要
CREATE TABLE IF NOT EXISTS meetings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    oem TEXT NOT NULL,              -- 客户 oem
    title TEXT NOT NULL,            -- 会议名称
    purpose TEXT,                   -- 会议目的
    meeting_date DATE NOT NULL,
    participants_external TEXT,     -- 外部参与人员
    participants_internal TEXT,     -- 内部参与人员
    material_path TEXT,             -- 会议材料文档路径
    material_name TEXT,             -- 会议材料文档名
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 会议共识（可增行）
CREATE TABLE IF NOT EXISTS meeting_consensus (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id)
);

-- 会议关键任务
CREATE TABLE IF NOT EXISTS meeting_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id INTEGER NOT NULL,
    customer_demand TEXT,           -- 客户诉求
    task_description TEXT NOT NULL, -- 任务描述
    owner TEXT,                     -- 负责人（内部人员）
    planned_date DATE,             -- 计划完成日期
    status TEXT DEFAULT '待处理',   -- 当前状态：待处理/进行中/已完成/已逾期
    actual_date DATE,              -- 实际完成日期
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id)
);

-- 客户拜访计划
CREATE TABLE IF NOT EXISTS visit_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    oem TEXT NOT NULL,              -- 客户 oem
    subject TEXT,                   -- 拜访主题
    contact_person TEXT,            -- 对接人员
    contact_phone TEXT,             -- 联系方式
    contact_email TEXT,             -- 邮箱
    visit_content TEXT,             -- 拜访内容
    visit_date DATE,               -- 拜访日期
    is_completed INTEGER DEFAULT 0, -- 0=计划/1=已完成
    summary TEXT,                   -- 拜访总结（已完成时填写）
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 预警闭环管理（页面4本地维护）
CREATE TABLE IF NOT EXISTS warnings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    oem TEXT NOT NULL,              -- 客户 oem
    capacity_ah REAL,               -- 电芯容量Ah（原 project 关联，改为直接存）
    risk_type TEXT,                 -- 风险类型
    failure_mode TEXT NOT NULL,     -- 失效模式
    warning_count INTEGER DEFAULT 0,-- 预警数量
    closure_status TEXT DEFAULT '未闭环', -- 闭环状态：已闭环/未闭环
    unclosed_reason TEXT,           -- 未闭环原因
    dispatch_logic TEXT,            -- 外发阈值逻辑
    dispatched_count INTEGER DEFAULT 0, -- 已外发处置数量
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 服务阶段性总结
CREATE TABLE IF NOT EXISTS stage_summary (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    oem TEXT NOT NULL,              -- 客户 oem
    summary_date DATE NOT NULL,
    failure_mode TEXT NOT NULL,     -- 失效模式
    dispatch_count INTEGER DEFAULT 0, -- 预警外发数量
    reduced_breakdown INTEGER DEFAULT 0, -- 预计降低抛锚数量
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 客户问题知识库 Q&A
CREATE TABLE IF NOT EXISTS qa (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,         -- 问题类别
    question TEXT NOT NULL,         -- 问题描述
    answer TEXT,                    -- 对客界面说法
    maintainer TEXT,                -- 维护人（根据账号自动带出）
    keywords TEXT DEFAULT '',       -- 搜索关键词（逗号分隔）
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 知识库文本片段（客户运营组知识库，供 LLM RAG 使用）
CREATE TABLE IF NOT EXISTS knowledge_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_type TEXT NOT NULL,       -- 'qa' / 'xlsx' / 'html' / 'txt' / 'pdf' / 'docx' / 'manual'
    source_file TEXT,                -- 来源文件名
    title TEXT,                      -- 标题
    content TEXT NOT NULL,           -- 文本内容
    keywords TEXT,                   -- 搜索关键词
    category TEXT,                   -- 分类
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 文档（客户协议 + 内部知识库文档统一管理，客户标识=oem）
CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    oem TEXT,                       -- 客户 oem（NULL表示内部通用文档）
    scope TEXT NOT NULL,            -- 'customer_agreement'客户协议 / 'internal'内部标准材料
    business_type TEXT,             -- 业务类型（已弃用，保留列）
    doc_type TEXT,                  -- 文档类型（数据委托处理协议/数据转发费用协议/阳光协议）
    title TEXT NOT NULL,
    file_path TEXT,                 -- 存储路径
    file_name TEXT,                 -- 原始文件名
    capacity_ah REAL,              -- 关联的容量Ah（可选标签）
    upload_date DATE DEFAULT CURRENT_DATE,
    uploader TEXT
);

-- OEM 映射表（tab1.oem 客档表 ↔ tab2.cust_grp_name 出货表，本地维护，一对多）
CREATE TABLE IF NOT EXISTS oem_cust_mapping (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    oem TEXT NOT NULL,              -- tab1.oem 客户英文简称
    oem_ch TEXT,                    -- tab1.oem_ch 客户中文名（冗余便于展示）
    cust_grp_name TEXT NOT NULL,    -- tab2.cust_grp_name 出货表客户集团名
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 预警逻辑（失效模式的人工编辑列，与 Doris tab3 聚合结果左连接）
CREATE TABLE IF NOT EXISTS warning_logic (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    oem TEXT NOT NULL,              -- 客户 oem
    cell_cap TEXT,                  -- 电芯容量
    fault_type TEXT NOT NULL,       -- 预警模式（对齐 tab3.fault_type）
    logic_text TEXT,                -- 人工填写的预警逻辑说明
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 项目质保信息（从 Doris 初始化，可人工编辑覆盖）
CREATE TABLE IF NOT EXISTS warranty_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    oem TEXT NOT NULL,
    cell_cap TEXT NOT NULL,
    vehicle_model TEXT NOT NULL DEFAULT '',   -- 车型，空串表示该oem+cell_cap通用
    pn TEXT,                                  -- 来源PN号
    -- 乘用车质保规格
    passenger_years INTEGER,       -- 质保年限（年）
    passenger_mileage INTEGER,     -- 质保里程（km）
    passenger_soh INTEGER,         -- 质保容量 SOH（%）
    -- 运营车质保规格
    commercial_years INTEGER,
    commercial_mileage INTEGER,
    commercial_soh INTEGER,
    source TEXT DEFAULT 'doris',   -- 'doris' 初始化来源 | 'manual' 人工编辑
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(oem, cell_cap, vehicle_model)
);
