/**
 * 日志环形缓冲（定长槽位 + 写入指针）
 *
 * 背景（2026-09-30 实测，见 .workbuddy/memory/2026-09-30.md）：
 * 原先日志用「数组 push + 每行 slice(-max)」维护，满了之后每来一条新日志，
 * 整个数组会左移一格，渲染层按 index 做 key 的话等于 1000 行文字被整体重写：
 *   手机 CPU 4x 降频下 77.5ms/条，桌面 1x 也 12.7ms/条。
 *
 * 环形缓冲的做法：槽位固定，写满后只覆盖最早那一格并挪指针 ⇒
 * 对渲染层而言「只有被覆盖的那一行内容变了」，其余行保持同一批对象引用：
 *   手机 6.53ms/条，桌面 1.19ms/条（再配合 .log-item 的 content-visibility 更低）。
 *
 * 用法：
 *   const ring = createLogRing(1000);
 *   ring.push({ time, message, type });
 *   ring.toArray();        // 按时间正序返回当前存活的日志（新数组，行对象是同一个引用）
 *   ring.errorCount;       // 错误条数（覆盖旧槽位时同步递减，不需要每次全量遍历）
 *   ring.version;          // 每次写入自增，用来驱动 Vue computed 失效
 */
export function createLogRing(max = 1000) {
  let capacity = normalizeMax(max);
  let slots = new Array(capacity).fill(null);
  let head = 0; // 下一个写入位置
  let size = 0; // 当前有效条数
  let errors = 0; // 当前错误条数
  let version = 0; // 写入次数，外部用它触发重渲染
  let seq = 0; // 自增 id，渲染层做稳定 key 用

  function normalizeMax(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 1) return 1;
    return Math.floor(n);
  }

  /** 覆盖写入：槽位数不变、数组不位移 */
  function push(log) {
    const entry = log && typeof log === "object" ? log : { message: String(log) };
    if (entry.id == null) entry.id = ++seq;

    const index = head % capacity;
    const overwritten = slots[index];
    slots[index] = entry;
    head = (head + 1) % capacity;
    if (size < capacity) size += 1;

    if (overwritten && overwritten.type === "error") errors -= 1;
    if (entry.type === "error") errors += 1;
    version += 1;
    return entry;
  }

  /** 按时间正序取出当前存活的日志（最老 → 最新） */
  function toArray() {
    const out = new Array(size);
    const start = (head - size + capacity * 2) % capacity;
    for (let i = 0; i < size; i += 1) {
      out[i] = slots[(start + i) % capacity];
    }
    return out;
  }

  function clear() {
    slots = new Array(capacity).fill(null);
    head = 0;
    size = 0;
    errors = 0;
    version += 1;
  }

  /** 容量变化（设置里改「最大日志条目」）时重建，保留最新的 N 条 */
  function setMax(next) {
    const nextCapacity = normalizeMax(next);
    if (nextCapacity === capacity) return;
    const kept = toArray().slice(-nextCapacity);
    const nextSlots = new Array(nextCapacity).fill(null);
    for (let i = 0; i < kept.length; i += 1) nextSlots[i] = kept[i];
    slots = nextSlots;
    capacity = nextCapacity;
    size = kept.length;
    head = kept.length % nextCapacity;
    errors = kept.reduce((sum, item) => (item && item.type === "error" ? sum + 1 : sum), 0);
    version += 1;
  }

  return {
    push,
    toArray,
    clear,
    setMax,
    get size() {
      return size;
    },
    get errorCount() {
      return errors;
    },
    get version() {
      return version;
    },
    get capacity() {
      return capacity;
    },
  };
}

export default createLogRing;
