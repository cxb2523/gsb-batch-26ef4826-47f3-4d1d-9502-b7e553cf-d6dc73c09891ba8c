/**
 * 系统小窗的互斥会话 —— 视频小窗 (video-pip.js) 与原生字幕浮层 (native-caption-pip.js) 共用。
 *
 * 同一时刻只允许一条路径持有系统小窗 (活动或启动中)。开启另一条前必须先把当前持有者
 * 关掉并等它真正退出; 关闭失败或用户取消时持有者不变 —— 既不能把它误标成已关闭,
 * 请求方也不能把自己标成已开启。
 *
 * 参与者注册:
 * * `close()`  —— 异步, 返回 true 表示系统窗口已真正退出;
 * * `isBusy()` —— 启动/关闭过程中。此时对方 acquire 得到 'busy', 应提示稍后重试,
 *   而不是并发打开第二个系统窗口。
 *
 * 系统事件直接打开的小窗 (经典 PiP 的 enterpictureinpicture、Activity PiP 回调) 用带
 * `when` 守卫的 acquire 补登记: 守卫在拿到锁之后才检查, 事件到时已经失效的登记直接作废。
 */
export function createPipSession() {
  const parts = new Map();
  const listeners = new Set();
  let holder = '';
  let queue = Promise.resolve();

  const notify = () => { for (const listener of [...listeners]) listener(holder); };

  async function acquireLocked(name, when) {
    if (when && !when()) return false;
    if (holder === name) return true;
    if (holder) {
      const currentName = holder;
      const current = parts.get(currentName);
      if (!current) return false;
      if (current.isBusy?.()) return 'busy';
      let closed = false;
      try { closed = await current.close?.() === true; } catch { closed = false; }
      // 关闭失败或用户取消: 持有者保持原状, 请求方也不能算开启。
      if (!closed) return false;
      if (holder === name) return true;              // 等待期间系统事件已把持有者换成请求方
      if (holder && holder !== currentName) return false;  // 持有者换成了别人, 不能踩过去
      // 已确认退出: 无论对方有没有自己 release, 会话都在这里收回。
    }
    holder = name;
    notify();
    return true;
  }

  // acquire 串行化: 两个方向同时请求时, 后来的看到确定的持有者, 不会各自以为抢到了。
  const acquire = (name, when) => {
    const run = queue.then(() => acquireLocked(name, when));
    queue = run.then(() => {}, () => {});
    return run;
  };

  /** 空闲时的同步认领: 省去一次微任务跳转, 启动请求留在调用方原来的时序里。
      被占用时返回 false, 调用方再走 acquire 等对方退出。 */
  const tryClaim = (name) => {
    if (holder && holder !== name) return false;
    if (holder === name) return true;
    holder = name;
    notify();
    return true;
  };

  const release = (name) => {
    if (holder !== name) return;
    holder = '';
    notify();
  };

  return {
    register: (name, participant) => { parts.set(name, participant); },
    acquire,
    tryClaim,
    release,
    owner: () => holder,
    onChange: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
}
