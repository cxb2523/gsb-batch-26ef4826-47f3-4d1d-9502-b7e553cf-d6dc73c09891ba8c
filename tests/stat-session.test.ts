// @vitest-environment jsdom
// 统计会话隔离验证:假引擎 + 直接调用组件暴露方法
// 运行: npm test
import { describe, it, expect, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import StatPanel from '@/components/player/StatPanel.vue'
import StatCard from '@/components/player/StatCard.vue'
import VPlayer from '@/components/player/VPlayer.vue'
import { i18n } from '@/locales'
import type { LoadItem, PlayerInfo } from '@/types'

/** 可控假 loader:记录 listen 次数,可手动派发事件 */
class FakeLoader {
  handlers = new Map<string, Array<(...args: unknown[]) => void>>()
  listenCount = 0
  listen(event: string, cb: (...args: unknown[]) => void) {
    this.listenCount++
    const arr = this.handlers.get(event) ?? []
    arr.push(cb)
    this.handlers.set(event, arr)
    return this
  }
  emit(event: string, ...args: unknown[]) {
    for (const cb of this.handlers.get(event) ?? []) cb(...args)
  }
  start() { return this }
  pause() { return this }
  setBufferHealth() { return this }
  seekTo() {}
  destroy() {}
}

/** 可控假引擎:每次构造记录实例,attach 立即 resolve */
class FakeEngine extends FakeLoader {
  static instances: FakeEngine[] = []
  destroyed = false
  constructor() {
    super()
    FakeEngine.instances.push(this)
  }
  attach(): Promise<void> {
    return Promise.resolve()
  }
  destroy(): Promise<void> {
    this.destroyed = true
    return Promise.resolve()
  }
}

const loadItems = (vitag: number, aitag: number): LoadItem[] => [
  {
    itag: vitag, quality: '720p', req: 'http://x/v', mimeCodec: 'video/mp4; codecs="avc1"',
    init: { start: 0, end: 1 }, index: { start: 2, end: 3 }, len: 1000, meta: `v:${vitag}`, mirrors: [],
  },
  {
    itag: aitag, quality: '', req: 'http://x/a', mimeCodec: 'audio/webm; codecs="opus"',
    init: { start: 0, end: 1 }, index: { start: 2, end: 3 }, len: 500, meta: `v:${aitag}`, mirrors: [],
  },
]

const dispatch = (n: number) =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [i, { no: i, start: i * 100, end: i * 100 + 100 }]))

const mountPanel = (items: LoadItem[]) =>
  mount(StatPanel, {
    props: { title: 'T', loadItems: items },
    global: { plugins: [i18n] },
  })

const cards = (w: ReturnType<typeof mountPanel>) => w.findAllComponents(StatCard)
const boxes = (card: ReturnType<typeof cards>[number]) => card.findAll('.stat-box')

describe('StatPanel 统计会话', () => {
  it('新会话清空旧数据,旧会话回调被忽略,同会话不重复绑定', async () => {
    const w = mountPanel(loadItems(136, 140))
    const lv1 = new FakeLoader()
    const la1 = new FakeLoader()

    // 会话 1:两路 loader
    ;(w.vm as any).onLoadersready(1, [lv1, la1], [dispatch(2), dispatch(3)])
    await nextTick()
    expect(boxes(cards(w)[0])).toHaveLength(2)
    expect(boxes(cards(w)[1])).toHaveLength(3)
    expect(lv1.listenCount).toBe(6)

    // rtc.stat 带 uid → 显示节点标识;不带 uid 的后续回调不得清空
    lv1.emit('rtc.stat', { peerA: { state: 'open', tx: 10, rx: 20 } }, 'MY-ID')
    await nextTick()
    expect(w.text()).toContain('MY-ID')
    lv1.emit('rtc.stat', { peerA: { state: 'open', tx: 30, rx: 40 } })
    await nextTick()
    expect(w.text()).toContain('MY-ID')

    // http.start 标记分块
    lv1.emit('http.start', { no: 0, m: 0, n: 100 })
    await nextTick()
    expect(boxes(cards(w)[0])[0].classes()).toContain('http-start')

    // 同一会话重复调用:不重复绑定
    ;(w.vm as any).onLoadersready(1, [lv1, la1], [dispatch(2), dispatch(3)])
    expect(lv1.listenCount).toBe(6)

    // 会话 2:只有一路 loader,音频路为空 → 卡片空态
    const lv2 = new FakeLoader()
    ;(w.vm as any).onLoadersready(2, [lv2], [dispatch(1)])
    await nextTick()
    expect(boxes(cards(w)[0])).toHaveLength(1)
    expect(boxes(cards(w)[1])).toHaveLength(0)
    expect(w.text()).not.toContain('MY-ID') // 节点标识已清空
    expect(boxes(cards(w)[0])[0].classes()).not.toContain('http-start') // 卡片状态已清空

    // 旧会话(会话 1)的迟到回调全部忽略
    lv1.emit('rtc.stat', { peerX: { state: 'open', tx: 1, rx: 1 } }, 'OLD-ID')
    lv1.emit('http.start', { no: 0, m: 0, n: 100 })
    la1.emit('rtc.done', { no: 0, m: 0, n: 100 })
    await nextTick()
    expect(w.text()).not.toContain('OLD-ID')
    expect(w.text()).not.toContain('peerX')
    expect(boxes(cards(w)[0])[0].classes()).not.toContain('http-start')

    // 新会话 loader 正常工作
    lv2.emit('rtc.stat', { peerB: { state: 'open', tx: 5, rx: 6 } }, 'NEW-ID')
    lv2.emit('rtc.done', { no: 0, m: 0, n: 100 })
    await nextTick()
    expect(w.text()).toContain('NEW-ID')
    expect(boxes(cards(w)[0])[0].classes()).toContain('rtc-done')

    // 过期会话的 onLoadersready 整体忽略
    ;(w.vm as any).onLoadersready(1, [lv1], [dispatch(9)])
    await nextTick()
    expect(boxes(cards(w)[0])).toHaveLength(1)
  })

  it('标题与分块数量来自新的 loadItems', async () => {
    const w = mountPanel(loadItems(136, 140))
    expect(w.text()).toContain('T-136.mp4')
    expect(w.text()).toContain('T-140.webm')
    // 切换清晰度:播放页更新 loadItems,新会话分块来自新 dispatchs
    await w.setProps({ loadItems: loadItems(397, 140) })
    ;(w.vm as any).onLoadersready(2, [new FakeLoader(), new FakeLoader()], [dispatch(4), dispatch(2)])
    await nextTick()
    expect(w.text()).toContain('T-397.mp4')
    expect(boxes(cards(w)[0])).toHaveLength(4)
    expect(boxes(cards(w)[1])).toHaveLength(2)
  })
})

describe('VPlayer loadersready 会话序号', () => {
  const pinfo = (id: string): PlayerInfo => ({
    id,
    title: 'T',
    duration: 100,
    streams: {
      136: { itag: 136, quality: '720p', type: 'video/mp4; codecs="avc1"', len: 1000, initRange: { start: '0', end: '1' }, indexRange: { start: '2', end: '3' } },
      140: { itag: 140, quality: '', type: 'audio/mp4; codecs="mp4a"', len: 500, initRange: { start: '0', end: '1' }, indexRange: { start: '2', end: '3' } },
    },
  })

  beforeEach(() => {
    FakeEngine.instances = []
    // jsdom 无 MSE:补桩使 isModern() 通过、useWebm() 为 false
    ;(window as any).MediaSource = class {
      static isTypeSupported() { return false }
    }
    ;(window as any).fastloadjs = FakeEngine
    localStorage.clear()
    sessionStorage.clear()
  })

  it('事件携带递增会话序号,旧引擎的迟到 ready 被丢弃', async () => {
    const w = mount(VPlayer, {
      props: { playerInfo: pinfo('vid1'), autoplay: false },
      global: { plugins: [i18n] },
      attachTo: document.body,
    })
    await flushPromises()
    expect(FakeEngine.instances).toHaveLength(1)
    const eng1 = FakeEngine.instances[0]

    // 第一次 ready → 会话 1
    eng1.emit('ready', ['lv1', 'la1'], [{}, {}])
    let events = w.emitted('loadersready')!
    expect(events).toHaveLength(1)
    expect(events[0][0]).toBe(1)
    expect(events[0][1]).toEqual(['lv1', 'la1'])

    // 切换视频 → 重建引擎
    await w.setProps({ playerInfo: pinfo('vid2') })
    await flushPromises()
    expect(FakeEngine.instances).toHaveLength(2)
    expect(eng1.destroyed).toBe(true)
    const eng2 = FakeEngine.instances[1]

    // 旧引擎迟到的 ready 不再上抛
    eng1.emit('ready', ['stale'], [{}])
    expect(w.emitted('loadersready')).toHaveLength(1)

    // 新引擎 ready → 会话 2
    eng2.emit('ready', ['lv2', 'la2'], [{}, {}])
    events = w.emitted('loadersready')!
    expect(events).toHaveLength(2)
    expect(events[1][0]).toBe(2)
    expect(events[1][1]).toEqual(['lv2', 'la2'])

    w.unmount()
  })
})
