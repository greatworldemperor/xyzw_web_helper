import { HERO_DICT } from "@/utils/HeroList";
import { PEACH_TASKS } from "@/utils/PeachTaskIds";
import { executeSmartOpenBox } from "@/utils/smartOpenBox";

/**
 * 开箱、钓鱼、招募类任务
 * 包含: batchOpenBox, batchSmartOpenBox, batchClaimBoxPointReward, batchFish, batchRecruit
 */

/**
 * 创建物品类任务执行器
 * @param {Object} deps - 依赖项
 * @returns {Object} 任务函数集合
 */
export function createTasksItem(deps) {
  const {
    selectedTokens,
    tokens,
    tokenStatus,
    isRunning,
    shouldStop,
    ensureConnection,
    releaseConnectionSlot,
    connectionQueue,
    batchSettings,
    tokenStore,
    sendRoleInfo: batchSendRoleInfo,
    addLog,
    message,
    currentRunningTokenId,
    helperSettings,
    delayConfig,
  } = deps;

  const sendRoleInfo =
    batchSendRoleInfo ||
    ((tokenId, params = {}) =>
      typeof tokenStore.sendGetRoleInfo === "function"
        ? tokenStore.sendGetRoleInfo(tokenId, params)
        : tokenStore.sendMessageWithPromise(
            tokenId,
            "role_getroleinfo",
            params,
          ));

  const boxNames = {
    2001: "木质宝箱",
    2002: "青铜宝箱",
    2003: "黄金宝箱",
    2004: "铂金宝箱",
  };

  const fishNames = { 1: "普通鱼竿", 2: "黄金鱼竿" };

  const heroIds = Object.keys(HERO_DICT).map(Number);

  /**
   * 批量英雄升星
   */
  const batchHeroUpgrade = async () => {
    if (selectedTokens.value.length === 0) return;

    isRunning.value = true;
    shouldStop.value = false;

    selectedTokens.value.forEach((id) => {
      tokenStatus.value[id] = "waiting";
    });

    const taskPromises = selectedTokens.value.map(async (tokenId) => {
      if (shouldStop.value) return;

      tokenStatus.value[tokenId] = "running";
      const token = tokens.value.find((t) => t.id === tokenId);

      try {
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== 开始英雄升星: ${token.name} ===`,
          type: "info",
        });

        await ensureConnection(tokenId);

        for (const heroId of heroIds) {
          if (shouldStop.value) break;

          // 每个英雄尝试最多10次升星（只要成功就继续，失败则跳过该英雄）
          for (let i = 1; i <= 10; i++) {
            if (shouldStop.value) break;

            try {
              const res = await tokenStore.sendMessageWithPromise(
                tokenId,
                "hero_heroupgradestar",
                { heroId },
                5000,
              );
              const ok =
                res &&
                (res.code === 0 || res.success === true || res.result === 0);

              if (ok) {
                addLog({
                  time: new Date().toLocaleTimeString(),
                  message: `${token.name} 英雄ID:${heroId} 升星成功 (第${i}次)`,
                  type: "success",
                });
                // 成功了继续尝试下一级，直到失败或达到10次
              } else {
                // 失败说明无法继续升星（碎片不足或满星），跳出循环处理下一个英雄
                throw new Error("升星失败");
              }
            } catch (err) {
              // 失败则停止当前英雄的升星尝试
              break;
            }
            await new Promise((r) => setTimeout(r, delayConfig.action));
          }
        }

        tokenStatus.value[tokenId] = "completed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} === 英雄升星完成 ===`,
          type: "success",
        });
      } catch (error) {
        console.error(error);
        tokenStatus.value[tokenId] = "failed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `英雄升星失败: ${error.message}`,
          type: "error",
        });
      } finally {
        tokenStore.closeWebSocketConnection(tokenId);
        releaseConnectionSlot();
      }
    });

    await Promise.all(taskPromises);
    isRunning.value = false;
    currentRunningTokenId.value = null;
    message.success("批量英雄升星结束");
  };

  /**
   * 批量图鉴升星
   */
  const batchBookUpgrade = async () => {
    if (selectedTokens.value.length === 0) return;

    isRunning.value = true;
    shouldStop.value = false;

    selectedTokens.value.forEach((id) => {
      tokenStatus.value[id] = "waiting";
    });

    const taskPromises = selectedTokens.value.map(async (tokenId) => {
      if (shouldStop.value) return;

      tokenStatus.value[tokenId] = "running";
      const token = tokens.value.find((t) => t.id === tokenId);

      try {
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== 开始图鉴升星: ${token.name} ===`,
          type: "info",
        });

        await ensureConnection(tokenId);

        for (const heroId of heroIds) {
          if (shouldStop.value) break;

          // 每个英雄尝试最多10次图鉴升星（只要成功就继续，失败则跳过该英雄）
          for (let i = 1; i <= 10; i++) {
            if (shouldStop.value) break;

            try {
              const res = await tokenStore.sendMessageWithPromise(
                tokenId,
                "book_upgrade",
                { heroId },
                5000,
              );
              const ok =
                res &&
                (res.code === 0 || res.success === true || res.result === 0);

              if (ok) {
                addLog({
                  time: new Date().toLocaleTimeString(),
                  message: `${token.name} 英雄ID:${heroId} 图鉴升星成功 (第${i}次)`,
                  type: "success",
                });
                // 成功了继续尝试下一级，直到失败或达到10次
              } else {
                // 失败说明无法继续图鉴升星（碎片不足或满星），跳出循环处理下一个英雄
                throw new Error("图鉴升星失败");
              }
            } catch (err) {
              // 失败则停止当前英雄的图鉴升星尝试
              break;
            }
            await new Promise((r) => setTimeout(r, delayConfig.action));
          }
        }

        tokenStatus.value[tokenId] = "completed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} === 图鉴升星完成 ===`,
          type: "success",
        });
      } catch (error) {
        console.error(error);
        tokenStatus.value[tokenId] = "failed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `图鉴升星失败: ${error.message}`,
          type: "error",
        });
      } finally {
        tokenStore.closeWebSocketConnection(tokenId);
        releaseConnectionSlot();
      }
    });

    await Promise.all(taskPromises);
    isRunning.value = false;
    currentRunningTokenId.value = null;
    message.success("批量图鉴升星结束");
  };

  /**
   * 批量领取图鉴奖励
   */
  const batchClaimStarRewards = async () => {
    if (selectedTokens.value.length === 0) return;

    isRunning.value = true;
    shouldStop.value = false;

    selectedTokens.value.forEach((id) => {
      tokenStatus.value[id] = "waiting";
    });

    const taskPromises = selectedTokens.value.map(async (tokenId) => {
      if (shouldStop.value) return;

      tokenStatus.value[tokenId] = "running";
      const token = tokens.value.find((t) => t.id === tokenId);

      try {
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== 开始领取图鉴奖励: ${token.name} ===`,
          type: "info",
        });

        await ensureConnection(tokenId);

        for (let i = 1; i <= 10; i++) {
          if (shouldStop.value) break;
          try {
            const res = await tokenStore.sendMessageWithPromise(
              tokenId,
              "book_claimpointreward",
              {},
              5000,
            );
            const ok =
              res && (res.code === 0 || res.success === true || res.result === 0);

            if (ok) {
              addLog({
                time: new Date().toLocaleTimeString(),
                message: `${token.name} 领取图鉴奖励成功`,
                type: "success",
              });
            } else {
              // 如果领取失败（比如没有奖励可领了），停止尝试
              throw new Error("领取奖励失败");
            }
          } catch (err) {
            // 失败则停止尝试
            break;
          }
          await new Promise((r) => setTimeout(r, delayConfig.action));
        }

        tokenStatus.value[tokenId] = "completed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} === 领取图鉴奖励完成 ===`,
          type: "success",
        });
      } catch (error) {
        console.error(error);
        tokenStatus.value[tokenId] = "failed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `领取图鉴奖励失败: ${error.message}`,
          type: "error",
        });
      } finally {
        tokenStore.closeWebSocketConnection(tokenId);
        releaseConnectionSlot();
      }
    });

    await Promise.all(taskPromises);
    isRunning.value = false;
    currentRunningTokenId.value = null;
    message.success("批量领取图鉴奖励结束");
  };

  /**
   * 对**单个角色**按序执行「英雄升星 → 图鉴升星 → 领取图鉴奖励」完整链
   * （master 2026-09-28 拍板：因果链 = 英雄升星之后会得到图鉴，图鉴升星之后会得到奖励
   * ⇒ 三步必须按此顺序；且对当前角色一次连接做完，避免按功能遍历角色来回连断触发限流）
   *
   * ⚠️ 调用方必须已 `ensureConnection`；本函数不建立/不关闭连接。
   * 单步循环逻辑与 batchHeroUpgrade / batchBookUpgrade / batchClaimStarRewards 的
   * 单角色部分逐字段一致（升星每英雄最多 10 次：成功继续、失败跳下一个英雄）。
   *
   * @returns {Promise<{heroUp:number, bookUp:number, claims:number}>}
   */
  const runHeroBookChainForToken = async (tokenId, tokenName) => {
    const name = tokenName || tokenId;

    /** 升星循环（cmd + 文案参数化；英雄升星与图鉴升星同构） */
    const upgradeLoop = async (cmd, okLabel, failLabel) => {
      let okCount = 0;
      for (const heroId of heroIds) {
        if (shouldStop.value) break;
        for (let i = 1; i <= 10; i += 1) {
          if (shouldStop.value) break;
          try {
            const res = await tokenStore.sendMessageWithPromise(
              tokenId,
              cmd,
              { heroId },
              5000,
            );
            const ok =
              res &&
              (res.code === 0 || res.success === true || res.result === 0);
            if (!ok) throw new Error(failLabel);
            okCount += 1;
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${name} 英雄ID:${heroId} ${okLabel} (第${i}次)`,
              type: "success",
            });
          } catch (err) {
            // 失败说明该英雄无法继续（碎片不足/满星），停止当前英雄、换下一个
            break;
          }
          await new Promise((r) => setTimeout(r, delayConfig.action));
        }
      }
      return okCount;
    };

    // 第 1 步：英雄升星 —— 升星后才会解锁新的图鉴星级
    addLog({
      time: new Date().toLocaleTimeString(),
      message: `${name} 【1/3】英雄升星开始`,
      type: "info",
    });
    const heroUp = await upgradeLoop(
      "hero_heroupgradestar",
      "升星成功",
      "升星失败",
    );
    addLog({
      time: new Date().toLocaleTimeString(),
      message: `${name} 【1/3】英雄升星完成，共成功 ${heroUp} 次`,
      type: "success",
    });

    // 第 2 步：图鉴升星 —— 英雄升星带来的新图鉴进度在这里兑现
    addLog({
      time: new Date().toLocaleTimeString(),
      message: `${name} 【2/3】图鉴升星开始`,
      type: "info",
    });
    const bookUp = await upgradeLoop("book_upgrade", "图鉴升星成功", "图鉴升星失败");
    addLog({
      time: new Date().toLocaleTimeString(),
      message: `${name} 【2/3】图鉴升星完成，共成功 ${bookUp} 次`,
      type: "success",
    });

    // 第 3 步：领取图鉴奖励 —— 图鉴升星产生的奖励在这里收走
    addLog({
      time: new Date().toLocaleTimeString(),
      message: `${name} 【3/3】领取图鉴奖励开始`,
      type: "info",
    });
    let claims = 0;
    for (let i = 1; i <= 10; i += 1) {
      if (shouldStop.value) break;
      try {
        const res = await tokenStore.sendMessageWithPromise(
          tokenId,
          "book_claimpointreward",
          {},
          5000,
        );
        const ok =
          res && (res.code === 0 || res.success === true || res.result === 0);
        if (!ok) throw new Error("领取奖励失败");
        claims += 1;
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${name} 领取图鉴奖励成功 (第${i}次)`,
          type: "success",
        });
      } catch (err) {
        // 没有更多奖励可领，停止
        break;
      }
      await new Promise((r) => setTimeout(r, delayConfig.action));
    }
    addLog({
      time: new Date().toLocaleTimeString(),
      message: `${name} 【3/3】领取图鉴奖励完成，共成功 ${claims} 次`,
      type: "success",
    });

    return { heroUp, bookUp, claims };
  };

  /**
   * 批量资源升级链：每个角色只连接一次，在同一次连接里按序做完三件事
   * （master 2026-09-28：不是每个功能把所有角色连断一遍 —— 那样角色被来回
   * 切换三次，容易触发限流；而是「正在遍历的当前角色」一次做完再下一个）
   */
  const batchResourceUpgradeChain = async () => {
    if (selectedTokens.value.length === 0) return;

    isRunning.value = true;
    shouldStop.value = false;

    selectedTokens.value.forEach((id) => {
      tokenStatus.value[id] = "waiting";
    });

    const taskPromises = selectedTokens.value.map(async (tokenId) => {
      if (shouldStop.value) return;

      tokenStatus.value[tokenId] = "running";
      const token = tokens.value.find((t) => t.id === tokenId);

      try {
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== 资源升级链开始（英雄升星→图鉴升星→领奖）: ${token.name} ===`,
          type: "info",
        });

        await ensureConnection(tokenId);

        const stats = await runHeroBookChainForToken(tokenId, token.name);
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 资源升级链完成：英雄升星 ${stats.heroUp} / 图鉴升星 ${stats.bookUp} / 领图鉴奖励 ${stats.claims}`,
          type: "success",
        });

        tokenStatus.value[tokenId] = "completed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} === 资源升级链结束 ===`,
          type: "success",
        });
      } catch (error) {
        console.error(error);
        tokenStatus.value[tokenId] = "failed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `资源升级链失败: ${error.message}`,
          type: "error",
        });
      } finally {
        tokenStore.closeWebSocketConnection(tokenId);
        releaseConnectionSlot();
      }
    });

    await Promise.all(taskPromises);
    isRunning.value = false;
    currentRunningTokenId.value = null;
    message.success("资源升级链结束");
  };

  // ---------------------------------------------------------------- 一键清空道具

  /**
   * 🔴 可清空道具清单 = master 30a 抓包（local-data/misc/clear_inventory.jsonl）
   * 里实际开过的 27 种 itemId —— 实证安全清单：
   *   - 3002~3012：英雄碎片包 / 资源包（产出英雄碎片 1xx/2xx/3xx，自动进图鉴进度）
   *   - 35011 / 36001 / 37005 / 40008：杂项礼包
   *   - 5264~5287（52xx 段）：金鱼活动道具 —— ⚠️ **金鱼收尾前勿跑本任务**
   *     （清单含 5287 普通道具 = 召唤金鱼的资源；master 是在「金鱼领光、特殊道具
     *     已够 250」之后才全开的。什么时候跑由 master 自己掌握时机）
   */
  const CLEAR_ITEM_IDS = Object.freeze([
    3002, 3005, 3006, 3007, 3008, 3009, 3010, 3011, 3012,
    35011, 36001, 37005, 40008,
    5264, 5265, 5268, 5269, 5271, 5272, 5273, 5275, 5276, 5277, 5279, 5280,
    5283, 5287,
  ]);

  /**
   * 🔴 保护名单（代码层最后防线）：这些**永不清空**，即使被误加进清单。
   * 5286 = 金鱼特殊道具（兑换金鱼的硬通货）/ 1013 = 珍珠 / 1001 = 招募令 /
   * 1012 = 黄金鱼竿 / 2001~2005 = 宝箱（开箱任务的原材料）。
   */
  const PROTECTED_ITEM_IDS = Object.freeze(new Set([
    5286, 1013, 1001, 1012, 2001, 2002, 2003, 2004, 2005,
  ]));

  /** 🔴 item_openpack 单次 number 上限 = **999**（master 2026-09-28 强调；抓包实证 3005 开 6207 = 6×999 + 213） */
  const ITEM_OPENPACK_MAX_PER_CALL = 999;

  /**
   * 一键清空道具：把背包里清单内道具全部用掉（资源兑现）
   *
   * 流程：role_getroleinfo 拿背包 → 对「清单 ∩ 背包持有」的每种道具按
   * ceil(数量 / 999) 分批发 item_openpack（单次上限 999，见上）。
   */
  const batchClearItems = async () => {
    if (selectedTokens.value.length === 0) return;

    isRunning.value = true;
    shouldStop.value = false;

    selectedTokens.value.forEach((id) => {
      tokenStatus.value[id] = "waiting";
    });

    const taskPromises = selectedTokens.value.map(async (tokenId) => {
      if (shouldStop.value) return;

      tokenStatus.value[tokenId] = "running";
      const token = tokens.value.find((t) => t.id === tokenId);

      try {
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== 开始清空道具: ${token.name} ===`,
          type: "info",
        });

        await ensureConnection(tokenId);

        // 1) 拿背包快照（role.items: { [itemId]: { quantity } }）
        const roleInfo = await sendRoleInfo(tokenId);
        const bagItems = roleInfo?.role?.items || {};

        // 2) 逐清单项：按持有量分批（单次 ≤999）开掉
        let totalKinds = 0;
        let totalBatches = 0;
        let totalCount = 0;
        for (const itemId of CLEAR_ITEM_IDS) {
          if (shouldStop.value) break;
          if (PROTECTED_ITEM_IDS.has(itemId)) continue; // 双保险，理论上不会命中

          const quantity = Math.floor(
            Number(bagItems[String(itemId)]?.quantity) || 0,
          );
          if (quantity <= 0) continue;

          let left = quantity;
          while (left > 0 && !shouldStop.value) {
            const batch = Math.min(ITEM_OPENPACK_MAX_PER_CALL, left);
            await tokenStore.sendMessageWithPromise(
              tokenId,
              "item_openpack",
              { itemId, number: batch, index: 0 },
              5000,
            );
            left -= batch;
            totalBatches += 1;
            totalCount += batch;
            await new Promise((r) => setTimeout(r, delayConfig.action));
          }

          totalKinds += 1;
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} itemId ${itemId} 已用 ${quantity} 个（${Math.ceil(quantity / ITEM_OPENPACK_MAX_PER_CALL)} 批）`,
            type: "success",
          });
        }

        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 清空道具完成：${totalKinds} 种 / ${totalBatches} 批 / 共 ${totalCount} 个`,
          type: "success",
        });

        tokenStatus.value[tokenId] = "completed";
      } catch (error) {
        console.error(error);
        tokenStatus.value[tokenId] = "failed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `清空道具失败: ${error.message}`,
          type: "error",
        });
      } finally {
        tokenStore.closeWebSocketConnection(tokenId);
        releaseConnectionSlot();
      }
    });

    await Promise.all(taskPromises);
    isRunning.value = false;
    currentRunningTokenId.value = null;
    message.success("批量清空道具结束");
  };

  /**
   * 领取宝箱积分
   */
  const batchClaimBoxPointReward = async () => {
    if (selectedTokens.value.length === 0) return;

    isRunning.value = true;
    shouldStop.value = false;

    selectedTokens.value.forEach((id) => {
      tokenStatus.value[id] = "waiting";
    });

    const taskPromises = selectedTokens.value.map(async (tokenId) => {
      if (shouldStop.value) return;

      tokenStatus.value[tokenId] = "running";

      const token = tokens.value.find((t) => t.id === tokenId);

      try {
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== 开始领取宝箱积分: ${token.name} ===`,
          type: "info",
        });

        await ensureConnection(tokenId);

        await tokenStore.sendMessageWithPromise(
          tokenId,
          "item_batchclaimboxpointreward",
          {},
          5000,
        );
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 宝箱积分领取成功`,
          type: "success",
        });

        await sendRoleInfo(tokenId);
        tokenStatus.value[tokenId] = "completed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} === 领取完成 ===`,
          type: "success",
        });
      } catch (error) {
        console.error(error);
        tokenStatus.value[tokenId] = "failed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `领取失败: ${error.message}`,
          type: "error",
        });
      } finally {
        tokenStore.closeWebSocketConnection(tokenId);
        releaseConnectionSlot();
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 连接已关闭  (队列: ${connectionQueue.active}/${batchSettings.maxActive})`,
          type: "info",
        });
      }
    });

    await Promise.all(taskPromises);

    isRunning.value = false;
    currentRunningTokenId.value = null;
    message.success("批量领取宝箱积分结束");
  };

  /**
   * 批量智能开箱：钻石宝箱+积分足够时优先兑换并打开钻石宝箱，否则回退木质宝箱
   */
  const batchSmartOpenBox = async () => {
    if (selectedTokens.value.length === 0) return;

    isRunning.value = true;
    shouldStop.value = false;

    selectedTokens.value.forEach((id) => {
      tokenStatus.value[id] = "waiting";
    });

    const taskPromises = selectedTokens.value.map(async (tokenId) => {
      if (shouldStop.value) return;

      tokenStatus.value[tokenId] = "running";
      const token = tokens.value.find((t) => t.id === tokenId);

      try {
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== 开始智能开箱: ${token.name} ===`,
          type: "info",
        });

        await ensureConnection(tokenId);

        await executeSmartOpenBox({
          getRoleInfo: async () => {
            const res = await sendRoleInfo(tokenId, {}, 5000, "获取智能开箱信息");
            return res?.role || res?.data?.role || {};
          },
          sendCommand: (cmd, params, description) =>
            tokenStore.sendMessageWithPromise(tokenId, cmd, params, 8000),
          log: (msg, type) =>
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} ${msg}`,
              type: type || "info",
            }),
        });

        await sendRoleInfo(tokenId);
        tokenStatus.value[tokenId] = "completed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== ${token.name} 智能开箱完成 ===`,
          type: "success",
        });
      } catch (error) {
        console.error(error);
        tokenStatus.value[tokenId] = "failed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `智能开箱失败: ${error.message}`,
          type: "error",
        });
      } finally {
        tokenStore.closeWebSocketConnection(tokenId);
        releaseConnectionSlot();
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 连接已关闭  (队列: ${connectionQueue.active}/${batchSettings.maxActive})`,
          type: "info",
        });
      }
    });

    await Promise.all(taskPromises);

    isRunning.value = false;
    currentRunningTokenId.value = null;
    message.success("批量智能开箱结束");
  };

  /**
   * 批量领取蟠桃园任务
   */
  const batchClaimPeachTasks = async () => {
    if (selectedTokens.value.length === 0) return;

    isRunning.value = true;
    shouldStop.value = false;

    selectedTokens.value.forEach((id) => {
      tokenStatus.value[id] = "waiting";
    });

    const taskPromises = selectedTokens.value.map(async (tokenId) => {
      if (shouldStop.value) return;

      tokenStatus.value[tokenId] = "running";
      const token = tokens.value.find((t) => t.id === tokenId);

      try {
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== 开始领取蟠桃园任务奖励: ${token.name} ===`,
          type: "info",
        });

        await ensureConnection(tokenId);

        const res = await tokenStore.sendMessageWithPromise(
          tokenId,
          "legion_getpayloadtask",
          {},
          5000
        );

        const payloadTask = res?.payloadTask || res?.data?.payloadTask;

        if (payloadTask && payloadTask.taskMap) {
          const taskMap = payloadTask.taskMap;
          const tasks = [];
          Object.values(taskMap).forEach((item) => {
            const availableTasks = PEACH_TASKS.filter(
              (t) =>
                t.type === item.typ &&
                item.progress >= t.target &&
                item.claimedProgress < t.target,
            );
            tasks.push(...availableTasks);
          });

          let claimedCount = 0;

          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 获取到 ${tasks.length} 个任务奖励`,
            type: "info",
          });

          for (const task of tasks) {
            if (shouldStop.value) break;
            // status not reliable or not present, try claim all
            try {
              const claimRes = await tokenStore.sendMessageWithPromise(
                tokenId,
                "legion_claimpayloadtask",
                { taskId: task.id },
                5000
              );
              const ok = claimRes && claimRes.payloadTask;
              if (ok) {
                claimedCount++;
                addLog({
                  time: new Date().toLocaleTimeString(),
                  message: `${token.name} 领取${task.desc}任务奖励成功`,
                  type: "success",
                });
              }

            } catch (err) {
              // ignore
            }
            await new Promise((r) => setTimeout(r, delayConfig.action));
          }

          // Check and claim point rewards (Moved out of loop to ensure execution)
          try {
            const progressMapres = await tokenStore.sendMessageWithPromise(
              tokenId,
              "legion_getpayloadtask",
              {},
              5000
            );
            
            if (progressMapres && progressMapres.payloadTask) {
                const legionPoint = progressMapres.payloadTask.legionPoint || 0;
                const selfPoint = progressMapres.payloadTask.selfPoint || 0;
                // progressMap key might be string or number, handle both safely
                const progressMap = progressMapres.payloadTask.progressMap || {};
                const taskGroupprogressMap = progressMap[1] || progressMap["1"] || 0;
                const selfPointprogressMap = progressMap[2] || progressMap["2"] || 0;

                // Club Rewards - Claim all if progress is greater than claimed progress
                if (legionPoint > taskGroupprogressMap && taskGroupprogressMap < 25) {
                  try {
                    await tokenStore.sendMessageWithPromise(
                      tokenId,
                      "legion_claimpayloadtaskprogress",
                      { taskGroup: 1 },
                      5000
                    );
                    addLog({
                      time: new Date().toLocaleTimeString(),
                      message: `${token.name} 领取俱乐部任务奖励 (当前积分: ${legionPoint})`,
                      type: "success",
                    });
                    await new Promise((r) => setTimeout(r, 1000));
                  } catch (e) {
                    addLog({
                      time: new Date().toLocaleTimeString(),
                      message: `${token.name} 领取俱乐部任务奖励失败: ${e.message}`,
                      type: "error",
                    });
                  }
                }

                // Personal Rewards - Claim all if progress is greater than claimed progress
                if (selfPoint > selfPointprogressMap && selfPointprogressMap < 25) {
                  try {
                    await tokenStore.sendMessageWithPromise(
                      tokenId,
                      "legion_claimpayloadtaskprogress",
                      { taskGroup: 2 },
                      5000
                    );
                    addLog({
                      time: new Date().toLocaleTimeString(),
                      message: `${token.name} 领取个人任务奖励 (当前积分: ${selfPoint})`,
                      type: "success",
                    });
                    await new Promise((r) => setTimeout(r, 1000));
                  } catch (e) {
                    addLog({
                      time: new Date().toLocaleTimeString(),
                      message: `${token.name} 领取个人任务奖励失败: ${e.message}`,
                      type: "error",
                    });
                  }
                }
            }
          } catch (err) {
             console.error("领取蟠桃园积分奖励异常:", err);
             addLog({
               time: new Date().toLocaleTimeString(),
               message: `${token.name} 领取积分奖励异常: ${err.message}`,
               type: "error",
             });
          }

          if (claimedCount === 0) {
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} 没有可领取的任务奖励`,
              type: "info",
            });
          }

        } else {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 未获取到任务奖励列表`,
            type: "warning",
          });
        }

        tokenStatus.value[tokenId] = "completed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} === 领取蟠桃园任务奖励完成 ===`,
          type: "success",
        });
      } catch (error) {
        console.error(error);
        tokenStatus.value[tokenId] = "failed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 领取蟠桃园任务奖励失败: ${error.message}`,
          type: "error",
        });
      } finally {
        tokenStore.closeWebSocketConnection(tokenId);
        releaseConnectionSlot();
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 连接已关闭  (队列: ${connectionQueue.active}/${batchSettings.maxActive})`,
          type: "info",
        });
      }
    });

    await Promise.all(taskPromises);

    isRunning.value = false;
    currentRunningTokenId.value = null;
    message.success("批量领取蟠桃园任务奖励结束");
  };

  /**
   * 一键灯神扫荡
   */
  const batchGenieSweep = async () => {
    if (selectedTokens.value.length === 0) return;

    isRunning.value = true;
    shouldStop.value = false;

    selectedTokens.value.forEach((id) => {
      tokenStatus.value[id] = "waiting";
    });

    const taskPromises = selectedTokens.value.map(async (tokenId) => {
      if (shouldStop.value) return;

      tokenStatus.value[tokenId] = "running";
      const token = tokens.value.find((t) => t.id === tokenId);

      try {
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== 开始灯神扫荡: ${token.name} ===`,
          type: "info",
        });

        await ensureConnection(tokenId);

        // 获取最新角色信息
        const roleInfoRes = await sendRoleInfo(tokenId, {}, 5000, "获取灯神扫荡信息");
        
        // 解析灯神进度和扫荡券
        const role = roleInfoRes?.role || roleInfoRes?.data?.role || {};
        const genieData = role.genie || {};
        // 扫荡券 ID 1021
        const sweepTicketCount = role.items?.[1021]?.quantity || 0;

        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 当前扫荡券数量: ${sweepTicketCount}`,
          type: "info",
        });

        if (sweepTicketCount <= 0) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 扫荡券不足，停止扫荡`,
            type: "warning",
          });
          tokenStatus.value[tokenId] = "completed";
          return;
        }

        // 计算最高层数
        // 1-4: 魏蜀吴群 (0-16 -> 1-17层)
        // 5: 深海 (0-9 -> 1-10层)
        let maxLayer = -1;
        let bestGenieId = -1;

        // 检查魏蜀吴群 (1-4)
        for (let i = 1; i <= 4; i++) {
          if (genieData[i] !== undefined) {
            // 数据值 0 代表 1 层? 用户说 0-16 代表 1-17 层
            // 假设 genieData[i] 是已通过的层数索引
            const currentLayer = genieData[i] + 1;
            if (currentLayer > maxLayer) {
              maxLayer = currentLayer;
              bestGenieId = i;
            }
          }
        }

        if (bestGenieId === -1) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 未找到可扫荡的灯神关卡`,
            type: "warning",
          });
          tokenStatus.value[tokenId] = "completed";
          return;
        }

        const genieNames = { 1: "魏国", 2: "蜀国", 3: "吴国", 4: "群雄", 5: "深海" };
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 扫荡: ${genieNames[bestGenieId]}灯神 (第${maxLayer}层)`,
          type: "info",
        });

        // 开始扫荡
        let remainingTickets = sweepTicketCount;
        
        while (remainingTickets > 0 && !shouldStop.value) {
          const sweepCnt = Math.min(remainingTickets, 20);
          
          try {
            const res = await tokenStore.sendMessageWithPromise(
              tokenId,
              "genie_sweep",
              { 
                genieId: bestGenieId,
                sweepCnt: sweepCnt 
              },
              5000
            );

            const ok = res && (res.role || res.role.items);
            
            if (ok) {
               addLog({
                time: new Date().toLocaleTimeString(),
                message: `${token.name} 扫荡成功 ${sweepCnt} 次`,
                type: "success",
              });
              remainingTickets = res.role.items?.[1021]?.quantity || 0;
            } else {
               addLog({
                time: new Date().toLocaleTimeString(),
                message: `${token.name} 扫荡失败: ${res.hint || "未知错误"}`,
                type: "error",
              });
              break; // 失败则停止
            }
          } catch (err) {
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} 扫荡请求异常: ${err.message}`,
              type: "error",
            });
            break;
          }

          if (remainingTickets > 0) {
             await new Promise((r) => setTimeout(r, delayConfig.action));
          }
        }

        // 刷新信息
        await sendRoleInfo(tokenId);
        tokenStatus.value[tokenId] = "completed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} === 灯神扫荡完成 ===`,
          type: "success",
        });

      } catch (error) {
        console.error(error);
        tokenStatus.value[tokenId] = "failed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `灯神扫荡失败: ${error.message}`,
          type: "error",
        });
      } finally {
        tokenStore.closeWebSocketConnection(tokenId);
        releaseConnectionSlot();
      }
    });

    await Promise.all(taskPromises);

    isRunning.value = false;
    currentRunningTokenId.value = null;
    message.success("一键灯神扫荡结束");
  };

  const batchOpenBox = async (isScheduledTask = false) => {
    if (selectedTokens.value.length === 0) return;

    isRunning.value = true;
    shouldStop.value = false;

    const boxType = isScheduledTask
      ? batchSettings.defaultBoxType
      : helperSettings.boxType;
    const totalCount = isScheduledTask
      ? batchSettings.boxCount
      : helperSettings.count;
    const batches = Math.floor(totalCount / 10);
    const remainder = totalCount % 10;

    selectedTokens.value.forEach((id) => {
      tokenStatus.value[id] = "waiting";
    });

    const taskPromises = selectedTokens.value.map(async (tokenId) => {
      if (shouldStop.value) return;

      tokenStatus.value[tokenId] = "running";

      const token = tokens.value.find((t) => t.id === tokenId);

      try {
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== 开始批量开箱: ${token.name} ===`,
          type: "info",
        });
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 宝箱类型: ${boxNames[boxType]}, 数量: ${totalCount}`,
          type: "info",
        });

        await ensureConnection(tokenId);

        for (let i = 0; i < batches && !shouldStop.value; i++) {
          await tokenStore.sendMessageWithPromise(
            tokenId,
            "item_openbox",
            { itemId: boxType, number: 10 },
            5000,
          );
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 开箱进度: ${(i + 1) * 10}/${totalCount}`,
            type: "info",
          });
          await new Promise((r) => setTimeout(r, delayConfig.action));
        }

        if (remainder > 0 && !shouldStop.value) {
          await tokenStore.sendMessageWithPromise(
            tokenId,
            "item_openbox",
            { itemId: boxType, number: remainder },
            5000,
          );
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 开箱进度: ${totalCount}/${totalCount}`,
            type: "info",
          });
        }
        await tokenStore.sendMessageWithPromise(
          tokenId,
          "item_batchclaimboxpointreward",
        );
        await new Promise((r) => setTimeout(r, delayConfig.action));
        await sendRoleInfo(tokenId);
        tokenStatus.value[tokenId] = "completed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== ${token.name} 开箱完成 ===`,
          type: "success",
        });
      } catch (error) {
        console.error(error);
        tokenStatus.value[tokenId] = "failed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `开箱失败: ${error.message}`,
          type: "error",
        });
      } finally {
        tokenStore.closeWebSocketConnection(tokenId);
        releaseConnectionSlot();
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 连接已关闭  (队列: ${connectionQueue.active}/${batchSettings.maxActive})`,
          type: "info",
        });
      }
    });

    await Promise.all(taskPromises);

    isRunning.value = false;
    currentRunningTokenId.value = null;
    message.success("批量开箱结束");
  };

  /**
   * 批量钓鱼
   */
  const batchFish = async (isScheduledTask = false) => {
    if (selectedTokens.value.length === 0) return;

    isRunning.value = true;
    shouldStop.value = false;

    const fishType = isScheduledTask
      ? batchSettings.defaultFishType
      : helperSettings.fishType;
    const totalCount = isScheduledTask
      ? batchSettings.fishCount
      : helperSettings.count;
    const batches = Math.floor(totalCount / 10);
    const remainder = totalCount % 10;

    selectedTokens.value.forEach((id) => {
      tokenStatus.value[id] = "waiting";
    });

    const taskPromises = selectedTokens.value.map(async (tokenId) => {
      if (shouldStop.value) return;

      tokenStatus.value[tokenId] = "running";

      const token = tokens.value.find((t) => t.id === tokenId);

      try {
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== 开始批量钓鱼: ${token.name} ===`,
          type: "info",
        });
        
        await ensureConnection(tokenId);

        // 检查鱼竿数量
        let role = tokenStore.gameData?.roleInfo?.role;
        if (!role) {
           const roleInfo = await sendRoleInfo(tokenId);
           role = roleInfo?.role;
        }
        // 普通鱼竿: 1011, 黄金鱼竿: 1012
        const rodId = fishType === 1 ? 1011 : 1012;
        const rodCount = role?.items?.[rodId]?.quantity || 0;

        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 鱼竿类型: ${fishNames[fishType]}, 目标数量: ${totalCount}, 当前库存: ${rodCount}`,
          type: "info",
        });

        let availableCount = totalCount;
        if (rodCount < totalCount) {
             addLog({
                time: new Date().toLocaleTimeString(),
                message: `${token.name} 库存不足 (${rodCount} < ${totalCount})，将仅消耗现有库存`,
                type: "warning",
             });
             availableCount = rodCount;
        }

        if (availableCount <= 0) {
            addLog({
                time: new Date().toLocaleTimeString(),
                message: `${token.name} 没有可用的鱼竿，停止任务`,
                type: "warning",
            });
            tokenStatus.value[tokenId] = "completed";
            return;
        }

        const batches = Math.floor(availableCount / 10);
        const remainder = availableCount % 10;

        for (let i = 0; i < batches && !shouldStop.value; i++) {
          await tokenStore.sendMessageWithPromise(
            tokenId,
            "artifact_lottery",
            { type: fishType, lotteryNumber: 10, newFree: true },
            5000,
          );
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 钓鱼进度: ${(i + 1) * 10}/${availableCount}`,
            type: "info",
          });

          // 每5轮（50次）后，重新校验鱼竿数量
          if ((i + 1) % 5 === 0 && i < batches - 1) {
             try {
                const roleRes = await sendRoleInfo(
                  tokenId,
                  {},
                  5000,
                  "同步鱼竿数量",
                );
                const currentRole = roleRes?.role || roleRes?.data?.role;
                if (currentRole) {
                    const currentRodCount = currentRole.items?.[rodId]?.quantity || 0;
                    
                    // 剩余需要的次数 (不包括当前这轮，因为i已经执行完了，所以剩余次数是 (batches - 1 - i) * 10 + remainder)
                    // 但实际上我们只需要知道下一轮是否有足够的鱼竿
                    // 如果当前库存少于10，说明下一轮可能不够，或者整个任务不够
                    // 重新计算 availableCount 可能会比较复杂，因为循环是基于 batches
                    
                    if (currentRodCount < 10) {
                        addLog({
                            time: new Date().toLocaleTimeString(),
                            message: `${token.name} 同步后发现鱼竿不足 (${currentRodCount} < 10)，停止后续批量任务`,
                            type: "warning",
                        });
                        // 强制停止
                        break; 
                    }
                }
             } catch (e) {
               if (e?.code === "ROLE_INFO_RECOVERY_FAILED") throw e;
                 // ignore
             }
          }

          await new Promise((r) => setTimeout(r, delayConfig.action));
        }

        if (remainder > 0 && !shouldStop.value) {
          await tokenStore.sendMessageWithPromise(
            tokenId,
            "artifact_lottery",
            { type: fishType, lotteryNumber: remainder, newFree: true },
            5000,
          );
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 钓鱼进度: ${availableCount}/${availableCount}`,
            type: "info",
          });
        }
        // 自动领取鱼竿累计奖励
        try {
           const roleRes = await sendRoleInfo(
             tokenId,
             {},
             5000,
             "获取鱼竿累计奖励信息",
           );
           const currentRole = roleRes?.role || roleRes?.data?.role;
           if (currentRole) {
              const points = currentRole.statistics?.["artifact:point"] || 0;
              const exchangeCount = Math.floor(points / 20);
              
              if (exchangeCount > 0) {
                 addLog({
                    time: new Date().toLocaleTimeString(),
                    message: `${token.name} 检测到鱼竿累计使用 ${points}，开始领取 ${exchangeCount} 次累计奖励`,
                    type: "info",
                 });
                 
                 for (let k = 0; k < exchangeCount && !shouldStop.value; k++) {
                    try {
                       await tokenStore.sendMessageWithPromise(
                         tokenId,
                         "artifact_exchange",
                         {},
                         3000
                       );
                       // 走配置的发送间隔（2026-09-28 默认 0；不再硬编码 500ms，限流交给统一弹窗）
                       await new Promise((r) =>
                         setTimeout(r, Math.max(0, Number(delayConfig?.action) || 0)),
                       ); 
                    } catch (err) {
                       addLog({
                          time: new Date().toLocaleTimeString(),
                          message: `${token.name} 领取累计奖励失败 (第${k+1}次): ${err.message}`,
                          type: "warning",
                       });
                       break; // 如果出错可能是不满足条件，停止领取
                    }
                 }
                 addLog({
                    time: new Date().toLocaleTimeString(),
                    message: `${token.name} 累计奖励领取结束`,
                    type: "success",
                 });
              }
           }
          } catch (e) {
            if (e?.code === "ROLE_INFO_RECOVERY_FAILED") throw e;
           addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} 检查累计奖励失败: ${e.message}`,
              type: "warning",
           });
        }

        tokenStatus.value[tokenId] = "completed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} === 钓鱼完成 ===`,
          type: "success",
        });
      } catch (error) {
        console.error(error);
        tokenStatus.value[tokenId] = "failed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `钓鱼失败: ${error.message}`,
          type: "error",
        });
      } finally {
        tokenStore.closeWebSocketConnection(tokenId);
        releaseConnectionSlot();
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 连接已关闭  (队列: ${connectionQueue.active}/${batchSettings.maxActive})`,
          type: "info",
        });
      }
    });

    await Promise.all(taskPromises);

    isRunning.value = false;
    currentRunningTokenId.value = null;
    message.success("批量钓鱼结束");
  };

  /**
   * 批量招募
   */
  const batchRecruit = async (isScheduledTask = false) => {
    if (selectedTokens.value.length === 0) return;

    isRunning.value = true;
    shouldStop.value = false;

    const totalCount = isScheduledTask
      ? batchSettings.recruitCount
      : helperSettings.count;
    const batches = Math.floor(totalCount / 10);
    const remainder = totalCount % 10;

    selectedTokens.value.forEach((id) => {
      tokenStatus.value[id] = "waiting";
    });

    const taskPromises = selectedTokens.value.map(async (tokenId) => {
      if (shouldStop.value) return;

      tokenStatus.value[tokenId] = "running";

      const token = tokens.value.find((t) => t.id === tokenId);

      try {
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== 开始批量招募: ${token.name} ===`,
          type: "info",
        });
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 招募数量: ${totalCount}`,
          type: "info",
        });

        await ensureConnection(tokenId);

        for (let i = 0; i < batches && !shouldStop.value; i++) {
          await tokenStore.sendMessageWithPromise(
            tokenId,
            "hero_recruit",
            { recruitType: 1, recruitNumber: 10 },
            5000,
          );
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `招募进度: ${(i + 1) * 10}/${totalCount}`,
            type: "info",
          });
          await new Promise((r) => setTimeout(r, delayConfig.action));
        }

        if (remainder > 0 && !shouldStop.value) {
          await tokenStore.sendMessageWithPromise(
            tokenId,
            "hero_recruit",
            { recruitType: 1, recruitNumber: remainder },
            5000,
          );
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `招募进度: ${totalCount}/${totalCount}`,
            type: "info",
          });
        }

        await sendRoleInfo(tokenId);
        tokenStatus.value[tokenId] = "completed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== ${token.name} 招募完成 ===`,
          type: "success",
        });
      } catch (error) {
        console.error(error);
        tokenStatus.value[tokenId] = "failed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `招募失败: ${error.message}`,
          type: "error",
        });
      } finally {
        tokenStore.closeWebSocketConnection(tokenId);
        releaseConnectionSlot();
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 连接已关闭  (队列: ${connectionQueue.active}/${batchSettings.maxActive})`,
          type: "info",
        });
      }
    });

    await Promise.all(taskPromises);

    isRunning.value = false;
    currentRunningTokenId.value = null;
    message.success("批量招募结束");
  };

  const batchOpenBoxByPoints = async (isScheduledTask = false) => {
    if (selectedTokens.value.length === 0) return;

    isRunning.value = true;
    shouldStop.value = false;

    const targetPoints = isScheduledTask
      ? batchSettings.targetBoxPoints
      : helperSettings.targetPoints;

    const boxPriority = [
      { id: 2001, name: "木质宝箱", points: 1, reserve: 200 },
      { id: 2002, name: "青铜宝箱", points: 10, reserve: 0 },
      { id: 2003, name: "黄金宝箱", points: 20, reserve: 0 },
      { id: 2004, name: "铂金宝箱", points: 50, reserve: 0 },
    ];

    selectedTokens.value.forEach((id) => {
      tokenStatus.value[id] = "waiting";
    });

    const taskPromises = selectedTokens.value.map(async (tokenId) => {
      if (shouldStop.value) return;

      tokenStatus.value[tokenId] = "running";
      const token = tokens.value.find((t) => t.id === tokenId);

      try {
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== 开始按积分开箱: ${token.name} ===`,
          type: "info",
        });
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 目标积分: ${targetPoints}`,
          type: "info",
        });

        await ensureConnection(tokenId);

        const roleInfoRes = await sendRoleInfo(tokenId, {}, 5000, "获取积分开箱信息");
        const role = roleInfoRes?.role || roleInfoRes?.data?.role || {};
        const items = role.items || {};

        const boxInventory = {};
        let totalAvailablePoints = 0;

        for (const box of boxPriority) {
          const count = items[box.id]?.quantity || 0;
          boxInventory[box.id] = count;
          totalAvailablePoints += count * box.points;
        }

        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 箱子库存: 木质=${boxInventory[2001]}, 青铜=${boxInventory[2002]}, 黄金=${boxInventory[2003]}, 铂金=${boxInventory[2004]}`,
          type: "info",
        });
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 可获得总积分: ${totalAvailablePoints}`,
          type: "info",
        });

        if (totalAvailablePoints < targetPoints) {
          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 积分不足! 需要 ${targetPoints}, 可获得 ${totalAvailablePoints}`,
            type: "error",
          });
          tokenStatus.value[tokenId] = "failed";
          return;
        }

        const boxToOpen = {};
        let remainingPoints = targetPoints;

        const woodenAvailable = boxInventory[2001] - 200;
        if (woodenAvailable >= 10) {
          const woodenPoints = woodenAvailable * 1;
          const pointsNeeded = Math.min(woodenPoints, remainingPoints);
          let woodenToOpen = Math.min(pointsNeeded, woodenAvailable);
          woodenToOpen = Math.floor(woodenToOpen / 10) * 10;
          if (woodenToOpen === 0 && woodenAvailable >= 10 && pointsNeeded > 0) {
            woodenToOpen = 10;
          }
          
          if (woodenToOpen >= 10) {
            boxToOpen[2001] = woodenToOpen;
            remainingPoints -= woodenToOpen * 1;
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} 计划开 木质宝箱: ${woodenToOpen} 个 (积分: ${woodenToOpen})`,
              type: "info",
            });
          }
        }

        if (remainingPoints > 0) {
          const bronzeAvailable = Math.floor(boxInventory[2002] / 10) * 10;
          const goldAvailable = Math.floor(boxInventory[2003] / 10) * 10;
          const platinumAvailable = Math.floor(boxInventory[2004] / 10) * 10;
          const woodenTotal = Math.floor(boxInventory[2001] / 10) * 10;

          let bestResult = null;
          let minWaste = Infinity;

          for (let bronze = 0; bronze <= bronzeAvailable; bronze += 10) {
            const bronzePoints = bronze * 10;
            if (bronzePoints > remainingPoints) break;
            
            for (let gold = 0; gold <= goldAvailable; gold += 10) {
              const goldPoints = gold * 20;
              if (bronzePoints + goldPoints > remainingPoints) break;
              
              const afterBronzeGold = remainingPoints - bronzePoints - goldPoints;
              
              for (let platinum = 0; platinum <= platinumAvailable; platinum += 10) {
                const platinumPoints = platinum * 50;
                if (platinumPoints > afterBronzeGold) break;
                
                const afterPlatinum = afterBronzeGold - platinumPoints;
                
                let wooden = 0;
                if (afterPlatinum > 0) {
                  wooden = Math.ceil(afterPlatinum / 10) * 10;
                  if (wooden > woodenTotal || wooden > 100) continue;
                }
                
                const totalPoints = bronzePoints + goldPoints + platinumPoints + wooden;
                const waste = totalPoints - targetPoints;
                
                if (waste >= 0 && waste < minWaste) {
                  minWaste = waste;
                  bestResult = { bronze, gold, platinum, wooden, totalPoints };
                  if (waste === 0) break;
                }
              }
              if (minWaste === 0) break;
            }
            if (minWaste === 0) break;
          }

          if (bestResult) {
            if (bestResult.bronze > 0) {
              boxToOpen[2002] = bestResult.bronze;
              addLog({
                time: new Date().toLocaleTimeString(),
                message: `${token.name} 计划开 青铜宝箱: ${bestResult.bronze} 个 (积分: ${bestResult.bronze * 10})`,
                type: "info",
              });
            }
            if (bestResult.gold > 0) {
              boxToOpen[2003] = bestResult.gold;
              addLog({
                time: new Date().toLocaleTimeString(),
                message: `${token.name} 计划开 黄金宝箱: ${bestResult.gold} 个 (积分: ${bestResult.gold * 20})`,
                type: "info",
              });
            }
            if (bestResult.platinum > 0) {
              boxToOpen[2004] = bestResult.platinum;
              addLog({
                time: new Date().toLocaleTimeString(),
                message: `${token.name} 计划开 铂金宝箱: ${bestResult.platinum} 个 (积分: ${bestResult.platinum * 50})`,
                type: "info",
              });
            }
            if (bestResult.wooden > 0) {
              boxToOpen[2001] = (boxToOpen[2001] || 0) + bestResult.wooden;
              addLog({
                time: new Date().toLocaleTimeString(),
                message: `${token.name} 计划开 木质宝箱: ${bestResult.wooden} 个 (积分: ${bestResult.wooden})`,
                type: "info",
              });
            }
            remainingPoints = 0;
          }
        }

        for (const box of boxPriority) {
          if (shouldStop.value) break;

          const count = boxToOpen[box.id] || 0;
          if (count <= 0) continue;

          const batches = Math.floor(count / 10);
          const remainder = count % 10;

          addLog({
            time: new Date().toLocaleTimeString(),
            message: `${token.name} 开始开 ${box.name}: ${count} 个`,
            type: "info",
          });

          for (let i = 0; i < batches && !shouldStop.value; i++) {
            await tokenStore.sendMessageWithPromise(
              tokenId,
              "item_openbox",
              { itemId: box.id, number: 10 },
              5000,
            );
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} ${box.name} 开箱进度: ${(i + 1) * 10}/${count}`,
              type: "info",
            });
            await new Promise((r) => setTimeout(r, delayConfig.action));
          }

          if (remainder > 0 && !shouldStop.value) {
            await tokenStore.sendMessageWithPromise(
              tokenId,
              "item_openbox",
              { itemId: box.id, number: remainder },
              5000,
            );
            addLog({
              time: new Date().toLocaleTimeString(),
              message: `${token.name} ${box.name} 开箱进度: ${count}/${count}`,
              type: "info",
            });
          }
        }

        await sendRoleInfo(tokenId);
        tokenStatus.value[tokenId] = "completed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `=== ${token.name} 按积分开箱完成 ===`,
          type: "success",
        });
      } catch (error) {
        console.error(error);
        tokenStatus.value[tokenId] = "failed";
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `按积分开箱失败: ${error.message}`,
          type: "error",
        });
      } finally {
        tokenStore.closeWebSocketConnection(tokenId);
        releaseConnectionSlot();
        addLog({
          time: new Date().toLocaleTimeString(),
          message: `${token.name} 连接已关闭  (队列: ${connectionQueue.active}/${batchSettings.maxActive})`,
          type: "info",
        });
      }
    });

    await Promise.all(taskPromises);

    isRunning.value = false;
    currentRunningTokenId.value = null;
    message.success("按积分开箱结束");
  };

  return {
    batchOpenBox,
    batchSmartOpenBox,
    batchOpenBoxByPoints,
    batchClaimBoxPointReward,
    batchFish,
    batchRecruit,
    batchHeroUpgrade,
    batchBookUpgrade,
    batchClaimStarRewards,
    batchResourceUpgradeChain,
    batchClearItems,
    batchClaimPeachTasks,
    batchGenieSweep,
  };
}
