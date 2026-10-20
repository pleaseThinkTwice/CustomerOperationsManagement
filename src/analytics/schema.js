'use strict';
// 分析库（公司数仓 / test 库）需要提供的表。平台只读这些表，不写。
// 逻辑表名 → 实际表名可通过环境变量 ANALYTICS_TABLE_<逻辑表名> 或统一前缀 ANALYTICS_TABLE_PREFIX 覆盖。
// 本地 demo 模式下用同样结构在 sqlite 里生成演示数据，所以这里的字段就是公司侧需要准备的字段。
const c = (type, comment) => ({ type, comment });

const tables = {
  dim_oem: {
    comment: '客户维表：数仓客户编码与名称、客户组',
    cols: {
      oem: c('text', '客户编码（与平台 customers.oem 一致，如 XMS）'),
      oem_ch: c('text', '客户中文名'),
      cust_grp_name: c('text', '数仓客户组名称（OEM 映射页使用）'),
    },
  },
  dim_cell_product: {
    comment: '电芯产品/项目维表：一个客户 × 容量 × 车型 一行',
    cols: {
      oem: c('text', '客户编码'),
      cell_cap: c('text', '电芯容量 Ah，如 153'),
      cell_structure: c('text', '成组方式，如 1P204S'),
      pn_system: c('text', '电芯 PN / 项目号'),
      cell_type: c('text', '电芯体系：LFP / NCM / AB 等'),
      vehicle_model: c('text', '车型'),
      series_count: c('int', '串数 S'),
      sop_date: c('date', 'SOP 日期'),
      plant: c('text', '生产基地'),
    },
  },
  dws_shipment: {
    comment: '出货明细（按批次）',
    cols: {
      oem: c('text', '客户编码'),
      cell_cap: c('text', '电芯容量 Ah'),
      vehicle_model: c('text', '车型'),
      ship_level: c('text', '出货层级：cell 电芯 | module 模组 | pack 系统'),
      qty: c('int', '数量'),
      ship_date: c('date', '出货日期'),
      pn: c('text', '出货 PN（电芯层级为电芯 PN，用于 PN 追溯）'),
      batch_no: c('text', '电芯生产批次'),
      plant: c('text', '生产基地'),
    },
  },
  dwd_vehicle_access: {
    comment: '车辆接入台账：每辆已接入监控平台的车（Pack）一行',
    cols: {
      vin: c('text', '车架号'),
      deviceid: c('text', '终端/BMS 设备号'),
      oem: c('text', '客户编码'),
      cell_cap: c('text', '电芯容量 Ah'),
      cell_structure: c('text', '成组方式'),
      vehicle_model: c('text', '车型'),
      pack_pn: c('text', 'Pack PN（与质保条款 PN 对应）'),
      pack_id: c('text', 'Pack 唯一码（为空计入 pack_id 缺失率）'),
      usage_type: c('text', '用途：passenger 乘用 | commercial 营运'),
      access_date: c('date', '首次接入日期'),
      last_online_date: c('date', '最近一次上线日期'),
      warranty_start_date: c('date', '质保起算日（开票/上牌日）'),
      mileage_km: c('real', '累计里程 km'),
      soh: c('real', '最新 SOH %'),
      cycle_count: c('int', '累计循环次数'),
    },
  },
  dwd_warning: {
    comment: '电池预警明细：算法触发的每条预警一行（外发=推送给客户）',
    cols: {
      warning_id: c('text', '预警唯一编号'),
      vin: c('text', '车架号'),
      oem: c('text', '客户编码'),
      cell_cap: c('text', '电芯容量 Ah'),
      vehicle_model: c('text', '车型'),
      fault_type: c('text', '失效模式/故障类型，如 绝缘故障、压差报警'),
      warning_time: c('datetime', '预警触发时间'),
      is_outgoing: c('int', '是否外发给客户 1/0'),
      is_closed: c('int', '是否闭环 1/0'),
      close_time: c('datetime', '闭环时间'),
      is_complaint: c('int', '是否形成客诉 1/0'),
      batch_no: c('text', '电芯批次'),
      pack_no: c('text', 'Pack 编号'),
      cell_pos: c('text', '电芯位置'),
      soh: c('real', '预警时 SOH %'),
    },
  },
  dwd_work_order: {
    comment: '售后工单：预警工单 / 批改工单 / 现场工单（现场工单 = 失效车辆口径）',
    cols: {
      wo_id: c('text', '工单号'),
      wo_type: c('text', '工单类型：预警 | 批改 | 现场'),
      vin: c('text', '车架号'),
      oem: c('text', '客户编码'),
      cell_cap: c('text', '电芯容量 Ah'),
      vehicle_model: c('text', '车型'),
      pn: c('text', '电芯 PN'),
      fault_type: c('text', '失效模式'),
      create_time: c('datetime', '开单时间'),
      close_time: c('datetime', '关单时间'),
      plant: c('text', '电芯生产基地'),
    },
  },
  dwd_mileage_adjust: {
    comment: '疑似调表记录：同车里程回退/跳变检测结果',
    cols: {
      vin: c('text', '车架号'),
      oem: c('text', '客户编码'),
      cell_cap: c('text', '电芯容量 Ah'),
      check_date: c('date', '检测日期'),
      mileage_diff_km: c('real', '里程差（万公里口径前端换算）'),
    },
  },
  dim_warranty_policy: {
    comment: '质保政策（用于初始化平台 warranty_settings）',
    cols: {
      oem: c('text', '客户编码'),
      cell_cap: c('text', '电芯容量 Ah'),
      vehicle_model: c('text', '车型'),
      pn: c('text', 'PN'),
      passenger_years: c('real', '乘用质保年限'),
      passenger_mileage: c('real', '乘用质保里程 km'),
      passenger_soh: c('real', '乘用质保 SOH 下限 %'),
      commercial_years: c('real', '营运质保年限'),
      commercial_mileage: c('real', '营运质保里程 km'),
      commercial_soh: c('real', '营运质保 SOH 下限 %'),
    },
  },
};

module.exports = { tables };
