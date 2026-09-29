/**
 * 金鱼「收尾」纯逻辑（阶段 C 设计产物，2026-09-28）
 *
 * ⚠️ 本模块只做「解析与推导」，不做任何网络请求，可被 node --test 直接导入。
 *
 * 需求来源：`local-data/goldenfish/a_brief_introduction.txt`（第 27-31、40、78-87 行）
 *
 * ## 零、收尾流程（master 2026-09-29 复述确认）
 *
 *   1. **宝箱和招募全部做满**（消耗阶段只做到 99000 分 / 3900 次留余量，
 *      最后一天用满值目标 100000 / 4000 再跑一次消耗任务）；
 *   2. **鱼竿和金砖维持当前策略**（鱼竿先补到 1300 下限、不够再往 1750；
 *      金砖 38 万观察点 → 46 万收敛线，2 轮金砖换 1 轮钓鱼）；
 *   3. ⚠️ **起点未必是 1140** —— 消耗阶段是「有多少做多少」，若 9 月因鱼竿
 *      库存不足只做到 1000，收尾就按 **1000** 起算缺口（不是假设 1140/1300）。
 *      本模块全部以 `progressBySlot` 的**实际值**为起点：`fd = progress[3]`、
 *      `fishRoom = max(0, fishCap − fd)`、`rodsForFishCap` 随之浮动。
 *      例：起点 1000 补到 1300 需 270 根（ceil(300×0.9)），起点 1140 只需 144 根。
 *
 * ## 一、五类任务档位表（每任务 20 轮，每 5 轮一档）
 *
 *   | 任务 | 每轮消耗 | 每轮道具 | 轮数分布        | 全满累计 |
 *   | 招募 | 80/160/240/320          | 8/16/24/32        | 5,5,5,5     | 4000 次 |
 *   | 宝箱 | 2000/4000/6000/8000(分) | 4/8/12/16         | 5,5,5,5     | 100000 分 |
 *   | 钓鱼 | 25/50/75/100/125/150    | 4/8/12/16/20/24   | 3,3,4,4,3,3 | 1750 次 |
 *   | 罐子 | 3                       | 1                 | 20          | 60      |
 *   | 金砖 | 1/2/3/4（×10000）       | 3/6/9/12          | 5,5,5,5     | 50 单位 |
 *
 *   道具总计 = 400+200+280+20+150 = **1050**（与原文第 85 行「一般来说普通任务做完全部挡位，
 *   能有 1050 个道具」完全吻合 —— 这是本表正确的交叉验证）。
 *
 *   抓包实测进度反查（`task = {1:3685, 2:96530, 3:1140, 4:632, 5:20389}`）：
 *   招募 19 轮 / 宝箱 19 轮 / 钓鱼 15 轮 / 罐子 20 轮(满) / 金砖 2 轮，累计道具 746。
 *
 * ## 二、领奖（`activity_claimtaskreward`）
 *
 *   `missionId = (slot - 1) * 20 + round`（slot 1..5，round 1..20）
 *   实测：5 次连发 missionId = 1/21/41/61/81（= 五类任务的第 1 轮），
 *   返回的普通道具数 8/4/4/1/3 正好等于「每轮道具」列 ⇒ **按轮领取**。
 *   响应 `record[missionId] = 时间戳` ⇒ **已领轮次可直接读，不用试错**。
 *   ✅ master 2026-09-28 确认：服务端**不自动发奖**，一轮一领、20 轮要点 20 次
 *   ⇒ 逐轮补领是必须的（`planClaimSweep` 语义正确）。
 *
 * ## 三、开普通道具 → 特殊道具
 *
 *   原文第 85 行：金鱼要 **250 个特殊道具**，从普通道具里「1/4 概率，并伴有强制保底」产出；
 *   全做完约 1050 个普通道具，运气好 1000 个左右就能开出 250 个。
 *   旧期 statistics 佐证：`open:pack:guaranteed:5261 = 80`（开了 80 个）与
 *   `open:pack:guaranteed:reward:5262 = 21`（出了 21 个）→ 26.3%，略高于 25%。
 *
 *   🔴 master 2026-09-28 定口径（**有保底**）：
 *   ```
 *   特殊道具数 = 普通道具数 × 0.25 + bias     bias ∈ [-5, 5] 的整数，概率线性（峰在 0）
 *   ```
 *   ⇒ 不逐次抽样、**不建正态模型**（`normalRandom` 已删）—— 见 `openPacks` / `packBias`。
 *   ⚠️ 措辞：这里是**开普通道具（5287）**产出**特殊道具（5286）**，**不是开宝箱**。
 *   宝箱只产宝箱积分，对「拿金鱼」没有直接产出。
 *
 * ## 四、收尾补齐组合
 *
 *   原文第 87 行：差 n 个特殊道具 → 按 25% 估算再要 4n 个普通道具 →
 *   在「金砖消耗」与「钓鱼消耗」的剩余档位里挑**代价最小**的组合补出来。
 *   ⚠️ 两者量纲不同（金砖 vs 鱼竿）—— 但原文第 135 行已给出答案：
 *   金砖消耗就是**买 600/根的原价鱼竿**，所以一笔支出同时推进两个任务，
 *   权重就是**金砖支出本身**（`planRodPurchase` 的 `weight === goldSpend`）。
 */

// ------------------------------------------------------------------ 常量

/** 每任务轮数（实测 missionId 间距 = 20 ⇒ 每任务 20 轮） */
export const ROUNDS_PER_TASK = 20;

/** 金鱼活动 ID 的功能位（1 招募 / 2 宝箱 / 3 钓鱼 / 4 收罐子 / 5 金砖） */
export { GOLDENFISH_TASK_SLOTS, GOLDENFISH_TASK_NAMES } from "./goldenfishConsumePlan.js";

/** 金砖档位消耗的单位（原文「消耗量 1」= 10000 金砖；抓包 task.5=20389 与阈值 10000/20000 对得上） */
export const GOLDENFISH_GOLD_UNIT = 10000;

/**
 * 原价鱼竿单价（金砖）
 *
 * 原文第 135 行：「实施金砖消耗任务（**购买 600 一个的原价鱼竿**，用来凑满金砖消耗任务，
 * 如果上一步安排了钓鱼，那就要求购买数量同时满足钓鱼任务的需求和金砖任务的需求，
 * 否则只需要满足金砖任务的需求即可）」
 *
 * ⇒ **金砖消耗的手段就是买鱼竿**，一笔支出同时推进「金砖消耗」与「钓鱼消耗」两个任务。
 * 这也解释了既有折算口径 `GOLDENFISH_CHECK_RULES.rodUnit = 600` 的来历 —— 它是**字面等价**，
 * 不是估值。
 */
export const GOLDENFISH_ROD_PRICE = 600;

/**
 * 周四钓鱼的**最低目标** = **1300**
 *
 * 原文第 31 行：1140 + 160 = 1300「正好是拿金鱼理论上最低钓鱼次数（经验值）」。
 * 活动最后一天是周四，9 月与 10 月的钓鱼任务共用这一次消耗 ⇒ **9 月只能做 1140**（给 10 月留 160）。
 *
 * ⚠️ 这是**下限**不是上限 —— master 2026-09-28 明确：「周四首先把钓鱼补满 1300 次，
 * **然后看情况决定是否继续做下去**」⇒ 不够就继续往 1750 做（见 `GOLDENFISH_FISH_FULL`）。
 */
export const GOLDENFISH_FISH_MIN_TARGET = 1300;

/**
 * 钓鱼任务的**全满线** = **1750**（20 轮），也就是钓鱼进度的硬上限
 *
 * 原文第 19-24 行的档位表：钓鱼 20 轮累计消耗 1750 次（75/225/525/925/1300/1750）。
 *
 * 🔴 2026-09-28 修正：**之前这里错写成 1300 并当成硬上限**，导致模拟器以为钓鱼只能到 17/20 轮，
 * 把本期道具上限算成 978（而不是 1050），进而错误地得出「凑 250 只有 ~20% 成功率」。
 * 实际上钓鱼做满 20 轮（1750）就能拿到全部 280 个道具。
 *
 * 而且这一步**几乎白送**：金砖任务做满要买 ~800 根原价鱼竿，这些鱼竿本来就得消耗掉，
 * 顺手就能把钓鱼从 1300 推到 1750（1300 + 800 = 2100，早超了）。
 */
export const GOLDENFISH_FISH_FULL = 1750;

/**
 * 钓鱼时鱼竿的**返还率** = **10%**（master 2026-09-28 补充口径）
 *
 * master 原话：「实际钓鱼时候，鱼竿有10%返还率，所以 x 个鱼可以得到 x/0.9 的消耗量」。
 *
 * ⇒ 每次钓鱼**期望**净消耗 0.9 根鱼竿（10% 概率钓完鱼竿回来）：
 *   - x 根鱼竿 → 期望可钓 `x / 0.9` 次（`rodsToFishes`）
 *   - 要钓 n 次 → 期望只需买 `n × 0.9` 根（`fishesToRods`）
 *
 * ⚠️ 这是**期望口径**（与开普通道具的「期望值简化」同一思路，master 明确不追求精确还原）。
 * 真实方差由游戏内随机决定；模拟器与计划器都按期望折算。
 *
 * 🔴 影响面（都按这个折算）：
 *   - `planRodPurchase`：`rodsForFishCap`（钓鱼补满要买的根数）× 0.9；
 *     **`rodsForGoldFull` 不变** —— 金砖任务看的是「花出去的金砖」，返还的是鱼竿不是金砖。
 *   - 虚拟服务端 `artifact_lottery`：钓鱼 N 次净消耗 `ceil(N × 0.9)` 根，账目自洽。
 */
export const GOLDENFISH_ROD_RETURN_RATE = 0.1;

/** x 根鱼竿期望可钓的次数 = floor(x / (1 − rate))（rate 默认 0.1 ⇒ x/0.9） */
export const rodsToFishes = (rods, rate = GOLDENFISH_ROD_RETURN_RATE) =>
  Math.floor(Math.max(0, Math.floor(Number(rods) || 0)) / Math.max(0.05, 1 - rate));

/** 钓 n 次鱼期望需要的鱼竿数 = ceil(n × (1 − rate))（rate 默认 0.1 ⇒ n×0.9） */
export const fishesToRods = (fishes, rate = GOLDENFISH_ROD_RETURN_RATE) =>
  Math.ceil(Math.max(0, Math.floor(Number(fishes) || 0)) * Math.min(1, Math.max(0, 1 - rate)));

/**
 * 周四收尾的**观察点**：金砖 380,000（轮 17）+ 钓鱼 1,300（轮 17）
 *
 * master 2026-09-28 拍板的收尾流程（原话）：
 *   「最后一天先做到宝箱招募做满，金砖 38 万 / 钓鱼 1300 次的状态，
 *     然后判断后续差距，找到任意一个可行解，
 *     然后判断，如果存在用 2 轮金砖换一轮钓鱼的机会，那就换。」
 *
 * 数值含义：38 万 = slot5 第 17 轮阈值（30 万 + 4 万×2），1,300 = slot3 第 17 轮累计。
 * 观察点起步时五类道具累计 = 400（招募）+ 200（宝箱）+ 208（钓鱼轮 17）+ 20（罐子）+ 114（金砖轮 17）
 * = **942 个** ≈ 235.5 个特殊道具 —— 还不够 250，差距靠补档循环填。
 */
export const GOLDENFISH_OBSERVE_GOLD = 380000;

/**
 * 「2 轮金砖换 1 轮钓鱼」的**收敛参考线** = 460,000（轮 19）
 *
 * 为什么不是做满 500,000：最后 5 轮金砖每轮 12 道具，只有钓鱼 tier6（24 道具/轮）的一半产出；
 * 第 20 轮金砖（4 万金砖 → 12 道具）是全链**唯一低效支出**。
 *
 * 「2 换 1」的交换数学（为什么是赚的）：
 *   1 轮钓鱼（tier6，150 次）≈ 135 根杆（10% 返还）= 81,000 金砖 ≈ 2 轮金砖（80,000）
 *   → 两边都产 24 个普通道具，几乎等价交换；
 *   但**杆钱计入金砖消耗任务**（原文第 135 行）⇒ 交换后金砖进度一分不少，
 *   钓鱼 +150 次（24 道具）是白捡的 —— 且 38 万观察点 + 8.1 万杆钱正好跨过 46 万（轮 19）。
 *
 * ⚠️ 这是**策略参考线**不是硬规则：自动循环里金砖进度由买杆自然推进（杆钱顺带把
 * 第 20 轮也跨过去），不需要人为压 `goldMax`；显式传 `goldMax: 500000` 即回到旧口径。
 */
export const GOLDENFISH_GOLD_TARGET = 460000;

/**
 * 开 1 个普通道具的**资源返还期望**（原文第 118-120 行）
 *
 * 「普通道具开启之后，按照期望值计算，每个道具能得到：
 *   0.5 个招募令，0.205 个铂金宝箱，0.25 特殊道具（兑换金鱼用），107.304 个金砖
 *  实际上每次只能得到每个道具若干，不可能同时得到多个道具，这里用期望值简化了计算。」
 *
 * 🔴 master 2026-09-28 澄清（**重要**）：
 *   1. **四项是「同时获取」，不是多选一！** 每开 1 个普通道具，四项奖励**各自独立**结算 ——
 *      既可能同时拿到招募令 + 铂金箱 + 金砖 + 特殊道具，也可能四项都空。
 *   2. 原文那句「不可能同时得到多个道具」指的是**数量是整数个**（不能得到 0.205 个铂金箱），
 *      **不是**说四项互斥 —— 所以「用期望值简化」= 用 0.5 / 0.205 / 0.25 / 107.304 代替整数抽样。
 *   3. 因为走期望值，**实际单次得到的会更多（方差很大）**，只有大样本才收敛到期望。
 *
 * ✅ master 2026-09-28 确认：**以 0.205 为准**；原文第 80 行那个「0.2」只是当时的简化写法
 * （0.2 × 50 = 10 分 vs 0.205 × 50 = 10.25 分，差 2.5%，对结论无影响）。
 *
 * ⚠️ 这与原文第 78-80 行的「宝箱回收循环」是同一件事：
 * 开普通道具 → 得铂金宝箱（0.205 个/道具 × 50 分 = 10.25 分）→ 可再投入宝箱任务。
 */
export const GOLDENFISH_PACK_RETURNS = Object.freeze({
  recruitToken: 0.5,
  platinumBox: 0.205,
  gold: 107.304,
  special: 0.25,
});

/**
 * 铂金宝箱的**真实掉落概率分布**（master 2026-09-28 给的实例，用来解释「期望值」的含义）
 *
 * 期望 = 4.5% × 2 + 1.1% × 5 + 0.6% × 10 = 0.09 + 0.055 + 0.06 = **0.205**
 * ✅ 与 `GOLDENFISH_PACK_RETURNS.platinumBox` **精确吻合** —— 这就是「0.205 不是拍脑袋的数」的证据。
 *
 * ⚠️ 注意：三个概率加起来是 **6.2%**（master 口述为 6.1%，是心算滑了一下；
 * 以这三个给定概率为准，因为它们的加权和刚好精确等于 0.205）。
 * 也就是说 **93.8% 的普通道具开出来「没有铂金宝箱」**，但每开一个道具仍按 0.205 计入期望。
 * 这正是「用期望值简化」的代价：**单次方差极大，只有开成百上千个才收敛**。
 *
 * 用途：① 作为「期望值口径自洽」的回归依据（见 `test/goldenfishFinishPlan.test.js`）；
 *      ② 将来若要改成**精确模拟**（而非期望值），这就是采样分布。
 */
export const GOLDENFISH_PLATINUM_BOX_DROPS = Object.freeze([
  { count: 2, rate: 0.045 },
  { count: 5, rate: 0.011 },
  { count: 10, rate: 0.006 },
]);

/** 铂金宝箱的命中率（有掉落的总概率）= 4.5% + 1.1% + 0.6% = **6.2%**；其余 93.8% 是别的奖励 */
export const GOLDENFISH_PLATINUM_BOX_HIT_RATE =
  Math.round(GOLDENFISH_PLATINUM_BOX_DROPS.reduce((s, d) => s + d.rate, 0) * 1e6) / 1e6;

/**
 * 档位定义：slot → [{ rounds, cost, reward }]
 * `cost` 单位：slot 1 招募令 / 2 宝箱积分 / 3 黄金鱼竿 / 4 罐子 / 5 **万金砖单位**（1 = 1 万金砖）
 */
export const GOLDENFISH_TIERS = Object.freeze({
  1: [
    { rounds: 5, cost: 80, reward: 8 },
    { rounds: 5, cost: 160, reward: 16 },
    { rounds: 5, cost: 240, reward: 24 },
    { rounds: 5, cost: 320, reward: 32 },
  ],
  2: [
    { rounds: 5, cost: 2000, reward: 4 },
    { rounds: 5, cost: 4000, reward: 8 },
    { rounds: 5, cost: 6000, reward: 12 },
    { rounds: 5, cost: 8000, reward: 16 },
  ],
  3: [
    { rounds: 3, cost: 25, reward: 4 },
    { rounds: 3, cost: 50, reward: 8 },
    { rounds: 4, cost: 75, reward: 12 },
    { rounds: 4, cost: 100, reward: 16 },
    { rounds: 3, cost: 125, reward: 20 },
    { rounds: 3, cost: 150, reward: 24 },
  ],
  4: [{ rounds: 20, cost: 3, reward: 1 }],
  5: [
    { rounds: 5, cost: 1, reward: 3 },
    { rounds: 5, cost: 2, reward: 6 },
    { rounds: 5, cost: 3, reward: 9 },
    { rounds: 5, cost: 4, reward: 12 },
  ],
});

/** 单位标签（日志/UI 用） */
export const GOLDENFISH_UNIT_LABELS = Object.freeze({
  1: "招募令",
  2: "宝箱积分",
  3: "黄金鱼竿",
  4: "罐子",
  5: "金砖",
});

// ------------------------------------------------------------------ 档位表派生

/**
 * 某任务 20 轮的逐轮表
 *
 * ⚠️ **量纲铁律**：`threshold` 必须与实际进度（活动 `task[slot]`）同量纲可比。
 * slot 5 的档位定义是「万金砖单位」，但服务端进度统计的是**实际金砖数**
 * （抓包 `task.5 = 20389` ≥ 20000 → 第 2 轮达标），所以这里把 slot 5 的
 * 逐轮 `cost` 乘回 10000，同时保留 `unit` 记原始档位单位。
 *
 * @returns {Array<{round:number, tierIndex:number, cost:number, unit:number,
 *                  reward:number, threshold:number, cumReward:number}>}
 */
export const buildRoundTable = (slot) => {
  const tiers = GOLDENFISH_TIERS[slot];
  if (!tiers) return [];
  const rows = [];
  let threshold = 0;
  let cumReward = 0;
  let round = 0;
  tiers.forEach((tier, tierIndex) => {
    for (let i = 0; i < tier.rounds; i += 1) {
      round += 1;
      // slot 5：档位单位（万金砖）→ 实际金砖数，保证 threshold 可直比进度
      const cost = slot === 5 ? tier.cost * GOLDENFISH_GOLD_UNIT : tier.cost;
      threshold += cost;
      cumReward += tier.reward;
      rows.push({
        round,
        tierIndex,
        cost,
        unit: tier.cost,
        reward: tier.reward,
        threshold,
        cumReward,
      });
    }
  });
  return rows;
};

/**
 * 全满累计消耗 / 累计道具（自检用）
 * 招募 4000 次 / 宝箱 100000 分 / 钓鱼 1750 根 / 罐子 60 个 / **金砖 500000**
 */
export const taskTotals = (slot) => {
  const rows = buildRoundTable(slot);
  const last = rows[rows.length - 1] ?? { threshold: 0, cumReward: 0 };
  return { maxThreshold: last.threshold, maxReward: last.cumReward, rounds: rows.length };
};

/** 五类任务全满的道具总数（应为 1050，与原文交叉验证） */
export const totalRewardAllTasks = () =>
  Object.keys(GOLDENFISH_TIERS).reduce((sum, slot) => sum + taskTotals(Number(slot)).maxReward, 0);

/** 已达标轮数：阈值 ≤ progress 的最大轮号（0 = 一轮都没达标） */
export const completedRounds = (slot, progress) => {
  const value = Number(progress);
  if (!Number.isFinite(value) || value <= 0) return 0;
  const rows = buildRoundTable(slot);
  let done = 0;
  for (const row of rows) {
    if (value >= row.threshold) done = row.round;
    else break;
  }
  return done;
};

/** 从 round 推到 toRound 需要额外消耗多少（同单位） */
export const costToReachRound = (slot, fromRound, toRound) => {
  const rows = buildRoundTable(slot);
  const from = Math.max(0, Math.floor(Number(fromRound) || 0));
  const to = Math.max(from, Math.floor(Number(toRound) || 0));
  let cost = 0;
  for (const row of rows) {
    if (row.round > from && row.round <= to) cost += row.cost;
  }
  return cost;
};

/** 从 fromRound 推到 toRound 能拿到多少普通道具 */
export const rewardFromRoundTo = (slot, fromRound, toRound) => {
  const rows = buildRoundTable(slot);
  const from = Math.max(0, Math.floor(Number(fromRound) || 0));
  const to = Math.max(from, Math.floor(Number(toRound) || 0));
  let reward = 0;
  for (const row of rows) {
    if (row.round > from && row.round <= to) reward += row.reward;
  }
  return reward;
};

// ------------------------------------------------------------------ 领奖

/** `(slot, round)` → missionId（1..100） */
export const toMissionId = (slot, round) => (slot - 1) * ROUNDS_PER_TASK + round;

/** missionId → `{slot, round}`；超出 1..100 返回 null */
export const fromMissionId = (missionId) => {
  const id = Math.floor(Number(missionId));
  if (!Number.isFinite(id) || id < 1 || id > 5 * ROUNDS_PER_TASK) return null;
  return {
    slot: Math.floor((id - 1) / ROUNDS_PER_TASK) + 1,
    round: ((id - 1) % ROUNDS_PER_TASK) + 1,
  };
};

/** 响应里的 `record`（missionId → 时间戳）→ 已领 missionId 的 Set */
export const readClaimedMissionIds = (record) => {
  const out = new Set();
  if (!record || typeof record !== "object") return out;
  for (const key of Object.keys(record)) {
    const id = Number(key);
    if (Number.isFinite(id) && fromMissionId(id)) out.add(Math.trunc(id));
  }
  return out;
};

/** missionId → 该档奖励的普通道具数（越界返回 0） */
export const rewardOfMission = (missionId) => {
  const parsed = fromMissionId(missionId);
  if (!parsed) return 0;
  return buildRoundTable(parsed.slot)[parsed.round - 1]?.reward ?? 0;
};

/**
 * 领奖扫描：已完成轮次里还没领的 missionId
 *
 * ✅ **master 2026-09-28 晚间确认（原「待实测」项已拍板）**：服务端**不会**「达标即自动发奖」
 * —— 原话「不是，一轮奖励需要手动领取一次，也就是说，对于同一个任务的 20 轮挡位，
 * 我需要点 20 次领取才能领完」。抓包账号只领了 5 次**是 master 手动只点了一次**（为了提供数据），
 * 不是服务端只发一次。
 * ⇒ 本函数「扫出全部已完成但未领的档位、逐轮补领」的语义**正确**，可放心接生产。
 *
 * @param {object} progressBySlot `{ 1:3685, 2:96530, 3:1140, 4:632, 5:20389 }`
 * @param {object|Set} record 活动响应的 `.record`（或已解析的 Set）
 * @param {{maxRound?:number}} [options]
 * @returns {{pending:Array<{slot:number,round:number,missionId:number,reward:number}>,
 *            items:number, detected:number, alreadyClaimed:number, claimedItems:number}}
 */
export const planClaimSweep = (progressBySlot, record, options = {}) => {
  const claimed =
    record instanceof Set ? record : readClaimedMissionIds(record);
  const maxRound = Number.isFinite(Number(options.maxRound))
    ? Math.floor(Number(options.maxRound))
    : ROUNDS_PER_TASK;

  const pending = [];
  for (const slot of Object.keys(GOLDENFISH_TIERS).map(Number)) {
    const done = completedRounds(slot, progressBySlot?.[slot]);
    const limit = Math.min(done, maxRound);
    for (let round = 1; round <= limit; round += 1) {
      const missionId = toMissionId(slot, round);
      if (claimed.has(missionId)) continue;
      pending.push({
        slot,
        round,
        missionId,
        reward: buildRoundTable(slot)[round - 1].reward,
      });
    }
  }
  return {
    pending,
    items: pending.reduce((sum, item) => sum + item.reward, 0),
    detected: pending.length,
    alreadyClaimed: claimed.size,
    /** 已领档位折算的道具数（与 `items` 同量纲，便于做「1050 = 已领 + 待领 + 剩余」总账） */
    claimedItems: [...claimed].reduce((sum, id) => sum + rewardOfMission(id), 0),
  };
};

// ------------------------------------------------------------------ 开普通道具

/** 线性同余 PRNG（结果可复现：同种子 ⇒ 同序列） */
export const createRng = (seed = 20260928) => {
  let state = (Math.floor(Number(seed) || 20260928) >>> 0) || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/**
 * bias 的上界（含）：`bias ∈ [-5, 5]` 的**整数**
 *
 * 🔴 master 2026-09-28 定口径：「有保底，我们用这个简单计算公式：
 * `特殊道具数 = 普通道具数 × 0.25 + bias`，`bias ∈ [-5, 5]`，然后取整数。」
 */
export const GOLDENFISH_PACK_BIAS_MAX = 5;

/**
 * bias 的**线性概率权重**（下标 0..10 对应 bias = -5..5）
 *
 * 权重 `w(b) = MAX + 1 - |b|` ⇒ `b=0 → 6`、`|b|=1 → 5`、…、`|b|=5 → 1`。
 * 权重和 = `6 + 2×(5+4+3+2+1) = 36` ⇒ `p(b) = w(b)/36`，
 * 也就是对 `|b|` **线性递减**（离散化的三角分布，峰在 0）。
 *
 * 为什么这样选：
 *   - **对称** ⇒ `E[bias] = 0`，所以 `E[特殊道具] = 普通道具数 × 0.25`，口径不漂；
 *   - **有界** ⇒ `|bias| ≤ 5`，这就是「保底」的体现 —— 开得越多，相对偏差越小
 *     （开 1050 个道具时偏差 ≤ 5/262.5 ≈ 1.9%）；
 *   - **线性** ⇒ 正是 master 要的「bias 概率给个线性的就行了」，不引入正态分布。
 */
export const GOLDENFISH_PACK_BIAS_WEIGHTS = Object.freeze(
  Array.from(
    { length: GOLDENFISH_PACK_BIAS_MAX * 2 + 1 },
    (_, i) => GOLDENFISH_PACK_BIAS_MAX + 1 - Math.abs(i - GOLDENFISH_PACK_BIAS_MAX),
  ),
);

/** bias 权重总和（= 36），抽签时的分母 */
export const GOLDENFISH_PACK_BIAS_TOTAL = GOLDENFISH_PACK_BIAS_WEIGHTS.reduce(
  (s, w) => s + w,
  0,
);

/**
 * 抽一个整数 `bias ∈ [-5, 5]`（线性概率，峰在 0；吃一个 0~1 的 rng）
 * @param {Function} rng
 * @returns {number} 整数 bias
 */
export const packBias = (rng) => {
  const roll = Number(rng()) * GOLDENFISH_PACK_BIAS_TOTAL;
  let acc = 0;
  for (let i = 0; i < GOLDENFISH_PACK_BIAS_WEIGHTS.length; i += 1) {
    acc += GOLDENFISH_PACK_BIAS_WEIGHTS[i];
    if (roll < acc) return i - GOLDENFISH_PACK_BIAS_MAX;
  }
  return 0; // 浮点兜底（roll 恰好落在总和上时）
};

/**
 * 开 N 个普通道具 → 特殊道具数（**期望值 + 有界线性 bias**，即「有保底」）
 *
 * 🔴 master 2026-09-28 定口径（原话）：
 *   「**有保底**，我们用这个简单计算公式：`特殊道具数 = 普通道具数 * 0.25 + bias`，
 *     `bias in [-5,5]`，然后取整数，`bias` 概率就给个线性的就行了，
 *     **不需要真的用正态分布**。我们主要验证逻辑，不是需要精确还原。」
 *
 * 即：
 *   1. `base = 普通道具数 × p`（p 默认 0.25，会是小数）
 *   2. `bias` = 从 `[-5, 5]` 按**线性概率**抽的一个整数（见 `GOLDENFISH_PACK_BIAS_WEIGHTS`）
 *   3. `特殊道具数 = round(base + bias)`，再截断到 `[0, 普通道具数]`
 *
 * ✅ 这个模型的性质（正是「保底」应有的样子）：
 *   - `E[bias] = 0` ⇒ 期望仍是 `普通道具数 × 0.25`（口径不偏）；
 *   - **绝对偏差有界**（`|偏差| ≤ 5 + 0.5`）⇒ 开得越多、相对偏差越小
 *     （开 100 个道具偏差 ≤ ±5.5%，开 1050 个 ≤ ±1.9%）—— 这就是「保底」；
 *   - 与旧的正态近似相比：正态的 `σ = √(np(1-p))` 在 n=1030 时约为 13.9，
 *     远比 5 大 ⇒ 正态模型会**低估**成功率。master 明确「有保底」后改用本模型。
 *
 * ⚠️ 关于「措辞」：这里说的是**开普通道具（5287）**产出**特殊道具（5286）**，
 * **不是开宝箱**（木箱/青铜/黄金/铂金/钻石）。宝箱只产宝箱积分，对「拿金鱼」没有直接产出。
 *
 * ⚠️ **bias 是按「每一次开包调用」各抽一次的** —— 分批开则各批偏差独立叠加
 * （本场景最多两批，所以总偏差 ∈ [-10, 10]）；若希望「整场只偏一次」，
 * 需要把 bias 提到调用方自己去抽。
 *
 * @param {{count:number, rate?:number, rng?:Function, seed?:number, openedCount?:number}} options
 * @returns {{special:number, packs:number, openedCount:number, base:number, mean:number,
 *            bias:number, biasMax:number, deviation:number}}
 */
export const openPacks = (options = {}) => {
  const count = Math.max(0, Math.floor(Number(options.count) || 0));
  const p =
    Number.isFinite(Number(options.rate)) && Number(options.rate) >= 0 && Number(options.rate) <= 1
      ? Number(options.rate)
      : 0.25;
  const rng = typeof options.rng === "function" ? options.rng : createRng(options.seed);

  const base = count * p; // 期望值基线（可能带小数）
  const bias = count > 0 ? packBias(rng) : 0; // 保底偏移（整数，±5 以内）
  // 截断到 [0, count]：不可能开出比道具更多的特殊道具
  const raw = Math.round(base + bias);
  const special = Math.max(0, Math.min(count, raw));

  return {
    special,
    packs: count,
    openedCount: Math.max(0, Math.floor(Number(options.openedCount) || 0)) + count,
    base,
    mean: base, // 兼容旧字段名（= 期望值基线）
    bias,
    biasMax: GOLDENFISH_PACK_BIAS_MAX,
    deviation: special - base, // 实际相对期望的偏移（含取整，故可达 ±5.5）
  };
};

/**
 * 按 25% 概率估算「还差 gap 个特殊道具」需要多少普通道具（原文第 87 行「差 n 个就再要 4n 个」）
 * @returns {number}
 */
export const packsNeededForGap = (gap, rate = 0.25) => {
  const g = Math.max(0, Math.ceil(Number(gap) || 0));
  const r = Number.isFinite(Number(rate)) && Number(rate) > 0 ? Number(rate) : 0.25;
  return Math.ceil(g / r);
};

// ------------------------------------------------------------------ 收尾补齐组合

/** 金砖档位消耗换算成实际金砖数（cost 单位 × 10000） */
export const goldCostOf = (tierCost) => Math.max(0, Number(tierCost) || 0) * GOLDENFISH_GOLD_UNIT;

/**
 * 开 N 个普通道具的**资源返还**（期望值，原文第 118-120 行）
 *
 * 🔴 **四项是「同时获取」**（master 2026-09-28 澄清）：招募令 / 铂金箱 / 金砖 / 特殊道具
 * **各自独立结算**，一个道具可以同时贡献四项，也可以四项都空 —— **不是多选一**。
 * 所以返回值的四个字段**都该被消费方累加**，不能只取其中一个。
 *
 * ⚠️ 这里不逐次随机，直接按期望折算（master 明确要用期望简化）。
 * ⚠️ 单次方差极大：以铂金箱为例，只有 **6.2%** 的道具会掉（4.5%→2 个 / 1.1%→5 个 / 0.6%→10 个，
 * 见 `GOLDENFISH_PLATINUM_BOX_DROPS`），其余 93.8% 一个都不掉，但期望仍是 0.205。
 * ⇒ **小数别急着 floor**，跨批次丢弃小数会累积误差（engine 里已改成小数累加后统一取整）。
 * （特殊道具**不走这里** —— 它由 `openPacks` 用「期望值 + 有界线性 bias（±5）」单独算，
 * 会围绕 `n × 0.25` 上下浮动，而不是恒等于 `n × 0.25`。）
 *
 * @param {number} packs 开出的普通道具数
 * @returns {{recruitToken:number, platinumBox:number, gold:number, special:number}} 四个字段**都要用**
 */
export const openPackReturns = (packs) => {
  const n = Math.max(0, Number(packs) || 0);
  return {
    recruitToken: n * GOLDENFISH_PACK_RETURNS.recruitToken,
    platinumBox: n * GOLDENFISH_PACK_RETURNS.platinumBox,
    gold: n * GOLDENFISH_PACK_RETURNS.gold,
    special: n * GOLDENFISH_PACK_RETURNS.special,
  };
};

/**
 * 收尾补档：枚举「买多少根原价鱼竿」
 *
 * ## 为什么决策变量只有一个
 *
 * 原文第 135 行：金砖消耗任务是**靠买 600/根的原价鱼竿**来完成的。所以买 R 根鱼竿
 * 会**同时**推进两个任务：
 *   - 金砖消耗进度 `+ R × 600`（花出去的金砖）
 *   - 钓鱼消耗进度 `+ R`（买到手的鱼竿）
 * ⇒ 唯一代价 = **金砖支出 `R × 600`**。
 *
 * ⚠️ 旧实现把代价写成 `金砖数 + 鱼竿数 × 600`（加权相加）是**重复计费**：
 * 鱼竿本来就是用那笔金砖买的，不该再加一遍。
 *
 * ## 两个上限
 *   - `goldMax`（默认 500000 = slot5 全满）：金砖任务封顶，超出的支出纯浪费
 *   - `fishCap`（默认 1750 = 钓鱼全满）：钓鱼任务的硬上限。
 *     ⚠️ 1300 只是**周四起手的下限**（`GOLDENFISH_FISH_MIN_TARGET`），不是上限 ——
 *     不够就继续往 1750 做（见 `GOLDENFISH_FISH_FULL`，master 2026-09-28 明确）
 *
 * ## 鱼竿 10% 返还（master 2026-09-28 补充）
 *   每次钓鱼期望净消耗 0.9 根 ⇒ x 根可钓 x/0.9 次（`GOLDENFISH_ROD_RETURN_RATE`）：
 *   - `rodsForFishCap`（钓鱼补满要买的根数）按 `次数 × 0.9` 折算，**每根杆更耐用**
 *   - `rodsForGoldFull` **不变** —— 金砖任务看的是「花出去的金砖」，返还的是杆不是金砖
 *   - `build(rods)` 的 `fishAfter` = 期望可钓次数（floor((库存杆+买杆) / 0.9)）截到 fishRoom
 *   - 可传 `rodReturnRate: 0` 关闭（旧口径对照）
 *
 * ## 返回两种方案
 *   - `minimal`：**满足 needItems 的最小金砖支出**（原文第 87 行「用更小的代价」）
 *   - `master`：**金砖先做满、不够再按钓鱼补到上限**（原文第 134-135 行的完整流程口径）
 *
 * @param {{progressBySlot:object, needItems:number, rodPrice?:number, fishCap?:number,
 *          goldMax?:number, goldInStock?:number, rodsInStock?:number,
 *          rodReturnRate?:number, limit?:number}} options
 *   `needItems` 必填；`fishCap` 默认 1750（钓鱼全满）；`goldInStock` 默认 Infinity（不设上限）；
 *   `rodsInStock` 默认 **0**（不假设手上已有鱼竿）；`rodReturnRate` 默认 0.1（钓鱼 10% 返还）。
 * @returns {{ok:boolean, reason:string, blockedBy:"gold"|"tiers"|null, best:object|null,
 *            minimal:object|null, master:object, plans:Array<object>, buildAt:Function,
 *            maxItems:number,
 *            maxTotal:number, freeItems:number, rodsWanted:number, goldNeeded:number,
 *            goldShortfall:number, rodsAffordable:number|null, rodReturnRate:number,
 *            rodsForGoldFull:number, freeFish:number, fishRoom:number, caps:object,
 *            progress:object}}
 *   plan = `{ rods, goldSpend, goldUnits, goldAfter, fishAfter, goldRound, fishRound,
 *             items, totalItems, weight, goldFull, fishCapped }`
 *
 * 🔴 **判定口径（2026-09-28 修正，master 实测踩到误导）**：
 *   - `minimal` / `ok` 都用 **`totalItems`**（= 买杆收益 `items` + 罐子白送的 `freeItems`），
 *     不再只用 `items` —— 否则罐子还剩几轮时会**低估**可达上限。
 *   - 被金砖库存卡住时 `blockedBy === "gold"`，`reason` 会说清「需要多少金砖 / 差多少」，
 *     **不再** 谎称「档位做满也只能再拿 N 个」（那是旧版的严重误导）。
 *   - 只有真的档位榨干（`blockedBy === "tiers"`）才说明「做满也没用」。
 */
export const planRodPurchase = (options = {}) => {
  const progress = options.progressBySlot || {};
  const needItems = Math.max(1, Math.ceil(Number(options.needItems) || 0));
  const price =
    Number.isFinite(Number(options.rodPrice)) && Number(options.rodPrice) > 0
      ? Number(options.rodPrice)
      : GOLDENFISH_ROD_PRICE;
  const fishCap = Number.isFinite(Number(options.fishCap))
    ? Math.max(0, Math.floor(Number(options.fishCap)))
    : GOLDENFISH_FISH_FULL;
  const goldMax = Number.isFinite(Number(options.goldMax))
    ? Math.max(0, Math.floor(Number(options.goldMax)))
    : taskTotals(5).maxThreshold;
  const goldInStock = Number.isFinite(Number(options.goldInStock))
    ? Math.max(0, Number(options.goldInStock))
    : Infinity;
  /**
   * 手上**已有**的黄金鱼竿。
   *
   * ⚠️ 默认 **0**，不是 Infinity —— 这里问的是「**还得买**多少根」，所以不该假设手上无限多：
   * 若默认 Infinity，`freeFish` 会等于 `fishRoom`，钓鱼任务就**无条件免费做满**，
   * 于是 `minimal` 永远返回「0 根」、钓鱼维度形同不存在（这是本模块早期的一个坑）。
   * 调用方知道确切库存时必须显式传入（engine 传的就是真实 `rodStock`）。
   */
  const rodsInStock = Number.isFinite(Number(options.rodsInStock))
    ? Math.max(0, Math.floor(Number(options.rodsInStock)))
    : 0;
  /**
   * 鱼竿**返还率**（master 2026-09-28：每次钓鱼 10% 概率返还 ⇒ x 根可钓 x/0.9 次）。
   * 允许传 0 关闭（旧口径对照 / 万一实测返还率不对可直接覆盖）。
   */
  const rodReturn = Math.min(0.95, Math.max(0, Number(options.rodReturnRate ?? GOLDENFISH_ROD_RETURN_RATE) || 0));
  /** 1 根鱼竿期望可钓次数（rate=0.1 ⇒ ≈1.111 次/根） */
  const fishPerRod = 1 / (1 - rodReturn);

  const gd = Math.max(0, Math.floor(Number(progress[5]) || 0));
  const fd = Math.max(0, Math.floor(Number(progress[3]) || 0));
  // ⚠️ rewardFromRoundTo 收的是**轮次**不是进度值，这里先换算好
  const goldDone0 = completedRounds(5, gd);
  const fishDone0 = completedRounds(3, fd);

  const goldRoom = Math.max(0, goldMax - gd); // 金砖任务还能吃多少金砖
  const fishRoom = Math.max(0, fishCap - fd); // 钓鱼任务还能吃多少**次**消耗
  /**
   * 手上已有的鱼竿（不额外花金砖）。
   * 🔴 量纲：这里是**根数**；能贡献的钓鱼**次数** = floor(根数 × fishPerRod)（10% 返还 ⇒ ÷0.9）。
   * 只留「把钓鱼推满所需」那么多根，多出来的对钓鱼没有增益（金砖任务另算）。
   */
  const freeFish = Math.min(rodsInStock, fishesToRods(fishRoom, rodReturn));

  const rodsForGoldFull = Math.ceil(goldRoom / price); // 金砖做满需买的根数（金砖看花费，与返还无关）
  const affordable = Number.isFinite(goldInStock) ? Math.floor(goldInStock / price) : Infinity;
  // 钓鱼补到上限还差多少**根**：还差的次数 × 0.9（10% 返还让每根杆更耐用）
  const rodsForFishCap = Math.max(
    0,
    fishesToRods(fishRoom, rodReturn) - freeFish,
  );
  /** 「做满」需要多少根 = max(金砖做满, 钓鱼补到上限) */
  const rodsWanted = Math.max(rodsForGoldFull, rodsForFishCap);
  const maxRods = Math.min(rodsWanted, affordable);

  /**
   * 🔴 「做满」需要多少金砖 / 差多少 —— **这是最关键的诊断量**。
   *
   * 曾经的严重误导（2026-09-28 master 实测踩到）：被 `affordable` 截断后，
   * `reason` 却写成「金砖做满 + 钓鱼补到上限也只能再拿 N 个」——
   * 那是**假的**：做满本来能拿得多得多，真正卡住的是**手上金砖不够买满**。
   * ⇒ 必须把「需要多少金砖 / 差多少」直接报出来。
   */
  const goldNeeded = rodsWanted * price;
  const goldShortfall = Number.isFinite(goldInStock) ? Math.max(0, goldNeeded - goldInStock) : 0;
  /** 被金砖库存卡住（而不是档位榨干）—— 两者的处置完全不同 */
  const goldBlocked = goldShortfall > 0;

  /**
   * 罐子（slot 4）**不靠买鱼竿推进**（原文口径：自然完成），
   * 但它剩余轮次的奖励是**白送的**普通道具 ⇒ 判定「能不能凑够」时必须算进来。
   * ⚠️ 早期版本只累加 slot 5 + slot 3，会**低估**可达上限（罐子还剩几轮就少几个道具）。
   */
  const freeItems = rewardFromRoundTo(4, completedRounds(4, progress[4]), taskTotals(4).rounds);

  const build = (rods) => {
    const goldSpend = rods * price;
    const goldAfter = gd + goldSpend;
    // 🔴 10% 返还：手里的总根数 × (1/0.9) = 期望可钓次数，再截到钓鱼容量
    const fishCapacity = Math.floor((rods + freeFish) * fishPerRod);
    const fishAfter = fd + Math.min(fishCapacity, fishRoom);
    const goldRound = completedRounds(5, goldAfter);
    const fishRound = completedRounds(3, fishAfter);
    const items =
      rewardFromRoundTo(5, goldDone0, goldRound) + rewardFromRoundTo(3, fishDone0, fishRound);
    return {
      rods,
      goldSpend,
      goldUnits: Math.floor(goldSpend / GOLDENFISH_GOLD_UNIT),
      goldAfter,
      fishAfter,
      goldRound,
      fishRound,
      items,
      /** 买杆收益 + 罐子白送 = 「这一轮的可得总量」 */
      totalItems: items + freeItems,
      weight: goldSpend, // 唯一代价 = 金砖支出
      goldFull: goldAfter >= goldMax,
      fishCapped: fishAfter >= fishCap,
    };
  };

  const plans = [];
  for (let rods = 0; rods <= maxRods; rods += 1) plans.push(build(rods));

  const feasible = plans.filter((p) => p.totalItems >= needItems);
  const minimal =
    feasible.length > 0
      ? feasible.reduce((best, p) => (p.goldSpend < best.goldSpend ? p : best), feasible[0])
      : null;

  // master 口径：金砖先做满；做满仍不够 → 再把钓鱼补到上限（maxRods 已经是这两者的并集）
  const goldFullPlan = build(Math.min(rodsForGoldFull, maxRods));
  const master = goldFullPlan.totalItems >= needItems ? goldFullPlan : build(maxRods);

  const maxItems = plans.length > 0 ? plans[plans.length - 1].items : 0;
  const maxTotal = maxItems + freeItems;

  /**
   * 「档位够不够」看的是**总上限**（买杆能拿的 + 罐子白送的），不是买杆能拿的。
   * 旧写法 `ok = Boolean(minimal)` 只看买杆收益，会漏判罐子的那份。
   */
  const ok = maxTotal >= needItems;

  const reason = ok
    ? ""
    : goldRoom <= 0 && fishRoom <= 0
      ? "金砖与钓鱼档位都已做满，无档位可再推进"
      : goldBlocked
        ? `金砖不足：做到金砖满（${goldMax}）需买 ${rodsWanted} 根 = ${goldNeeded} 金砖，` +
          `手上只有 ${goldInStock}（差 ${goldShortfall}）；只买得起 ${maxRods} 根 → ` +
          `最多再拿 ${maxTotal} 个普通道具（需要 ${needItems}）`
        : `档位已榨干：金砖做满（${goldMax}）+ 钓鱼补到 ${fishCap} 也只能再拿 ${maxTotal} 个普通道具` +
          `（需要 ${needItems}）`;

  return {
    ok,
    reason,
    /** "gold" = 金砖不够（可补金砖解决）｜"tiers" = 档位真的榨干｜null = 可行 */
    blockedBy: ok ? null : goldBlocked ? "gold" : "tiers",
    best: minimal,
    minimal,
    master,
    plans,
    /**
     * 按任意买杆数构造同构方案（`twoForOneCandidate` 的执行器）。
     * 参数与 `plans` 元素同构：`{ rods, goldSpend, goldAfter, fishAfter, goldRound,
     * fishRound, items, totalItems, weight, goldFull, fishCapped }`。
     */
    buildAt: build,
    maxItems,
    /** 买杆能拿的上限 + 罐子白送的上限 = 判定「够不够」的分母 */
    maxTotal,
    /** 罐子（slot 4）剩余轮次的奖励（自然完成，与买杆无关） */
    freeItems,
    /** 「做满」需要买的根数 / 需要多少金砖 / 还差多少金砖 */
    rodsWanted,
    goldNeeded,
    goldShortfall,
    rodsAffordable: Number.isFinite(affordable) ? affordable : null,
    rodsForGoldFull,
    rodsForFishCap,
    freeFish,
    fishRoom,
    /** 鱼竿返还率（master 2026-09-28：钓鱼 10% 返还 ⇒ x 根可钓 x/0.9 次） */
    rodReturnRate: rodReturn,
    caps: { goldMax, fishCap, price, goldInStock, rodsInStock },
    progress: { gold: gd, fish: fd },
  };
};

/**
 * 「2 轮金砖换 1 轮钓鱼」决策（master 2026-09-28 拍板的收尾策略）
 *
 * master 原话：
 *   「首先找到一个可行的方案，按照 25% 的比例出特殊道具计算。
 *     然后如果可行方案中，金砖可做轮数大于等于 2，并且钓鱼轮数不为 0，
 *     那么就用 2 轮金砖换一轮钓鱼。」
 *
 * ## 为什么这个交换是赚的
 *
 *   1 轮钓鱼（tier6，150 次）≈ 135 根杆（10% 返还）= 81,000 金砖 ≈ 2 轮金砖（80,000）
 *   → 两边都产 24 个普通道具，几乎等价交换；
 *   但**杆钱计入金砖消耗任务**（原文第 135 行）⇒ 交换后金砖进度一分不少，
 *   钓鱼 +150 次（24 道具）是白捡的 —— 黑市 400/根的便宜杆更赚（54,000，净省 26,000）。
 *
 * ## 前置条件（两个都要满足才换）
 *   - **金砖可做轮数 ≥ 2**：保证 8.1 万的杆钱几乎都能被金砖任务吃下（最多溢出 1,000）；
 *     若金砖窗口只剩 1 轮（4 万），8.1 万杆钱近半溢出 → 不该换。
 *   - **钓鱼轮数 > 0**：钓鱼还有档可做（全满时无鱼可钓，换不了）。
 *
 * ## 用法
 *   1. 先用 `planRodPurchase` 按 25% 找到任意可行解（`minimal`）；
 *   2. 用本函数判断是否换（`apply`）；
 *   3. 换 → `plan.buildAt(cand.rods)` 得到执行方案（杆钱顺带推进金砖）；
 *      不换 → 直接用 `minimal`。
 *   ⚠️ 换出来的方案可能**不满足**本轮 needItems（它是「半步」）—— 没关系，
 *   调用方循环重估缺口即可，这正是「观察后再补」的迭代节奏。
 *
 * @param {object} progressBySlot 五类任务进度（`task[slot]`，slot 5 是实际金砖数）
 * @param {{rodReturnRate?:number, rodPrice?:number}} [options]
 * @returns {{apply:boolean, rods:number, fishRoundCost:number, goldSpend:number,
 *            goldLeft:number, fishLeft:number, reason:string}}
 *   `apply=true` 时 `rods` = 买「1 轮钓鱼」所需根数（期望口径 ceil(次数 × (1−rate))），
 *   `goldSpend` = 这批杆的金砖支出（≈ 2 轮金砖）。
 */
export const twoForOneCandidate = (progressBySlot, options = {}) => {
  const progress = progressBySlot || {};
  const rodReturn = Math.min(
    0.95,
    Math.max(0, Number(options.rodReturnRate ?? GOLDENFISH_ROD_RETURN_RATE) || 0),
  );
  const price =
    Number.isFinite(Number(options.rodPrice)) && Number(options.rodPrice) > 0
      ? Number(options.rodPrice)
      : GOLDENFISH_ROD_PRICE;
  const goldLeft = Math.max(0, ROUNDS_PER_TASK - completedRounds(5, progress[5]));
  const fishDone = completedRounds(3, progress[3]);
  const fishLeft = Math.max(0, ROUNDS_PER_TASK - fishDone);
  if (goldLeft < 2 || fishLeft <= 0) {
    return {
      apply: false,
      rods: 0,
      fishRoundCost: 0,
      goldSpend: 0,
      goldLeft,
      fishLeft,
      reason:
        goldLeft < 2
          ? `金砖窗口只剩 ${goldLeft} 轮（< 2），杆钱会大量溢出，不换`
          : `钓鱼已无档可做（${fishLeft} 轮），不换`,
    };
  }
  // 下一轮钓鱼要多少次消耗 → 折成买杆根数（10% 返还口径：ceil(次数 × 0.9)）
  const fishRoundCost = costToReachRound(3, fishDone, fishDone + 1);
  const rods = fishesToRods(fishRoundCost, rodReturn);
  return {
    apply: rods > 0,
    rods,
    fishRoundCost,
    goldSpend: rods * price,
    goldLeft,
    fishLeft,
    reason:
      rods > 0
        ? `金砖窗口 ${goldLeft} 轮 + 钓鱼剩 ${fishLeft} 轮 → 买 ${rods} 根杆（${rods * price} 金砖 ≈ 2 轮金砖）换 1 轮钓鱼（+${fishRoundCost} 次）`
        : "下一轮钓鱼消耗为 0，无需交换",
  };
};

// ------------------------------------------------------------------ 收尾模拟（纯逻辑循环）

/**
 * 收尾模拟（纯逻辑）：反复 { 估缺口 → 枚举买鱼竿 → 推档位 → 开普通道具 } 直到满 250 或资源耗尽
 *
 * ⚠️ 这是**纯逻辑推演**，不发请求。带服务端的完整收尾见
 *    `tools/goldenfish-simulator/engine.js` 的 `runFinishPhase`。
 *
 * 2026-09-28 master 补充信息 + 两轮澄清后重写，与旧版的区别：
 *   1. 补档 = **买原价鱼竿**（`planRodPurchase`）—— 金砖支出同时推进金砖任务与钓鱼任务
 *   2. 钓鱼是「先补满 1300（`GOLDENFISH_FISH_MIN_TARGET`），不够就继续做到 1750 全满
 *      （`GOLDENFISH_FISH_FULL`）」—— **1300 是下限不是上限**（master 2026-09-28 明确）
 *   3. 开普通道具会**同时**返还招募令/铂金箱/金砖（期望值），**返还的金砖回流**可再买鱼竿
 *   4. 特殊道具数走 **「期望值 + 有界线性 bias」**（`openPacks`，`bias ∈ [-5,5]` 线性概率）
 *      —— **有保底**，不逐次抽样、不建正态模型
 *
 * @param {{specialOwned?:number, packsOwned?:number, progressBySlot?:object,
 *          targetSpecial?:number, rate?:number,
 *          rodPrice?:number, fishCap?:number, goldMax?:number,
 *          goldInStock?:number, rodsInStock?:number, seed?:number,
 *          strategy?:"master"|"minimal"|"twoForOne", rodReturnRate?:number,
 *          goldTopUp?:boolean, maxIterations?:number}} options
 *   `goldTopUp` 默认 **true**（master 2026-09-28 拍板的最后兜底：运气不好还差几个
 *   特殊道具就补一轮金砖，一定够 —— 传 false 可关掉做对照）。
 * @returns {{ok:boolean, special:number, packsOpened:number, specialGained:number,
 *            iterations:Array<object>, rounds:number, reason:string, freeItems:number,
 *            goldSpent:number, rodsBought:number, returns:object, strategy:string,
 *            topups:number}}
 */
export const simulateFinish = (options = {}) => {
  const target = Math.max(1, Math.floor(Number(options.targetSpecial) || 250));
  const rate = Number.isFinite(Number(options.rate)) ? Number(options.rate) : 0.25;
  const rodPrice =
    Number.isFinite(Number(options.rodPrice)) && Number(options.rodPrice) > 0
      ? Number(options.rodPrice)
      : GOLDENFISH_ROD_PRICE;
  const fishCap = Number.isFinite(Number(options.fishCap))
    ? Math.max(0, Math.floor(Number(options.fishCap)))
    : GOLDENFISH_FISH_FULL;
  const goldMax = Number.isFinite(Number(options.goldMax))
    ? Math.max(0, Math.floor(Number(options.goldMax)))
    : taskTotals(5).maxThreshold;
  /**
   * 补档策略：
   *   - "master"：金砖先做满、不够再按钓鱼补到上限（原文第 134-135 行口径）
   *   - "minimal"：满足缺口的**最小金砖支出**（「任意可行解」）
   *   - "twoForOne"：**2 轮金砖换 1 轮钓鱼**（master 2026-09-28 拍板）——
   *     可行解若满足「金砖可做 ≥2 轮 && 钓鱼还有档」，把 2 轮金砖的份额
   *     改买 1 轮钓鱼的杆，杆钱顺带推进金砖任务（详见 `twoForOneCandidate`）
   */
  const strategy =
    options.strategy === "minimal"
      ? "minimal"
      : options.strategy === "twoForOne"
        ? "twoForOne"
        : "master";
  /** 鱼竿返还率（透传给 `planRodPurchase` 与 2 换 1 折算；可传 0 关闭） */
  const rodReturn = Math.min(
    0.95,
    Math.max(0, Number(options.rodReturnRate ?? GOLDENFISH_ROD_RETURN_RATE) || 0),
  );
  const rng = createRng(options.seed);
  const maxIterations = Math.max(1, Math.floor(Number(options.maxIterations) || 30));
  /**
   * 🔴 最后兜底（master 2026-09-28 原话）：「最后的兜底手段——如果运气不好还差几个
   *     特殊道具的话，就补一轮金砖……补一轮金砖一定会够的，不存在补不够的情况」。
   *
   * 依据：游戏对特殊道具出率有**强控制**（实际紧贴 25%，误差极小 —— 20:34 补充），
   * 按 25% 找到的可行解落地后缺口只剩几个 ⇒ 一轮金砖（≈4 万金砖 → 12 个道具 →
   * 期望 +3 特殊）足以覆盖。这是**金砖 46 万收敛线的合法例外**：
   * 第 20 轮平时不做（低效），但作为保命手段随叫随到。
   */
  const goldTopUp = options.goldTopUp !== false;

  const progress = { ...(options.progressBySlot || {}) };
  let special = Math.max(0, Math.floor(Number(options.specialOwned) || 0));
  let packs = Math.max(0, Math.floor(Number(options.packsOwned) || 0));
  let goldStock = Number.isFinite(Number(options.goldInStock))
    ? Math.max(0, Number(options.goldInStock))
    : Infinity;
  let rodStock = Number.isFinite(Number(options.rodsInStock))
    ? Math.max(0, Math.floor(Number(options.rodsInStock)))
    : 0;
  let goldSpent = 0;
  let rodsBought = 0;
  const totalReturns = { recruitToken: 0, platinumBox: 0, gold: 0, special: 0 };
  const iterations = [];

  /** 开一批普通道具：累计特殊道具 + 返还（返还的金砖回流到可用金砖） */
  const openBatch = (count) => {
    const n = Math.max(0, Math.floor(count));
    if (n <= 0) return { special: 0, returns: openPackReturns(0) };
    const res = openPacks({ count: n, rate, rng });
    special += res.special;
    const returns = openPackReturns(n);
    totalReturns.recruitToken += returns.recruitToken;
    totalReturns.platinumBox += returns.platinumBox;
    totalReturns.gold += returns.gold;
    totalReturns.special += returns.special;
    if (Number.isFinite(goldStock)) goldStock += returns.gold;
    return { special: res.special, returns };
  };

  // 第 0 步：开掉手上已有的普通道具
  if (packs > 0) {
    const before = packs;
    const r = openBatch(before);
    iterations.push({
      kind: "open",
      label: `开掉库存普通道具 ${before} 个`,
      packs: before,
      gained: r.special,
      special,
      returns: r.returns,
      debt: Math.max(0, target - special),
    });
    packs = 0;
  }

  /**
   * 罐子（slot 4）**自然完成**（原文口径，不消耗任何东西）⇒ 它剩余轮次的奖励
   * 会被「达成一轮领一轮」的领奖循环一起领掉 —— 属于**白送的道具**，必须先算进来。
   *
   * ⚠️ 曾经漏掉这一步：`planRodPurchase` 只在买杆收益里找解，罐子还剩几轮就被**低估**，
   * 于是可能误报「凑不够」（2026-09-28 master 实测暴露）。
   */
  const freeItems = rewardFromRoundTo(4, completedRounds(4, progress[4]), taskTotals(4).rounds);
  if (freeItems > 0) {
    const r = openBatch(freeItems);
    iterations.push({
      kind: "free",
      label: `罐子档位自然完成 → 白送 ${freeItems} 个普通道具`,
      packs: freeItems,
      gained: r.special,
      special,
      returns: r.returns,
      debt: Math.max(0, target - special),
    });
    // 视作罐子已满，避免后续 planRodPurchase 重复计入 freeItems
    progress[4] = taskTotals(4).maxThreshold;
  }

  let reason = special >= target ? "reached" : "";
  let i = 0;
  while (special < target && i < maxIterations) {
    i += 1;
    const gap = target - special;
    const needItems = packsNeededForGap(gap, rate);
    const plan = planRodPurchase({
      progressBySlot: progress,
      needItems,
      rodPrice,
      fishCap,
      goldMax,
      goldInStock: Number.isFinite(goldStock) ? goldStock : undefined,
      rodsInStock: Number.isFinite(rodStock) ? rodStock : undefined,
      rodReturnRate: rodReturn,
    });
    if (!plan.ok) {
      reason = plan.reason;
      break;
    }
    let picked = null;
    let traded = false;
    if (strategy === "minimal") {
      picked = plan.minimal;
    } else if (strategy === "twoForOne") {
      // 🔴 master 2026-09-28 拍板：可行解若满足「金砖可做 ≥2 轮 && 钓鱼还有档」，
      //    就把 2 轮金砖（8 万）的份额换成 1 轮钓鱼的杆（135 根 = 8.1 万）——
      //    杆钱计入金砖任务 ⇒ 金砖进度不减、钓鱼白捡一档。
      //    换出来的方案可能不满足本轮 needItems（半步），循环重估即可。
      const cand = twoForOneCandidate(progress, { rodReturnRate: rodReturn, rodPrice });
      const candidate = cand.apply && plan.buildAt ? plan.buildAt(cand.rods) : null;
      const fallback = plan.minimal ?? plan.master;
      if (
        candidate &&
        (!fallback || candidate.goldSpend <= fallback.goldSpend) &&
        (!Number.isFinite(goldStock) || goldStock >= candidate.goldSpend)
      ) {
        picked = candidate;
        traded = true;
      } else {
        picked = fallback;
      }
    } else {
      picked = plan.master;
    }
    if (!picked) {
      reason = plan.reason || "无可执行方案";
      break;
    }

    // 执行：买鱼竿（花金砖、得鱼竿）→ 两个任务进度同时推进
    progress[5] = picked.goldAfter;
    progress[3] = picked.fishAfter;
    goldSpent += picked.goldSpend;
    rodsBought += picked.rods;
    if (Number.isFinite(goldStock)) goldStock = Math.max(0, goldStock - picked.goldSpend);
    // 手上的鱼竿已被这一轮计入 freeFish，重置避免下一轮重复抵扣
    if (Number.isFinite(rodStock)) rodStock = 0;

    packs += picked.items;
    const r = openBatch(packs);
    iterations.push({
      kind: "rod",
      label:
        (traded ? "【2换1】" : "") +
        `买 ${picked.rods} 根原价鱼竿（${picked.goldSpend} 金砖）→ ` +
        `金砖任务 ${picked.goldRound}/20 轮、钓鱼 ${picked.fishRound}/20 轮 ` +
        `→ 新得 ${picked.items} 个普通道具`,
      gap,
      needItems,
      traded,
      rods: picked.rods,
      goldSpend: picked.goldSpend,
      goldUnits: picked.goldUnits,
      goldRound: picked.goldRound,
      fishRound: picked.fishRound,
      items: picked.items,
      packs: picked.items,
      gained: r.special,
      special,
      returns: r.returns,
      debt: Math.max(0, target - special),
    });
    packs = 0;
  }

  // ---------------------------------------------------------------- 兜底：补一轮金砖
  /**
   * 🔴 master 2026-09-28 拍板的最后兜底（原话见 `goldTopUp` 注释）。
   *
   * 触发条件：主循环结束仍未达标（迭代上限 / 预算不足等），但金砖**还有档**且
   * 买得起跨过下一轮阈值 —— 此时按「恰好跨过下一轮金砖阈值」买杆
   * （≈ 4 万金砖 → 12 个道具 → 期望 +3 特殊），一轮不够就再来（防御性上限 3 次）。
   *
   * ⚠️ 这里**故意无视 `goldMax`**（它是策略参考线不是硬规则），但**不会越过 50 万**
   * —— `buildRoundTable(5)[20]` 为 undefined 时就是档位真榨干，兜底也无能为力。
   */
  let topups = 0;
  if (goldTopUp) {
    while (special < target && topups < 3) {
      const goldDoneNow = completedRounds(5, progress[5]);
      const nextRow = buildRoundTable(5)[goldDoneNow];
      if (!nextRow) break; // 金砖 20 轮已榨干 → 真·无解
      const goldNow = Math.max(0, Math.floor(Number(progress[5]) || 0));
      const goldNeeded = Math.max(0, nextRow.threshold - goldNow);
      const rods = Math.ceil(goldNeeded / rodPrice);
      const cost = rods * rodPrice;
      if (rods <= 0) break;
      if (Number.isFinite(goldStock) && goldStock < cost) break; // 兜底也买不起
      const fishDoneNow = completedRounds(3, progress[3]);
      const fishNow = Math.max(0, Math.floor(Number(progress[3]) || 0));
      const fishRoomNow = Math.max(0, fishCap - fishNow);
      // 手上若有库存杆（主循环没跑过时可能还在），按 freeFish 口径一并计入钓鱼容量
      const freeFishNow = Math.min(
        Math.max(0, Math.floor(Number(rodStock) || 0)),
        fishesToRods(fishRoomNow, rodReturn),
      );
      const fishPerRod = 1 / Math.max(0.05, 1 - rodReturn);
      const fishAfter = fishNow + Math.min(
        Math.floor((rods + freeFishNow) * fishPerRod),
        fishRoomNow,
      );
      const goldAfter = goldNow + cost;
      const items =
        rewardFromRoundTo(5, goldDoneNow, completedRounds(5, goldAfter)) +
        rewardFromRoundTo(3, fishDoneNow, completedRounds(3, fishAfter));
      const gapBefore = Math.max(0, target - special);
      progress[5] = goldAfter;
      progress[3] = fishAfter;
      goldSpent += cost;
      rodsBought += rods;
      if (Number.isFinite(goldStock)) goldStock -= cost;
      if (Number.isFinite(rodStock)) rodStock = 0; // 库存杆已随本轮计入，防重复抵扣
      packs += items;
      const r = openBatch(packs);
      packs = 0;
      topups += 1;
      iterations.push({
        kind: "topup",
        label:
          `【兜底】补第 ${topups} 轮金砖：买 ${rods} 根原价鱼竿（${cost} 金砖）→ ` +
          `金砖任务 ${completedRounds(5, goldAfter)}/20 轮、钓鱼 ${completedRounds(3, fishAfter)}/20 轮 ` +
          `→ 新得 ${items} 个普通道具`,
        gap: gapBefore,
        rods,
        goldSpend: cost,
        goldRound: completedRounds(5, goldAfter),
        fishRound: completedRounds(3, fishAfter),
        items,
        packs: items,
        gained: r.special,
        special,
        returns: r.returns,
        debt: Math.max(0, target - special),
      });
    }
  }

  if (special >= target) reason = "reached";
  else if (i >= maxIterations) reason = `迭代上限 ${maxIterations} 次`;

  return {
    ok: special >= target,
    special,
    specialGained: special - Math.max(0, Math.floor(Number(options.specialOwned) || 0)),
    packsOpened: iterations.reduce((sum, it) => sum + (it.packs || 0), 0),
    iterations,
    rounds: i,
    reason,
    freeItems,
    goldSpent,
    rodsBought,
    /** 兜底「补一轮金砖」实际执行的轮数（0 = 没触发；master 口径：通常 1 次必够） */
    topups,
    returns: totalReturns,
    strategy,
  };
};

export default {
  ROUNDS_PER_TASK,
  GOLDENFISH_TIERS,
  GOLDENFISH_GOLD_UNIT,
  GOLDENFISH_UNIT_LABELS,
  GOLDENFISH_ROD_PRICE,
  GOLDENFISH_FISH_MIN_TARGET,
  GOLDENFISH_FISH_FULL,
  GOLDENFISH_ROD_RETURN_RATE,
  GOLDENFISH_OBSERVE_GOLD,
  GOLDENFISH_GOLD_TARGET,
  GOLDENFISH_PACK_RETURNS,
  GOLDENFISH_PLATINUM_BOX_DROPS,
  GOLDENFISH_PLATINUM_BOX_HIT_RATE,
  buildRoundTable,
  taskTotals,
  totalRewardAllTasks,
  completedRounds,
  costToReachRound,
  rewardFromRoundTo,
  toMissionId,
  fromMissionId,
  readClaimedMissionIds,
  planClaimSweep,
  createRng,
  GOLDENFISH_PACK_BIAS_MAX,
  GOLDENFISH_PACK_BIAS_WEIGHTS,
  GOLDENFISH_PACK_BIAS_TOTAL,
  packBias,
  openPacks,
  packsNeededForGap,
  goldCostOf,
  openPackReturns,
  planRodPurchase,
  twoForOneCandidate,
  simulateFinish,
};
