/**
 * 服务端错误信封 → 可读错误描述
 *
 * 游戏服务端的失败响应**不带 cmd、不带 body**，形如：
 *   { seq, ack, time, resp, code, error }
 * 其中 `code` 是数字错误码、`error` 是服务端自带的中文文案。
 *
 * 抽成独立模块的原因：`xyzwWebSocket.js` 依赖 `@/` 别名，node 测试无法直接导入，
 * 而错误语义（尤其幻塔助力的两个码）需要被回归测试锁住。
 */

/**
 * 错误码映射表
 * 用于将服务器返回的错误码转换为可读的错误描述
 */
export const serverErrorCodeMap = {
  700010: "任务未达成完成条件",
  1400010: "没有购买该月卡,不能领取每日奖励",
  12000116: "今日已领取免费奖励",
  3300060: "扫荡条件不满足",
  1300050: "请修改您的采购次数",
  200020: "出了点小问题，请尝试重启游戏解决～",
  200160: "模块未开启",
  7500140: "请先输入密码",
  7500100: "密码输入错误",
  7500120: "密码输入错误次数已达上限",
  200400: "操作太快，请稍后再试",
  200760: "您当前看到的界面已发生变化，请重新登录",
  2300190: "今天已经签到过了",
  2300370: "俱乐部商品购买数量超出上限",
  400000: "物品不存在",
  1500020: "能量不足",
  2300070: "未加入俱乐部",
  3500020: "没有可领取的奖励",
  400190: "没有可领取的签到奖励",
  1000020: "今天已经领取过奖励了",
  3300050: "购买数量超出限制",
  700020: "已经领取过这个任务",
  12400000: "挂机奖励领取过于频繁",
  2300250: "俱乐部BOSS今日攻打次数已用完",
  400010: "物品数量不足",
  7900023: "已达到使用次数上限",
  12300040: "没有空格子了",
  12300080: "未达到解锁条件",
  200330: "无效的ID",
  1500040: "上座塔的奖励未领取",
  1500010: "已经全部通关",
  1100010: "招募周奖励本期已领取",
  // 幻塔（EvoTower）助力码：发起方已用过助力机会 / 被助力方已满 3 次
  12200090: "对方已到最大助力人数",
  12200100: "本次活动已参与助力，无法助力其他伙伴",
};

/**
 * 解析错误描述。
 * 优先级：本地错误码表（人工校对过、文案稳定）→ 服务端自带 error 文案 → hint → 兜底。
 * 服务端 error 文案放在本地表之后，保证既有文案不被服务端版本变动影响。
 */
export function describeServerError(packet = {}) {
  return (
    serverErrorCodeMap[packet.code] ||
    packet.error ||
    packet.hint ||
    "未知错误"
  );
}

/**
 * 构造与既有格式一致的错误对象：`服务器错误: <code> - <desc>`
 * 同时把 code / hint / error 挂到错误对象上，便于结构化判定（见 helperTaskRunner 的 getErrorDetails）。
 */
export function createServerError(packet = {}) {
  const error = new Error(
    `服务器错误: ${packet.code} - ${describeServerError(packet)}`,
  );
  error.code = packet.code;
  if (packet.hint !== undefined) error.hint = packet.hint;
  if (packet.error !== undefined) error.error = packet.error;
  return error;
}

export default { serverErrorCodeMap, describeServerError, createServerError };
