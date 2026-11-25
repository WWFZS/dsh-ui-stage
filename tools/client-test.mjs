/**
 * client-test.mjs —— 给 client.js 的设置页做**行为**测试（零依赖）。
 *
 * 为什么需要它：client.js 是浏览器半边，里面是 React 组件。历史上的验证方式是
 * 在源码里正则匹配字符串（"启用→enabled 映射存在"这类）—— 那只能证明代码没被删，
 * 证明不了**行为**对：比如"点卡片到底发了什么请求体"、"删除按钮的文案对不对"、
 * "恢复默认后界面显示什么"。
 *
 * 做法：在 vm 里放一个**极小的 React 垫片**（createElement + 四个 hook），
 * 把 client.js 原文跑起来，拿到组件树，再断言树上的实际内容。
 * 不引 React 真身：插件本身零依赖，测试也该零依赖，而且仓库里的 React UMD
 * 在 .gitignore 里（截图工具的临时产物），拿来当测试依赖不可靠。
 *
 * 用法：node tools/client-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const clientSource = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')

let failures = 0
const check = async (name, fn) => {
  try {
    await fn()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures += 1
    console.error(`  FAIL ${name}: ${error.message}`)
  }
}

// ─────────────────────────── React 垫片 ───────────────────────────

/**
 * 原生主题令牌的两套取值（只给 `snapshotNative` 读的那六个）。
 *
 * 值本身随意，只要能区分深浅即可 —— 测试断的是"切主题后快照变了"，
 * 不是"值等于多少"（那是内核的事）。
 */
const NATIVE_TOKENS_LIGHT = {
  '--dsw-alias-bg-base': '#ffffff',
  '--dsw-alias-bg-layer-1': '#f2f4f7',
  '--dsw-alias-border-l1': 'rgba(0,0,0,0.12)',
  '--dsw-alias-label-primary': '#0f1115',
  '--dsw-alias-label-secondary': '#5b616b',
  '--dsw-alias-label-tertiary': '#8b919b',
}
const NATIVE_TOKENS_DARK = {
  '--dsw-alias-bg-base': '#16181d',
  '--dsw-alias-bg-layer-1': '#1e2128',
  '--dsw-alias-border-l1': 'rgba(255,255,255,0.14)',
  '--dsw-alias-label-primary': '#e8eaed',
  '--dsw-alias-label-secondary': '#9aa0a8',
  '--dsw-alias-label-tertiary': '#6b7178',
}

/**
 * 极小的 React 替身：只实现 client.js 用到的部分。
 * hooks 用一个简单的游标实现 —— 组件函数按顺序调用 hook，渲染器负责重放。
 */
function createReact(onImageSrc) {
  let hookIndex = 0
  /** @type {any[]} */
  let currentHooks = []
  let effects = []
  /**
   * 每次渲染按"第几个带 ref 的元素"复用同一个假 DOM 节点。
   *
   * 为什么必须复用：真 React 重渲染时元素实例是**复用**的，所以拖动中直接改
   * `node.textContent` 之后，下一次渲染读到的还是那个节点、值还在。之前每次渲染
   * 新建节点，于是"拖动直接改 DOM"这条路径一测就丢 —— 不是代码坏了，是垫片失真。
   */
  let refSlots = []
  let refSlotIndex = 0
  /**
   * 每次 useState 的 setter **真的改变值时**记一笔（记录 hook 序号）。
   *
   * 用途：断言"拖动 20 格只更新 state 1 次"。真 React 里 setState 值变了就会重渲染，
   * 所以这个计数就是"组件被要求重画了几次"的诚实代理。没有它，
   * "拖动不触发整页重渲染"这条测试对旧代码也会通过 —— 那就成了摆设。
   */
  let stateUpdates = []

  const React = {
    createElement(type, props, ...children) {
      const flat = children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false)
      /** 渲染结果上的 img 才对应真实 DOM：把地址发出去看看真实 `<img>` 会请求什么。 */
      if (String(type).toLowerCase() === 'img') onImageSrc?.(props?.src)
      // 真 React 会在挂载后调用 ref 回调。滑杆的"直接改 DOM"路径（拖动时不重渲染）
      // 全靠 ref 拿到读数与滑块元素，垫片不调的话那条路径在测试里永远为空 ——
      // 于是"拖动是否真的改了 DOM"就测不出来。
      let refNode = null
      if (props !== null && props !== undefined && typeof props.ref === 'function') {
        const slot = refSlotIndex++
        if (refSlots[slot] === undefined) {
          refSlots[slot] = {
            textContent: '',
            title: '',
            value: '',
            style: {},
            setAttribute() {},
            removeAttribute() {},
          }
        }
        refNode = refSlots[slot]
        props.ref(refNode)
      }
      return { type, props: props ?? {}, children: flat, __refNode: refNode }
    },
    useState(initial) {
      const index = hookIndex++
      if (currentHooks.length <= index) {
        currentHooks[index] = typeof initial === 'function' ? initial() : initial
      }
      const setValue = (next) => {
        const before = currentHooks[index]
        const after = typeof next === 'function' ? next(before) : next
        currentHooks[index] = after
        // 真 React：setState 且值**真的变了**就会重渲染组件。
        // 不 record 的话，"拖动期间不许重渲染"这条在垫片里根本测不出来 ——
        // 旧代码每格 setDrag 也能"通过"，测试就成了摆设。这里如实记账。
        if (after !== before) stateUpdates.push(index)
      }
      return [currentHooks[index], setValue]
    },
    useRef(initial) {
      const index = hookIndex++
      if (currentHooks.length <= index) currentHooks[index] = { current: initial }
      return currentHooks[index]
    },
    useEffect(fn, deps) {
      const index = hookIndex++
      const previous = currentHooks[index]
      const changed =
        previous === undefined ||
        deps === undefined ||
        previous.deps === undefined ||
        deps.length !== previous.deps.length ||
        deps.some((dep, i) => dep !== previous.deps[i])
      if (changed) {
        currentHooks[index] = { deps }
        effects.push(() => fn())
      }
    },
    /** 供渲染器使用：跑完一轮后收集 effect。 */
    __reset() {
      hookIndex = 0
      effects = []
      refSlotIndex = 0
      stateUpdates = []
    },
    /** 这一轮渲染期间，有多少次 setState 真的改了值（= 真 React 会重渲染几次）。 */
    __stateUpdates() {
      return stateUpdates.slice()
    },
    __effects() {
      return effects
    },
    __hooks() {
      return currentHooks
    },
  }
  return React
}

/** 递归遍历组件树。 */
function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

/** 收集树上所有文本。 */
function texts(node) {
  const out = []
  walk(node, (item) => {
    if (typeof item.type === 'string' && item.type !== 'img' && item.type !== 'input') {
      const text = item.children.filter((child) => typeof child === 'string').join('')
      if (text !== '') out.push(text)
    }
  })
  return out
}

/** 按 className 找节点。 */
/** 按 className 精确匹配。 */
function findAll(node, className) {
  const out = []
  walk(node, (item) => {
    if (item.props && item.props.className === className) out.push(item)
  })
  return out
}

/** 按 className **包含**匹配（一个节点可能有多个类，如 "a b"）。 */
function findByClass(node, className) {
  const out = []
  walk(node, (item) => {
    const value = item.props?.className
    if (typeof value === 'string' && value.split(/\s+/).includes(className)) out.push(item)
  })
  return out
}

/** 找出 props 里带指定 prop 的节点。 */
function findByProp(node, prop) {
  const out = []
  walk(node, (item) => {
    if (item.props && item.props[prop] !== undefined) out.push(item)
  })
  return out
}

// ─────────────────────────── 加载 client.js ───────────────────────────

/**
 * 在 vm 里跑 client.js，拿到 makeStartupAnimationPage。
 * @param {object} options 选项。
 * @param {object} [options.status] manage 回包（默认一份"全新安装"的状态）。
 * @param {object} [options.update] update 回包。
 * @returns {Promise<{ React: object, render: Function, calls: object[] }>} 测试现场。
 */
async function loadClient(options = {}) {
  const React = createReact((src) => calls.push({ type: 'img', src }))
  const calls = []
  /** 乱序回包的闸门（见 fetch 垫片的 `responseFor`）。 */
  const gates = []
  /** 惰性 interval 句柄：只记账、不真的触发（见 window.setInterval 垫片）。 */
  const intervals = []
  let intervalSeq = 0
  /** window 事件监听（宠物浮层 ↔ 设置页的那条桥）。 */
  const listeners = []
  const status = options.status ?? {
    ok: true,
    version: '1.10.0',
    enabled: true,
    sound: true,
    audioEnabled: false,
    audioVolume: 0.4,
    durationSec: 8,
    mode: 'css',
    custom: false,
    name: '',
    file: '',
    audioFile: '',
    audioName: '',
    audioBuiltin: false,
    builtin: false,
    limitBytes: 128 * 1024 * 1024,
    library: [],
    cfg: {},
  }

  /** 真 HTML 包装：真实页面里 `<img>` 上的 src 就是这个字符串。 */
  const RealImage = class {
    set src(value) {
      this._src = String(value)
      calls.push({ type: 'img', src: this._src, owner: this.__owner })
    }

    get src() {
      return this._src
    }
  }

  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(mod) {
          // client.js 顶层就调 load()，factory 会被**立即**执行：
          // 所以 require('react') 必须当场返回 React 垫片。
          sandbox.__module = mod.factory((name) => {
            if (name === 'react') return React
            throw new Error('unexpected require: ' + name)
          })
        },
      },
      location: { reload: () => calls.push({ type: 'reload' }) },
      open: (...args) => calls.push({ type: 'open', args }),
      innerWidth: 1280,
      innerHeight: 800,
      // 真实窗口上这两个就是全局函数的别名，垫片里补上（宠物浮层切动画时会用）。
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id),
      // 壁纸层的自愈看门狗用 setInterval（见 createWallpaperLayer 的 healIfStalled）。
      // 垫片缺了它，凡是挂到壁纸层的用例都会报 "window.setInterval is not a function"。
      //
      // 这里**不转发给真实的 setInterval**：真实定时器会一直挂着，测试跑完进程不退。
      // 改成一个惰性句柄 —— 只记下"有人设了 interval"，从不真的触发；测试关心的是
      // 配置/渲染结果，不是看门狗真的过了 4 秒。`unref` 语义在这里用不到，直接返回递增 id。
      setInterval: () => {
        intervalSeq += 1
        intervals.push(intervalSeq)
        return intervalSeq
      },
      clearInterval: (id) => {
        const at = intervals.indexOf(id)
        if (at >= 0) intervals.splice(at, 1)
      },
      requestAnimationFrame: (fn) => setTimeout(() => fn(0), 16),
      cancelAnimationFrame: (id) => clearTimeout(id),
      // 宠物浮层用 window 事件和设置页通信（两边不在同一棵渲染树上）。
      // 这里记下事件名，测试就能断言"点动作按钮 → 发了一条 dsa:pet-play"。
      addEventListener: (name, fn) => {
        listeners.push({ name, fn })
      },
      removeEventListener: (name) => {
        const at = listeners.findIndex((entry) => entry.name === name)
        if (at >= 0) listeners.splice(at, 1)
      },
      dispatchEvent: (event) => {
        calls.push({ type: 'event', name: event.type, detail: event.detail })
        for (const entry of listeners) if (entry.name === event.type) entry.fn(event)
        return true
      },
    },
    CustomEvent: class {
      constructor(type, init) {
        this.type = type
        this.detail = init && init.detail
      }
    },
    document: {
      createElement: (tag) => {
        if (String(tag).toLowerCase() === 'img') return new RealImage()
        const attrs = {}
        return {
          style: {},
          dataset: {},
          textContent: '',
          classList: { add() {}, remove() {} },
          children: [],
          setAttribute(name, value) {
            attrs[name] = String(value)
          },
          getAttribute(name) {
            return name in attrs ? attrs[name] : null
          },
          appendChild() {},
          replaceChild() {},
          removeAttribute() {},
          remove() {},
          addEventListener() {},
          removeEventListener() {},
          play: () => Promise.resolve(),
          pause() {},
          load() {},
        }
      },
      // 壁纸层会把"壁纸骨架 + 让位变量"写进一条 <style>。
      // 记下元素本身（而不是当下的文本）：文本是创建之后才赋上去的。
      head: { appendChild: (el) => calls.push({ type: 'style', el }) },
      body: {
        appendChild() {},
        style: { setProperty() {}, removeProperty() {} },
      },
      // 壁纸层要监听页面可见性（后台标签页暂停视频）。
      addEventListener() {},
      removeEventListener() {},
      hidden: false,
    },
    /**
     * MutationObserver 垫片：只记下"监听了谁、盯哪些属性"，并支持手动触发。
     *
     * client.js 用它在深浅色主题切换后重算地板色 —— 那是**属性变化**驱动的，
     * 没有真实 DOM 也能测：改完 `context.__theme` 直接调 `context.__fireTheme()`。
     */
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback
        this.targets = []
        sandbox.__observers.push(this)
      }

      observe(target, options) {
        this.targets.push({ target, options })
      }

      disconnect() {
        this.targets = []
      }

      /** 测试用：模拟目标属性变化。 */
      __fire() {
        if (this.targets.length === 0) return
        this.callback([], this)
      }
    },
    /**
     * getComputedStyle 垫片：返回沙箱里"当前主题"的原生令牌。
     *
     * 真实环境里这几个 `--dsw-alias-*` 由内核写在 body 内联样式上。
     * `snapshotNative` 要读它们，所以垫片必须给出**可辨识**的值，
     * 测试才能断言"切主题之后快照跟着换了"。
     */
    getComputedStyle: (el) => ({
      getPropertyValue: (name) => {
        const theme = sandbox.__theme
        const table = theme === 'dark' ? NATIVE_TOKENS_DARK : NATIVE_TOKENS_LIGHT
        return table[name] ?? ''
      },
      backgroundColor: '',
    }),
    fetch: (url, init) => {
      const path = String(url)
      calls.push({ type: 'fetch', url: path, init })
      if (path.includes('/update')) {
        return Promise.resolve({
          ok: true,
          json: async () =>
            options.update ?? { ok: true, current: '1.10.0', reachable: false, updateAvailable: false },
        })
      }
      // 自我管理并入 manage：GET 状态里带 `self`，POST 用 `{action}` 触发。
      // 以前是单独的 `/self` 端点，但那条路由在某些宿主上会被吃掉（400 无 body），
      // 设置页因此整块不显示卸载/更新 —— 所以状态与动作现在都走 manage。
      const isSelfAction = init?.method === 'POST' && String(init?.body ?? '').includes('"action"')
      if (isSelfAction) {
        return Promise.resolve({
          ok: true,
          json: async () => options.selfResult ?? { ok: true },
        })
      }
      // 乱序回包测试钩子：给了 `responseFor(body)` 就由它决定这一次回什么，
      // 并且**返回一个可外部 resolve 的 Promise** —— 测试因此能人为制造
      // "先发的请求后回来"（真实网络里这完全可能发生）。
      const custom = options.responseFor?.(init?.body ? JSON.parse(init.body) : null)
      if (custom !== undefined) {
        let settle
        const gate = new Promise((resolve) => {
          settle = resolve
        })
        gates.push({ settle: () => settle({ ok: true, json: async () => custom }) })
        return gate
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ ...status, self: options.self ?? { installed: false, selected: false } }),
      })
    },
    confirm: (text) => {
      calls.push({ type: 'confirm', text })
      return options.confirmResult !== false
    },
    Audio: class {
      constructor(src) {
        this.src = src
        this.volume = 1
      }

      play() {
        return Promise.resolve()
      }

      pause() {}
    },
    console,
    setTimeout,
    clearTimeout,
  }
  sandbox.globalThis = sandbox
  sandbox.window.document = sandbox.document
  /** 当前"深浅色"（client.js 读 data-ds-theme-source 与 body 上的 data-ds-dark-theme）。 */
  sandbox.__theme = options.theme ?? 'dark'
  /** client.js 里注册的 MutationObserver 实例（见垫片）。 */
  sandbox.__observers = []
  /**
   * 切深浅色：改属性 + 通知观察器 —— 和内核 ThemePresenter 走同一条路。
   * @param {'light'|'dark'} next
   */
  sandbox.__setTheme = (next) => {
    sandbox.__theme = next
    sandbox.document.documentElement.getAttribute = () => next
    sandbox.document.body.hasAttribute = (name) => name === 'data-ds-dark-theme' && next === 'dark'
    sandbox.__fireTheme()
  }
  /** 触发所有观察器（模拟属性变化）。 */
  sandbox.__fireTheme = () => {
    for (const observer of sandbox.__observers) observer.__fire()
  }
  // client.js 里 themeIsDark() 读这两个地方，垫片先按初始主题填好。
  sandbox.document.documentElement = {
    getAttribute: (name) => (name === 'data-ds-theme-source' ? sandbox.__theme : null),
    style: { setProperty() {}, removeProperty() {} },
  }
  sandbox.document.body.hasAttribute = (name) => name === 'data-ds-dark-theme' && sandbox.__theme === 'dark'
  const context = vm.createContext(sandbox)
  // client.js 顶层就会调 window.__ModuleLoader__.load(...) —— 跑完即已装载。
  vm.runInContext(clientSource, context, { filename: 'client.js' })
  const module = sandbox.__module
  assert.ok(module, 'client.js 没有导出模块')

  const dicts = {}
  let Page = null
  module.apply({
    effect: (fn) => fn(),
    locale: {
      register: (ns, lang, dict) => {
        dicts[lang] = dict
        return () => {}
      },
      bind: () => (key) => (dicts.zh && dicts.zh[key]) ?? key,
    },
    slots: {
      inject: (name, cb) => {
        cb()
        return () => {}
      },
      register: (meta, component) => {
        Page = component
        return () => {}
      },
    },
  })
  assert.ok(Page, '没有注册设置页组件')

  /**
   * 渲染组件并跑完 effect。
   *
   * 组件的状态来自一次 fetch（异步），所以要"渲染 → 跑 effect → 等 fetch 落地
   * → 再渲染一次"才能拿到有数据的树。第二次渲染时 hooks 的 deps 没变，
   * effect 不会重复触发。
   * @returns {Promise<object>} 最终组件树。
   */
  const render = async () => {
    React.__reset()
    Page()
    for (const effect of React.__effects()) effect()
    // 等 fetch 的 Promise 链落地（manage 状态 + update 版本）。
    for (let i = 0; i < 40; i += 1) await Promise.resolve()
    React.__reset()
    return Page()
  }

  return { React, render, calls, dicts, context, gates }
}

// ─────────────────────────── 测试 ───────────────────────────

console.log('== 设置页结构 ==')

await check('渲染出标题、开关与三个分类页签', async () => {
  const { render } = await loadClient()
  const tree = await render()
  const all = texts(tree)
  // 页头是插件的名字（2.0.1 起叫界面舞台），不再是「开机动画」——那只是其中一块功能。
  assert.ok(all.includes('界面舞台'), `没有标题：${all.join(' | ')}`)
  assert.ok(all.includes('显示开机动画'), '没有总开关')
  assert.ok(all.includes('MP4') && all.includes('壁纸') && all.includes('音频'), '三个分类页签不齐')
})

await check('总开关读的是 enabled（不是不存在的 enable）', async () => {
  const { render } = await loadClient()
  const tree = await render()
  const switches = findAll(tree, 'dsa-set-switch')
  assert.equal(switches.length, 3, `开关数量异常：${switches.length}`)
  const enable = switches.find((sw) => sw.props['aria-label'] === '显示开机动画')
  assert.ok(enable, '找不到总开关')
  assert.equal(enable.props['aria-checked'], 'true', '总开关没有反映 enabled=true')
})

await check('关闭总开关 → 写回 enabled:false（不是 enable）', async () => {
  const { render, calls } = await loadClient()
  const tree = await render()
  const enable = findAll(tree, 'dsa-set-switch').find((sw) => sw.props['aria-label'] === '显示开机动画')
  enable.props.onClick()
  const post = calls.find((call) => call.type === 'fetch' && call.init?.method === 'POST')
  assert.ok(post, '点击开关没有发 POST')
  const body = JSON.parse(post.init.body)
  assert.deepEqual(body, { enabled: false }, `写回内容不对：${JSON.stringify(body)}`)
})

await check('"视频带声播放" 写回 sound', async () => {
  const { render, calls } = await loadClient()
  const tree = await render()
  const sound = findAll(tree, 'dsa-set-switch').find((sw) => sw.props['aria-label'] === '视频带声播放')
  sound.props.onClick()
  const post = calls.find((call) => call.type === 'fetch' && call.init?.method === 'POST')
  assert.deepEqual(JSON.parse(post.init.body), { sound: false })
})

await check('展示时长滑杆 3–30 秒：拖过顶 → 夹到 30 并写回', async () => {
  const { render, calls } = await loadClient()
  const tree = await render()
  const range = findAll(tree, 'dsa-set-range').find((el) => el.props['aria-label'] === '展示时长')
  assert.ok(range, '找不到展示时长滑杆')
  assert.equal(range.props.min, 3, `下界不是 3 秒：${range.props.min}`)
  assert.equal(range.props.max, 30, `上界不是 30 秒：${range.props.max}`)
  range.props.onChange({ target: { value: '99' } })
  // 读数要立刻跟上，否则界面显示的秒数和真正生效的不一致。
  // 必须在提交之前断言：回包会触发"按状态回读"的 effect，把读数拨回 fixture 的值。
  const label = texts(await render()).find((text) => /^\d+ 秒$/.test(text))
  assert.equal(label, '30 秒', `读数没更新：${label}`)
  // 拖动停手 350ms 才提交一次（防抖），等它落地。
  await new Promise((resolve) => setTimeout(resolve, 400))
  const post = calls.find((call) => call.type === 'fetch' && call.init?.method === 'POST')
  assert.ok(post, '拖动滑杆没有发 POST')
  assert.deepEqual(JSON.parse(post.init.body), { durationSec: 30 }, '越界值没被夹到 30 秒')
})

console.log('== 开机音频 ==')

await check('音频页签存在；点音频卡片写回 useAudio', async () => {
  const { render, calls } = await loadClient({
    status: {
      ok: true,
      enabled: true,
      durationSec: 8,
      mode: 'css',
      custom: false,
      name: '',
      file: '',
      audioEnabled: false,
      audioFile: '',
      audioName: '',
      audioBuiltin: false,
      limitBytes: 1e9,
      library: [
        { id: '音频', files: [{ path: 'builtin/音频/秘书.mp3', name: '秘书.mp3', size: 100 }] },
      ],
      cfg: {},
    },
  })
  const tree = await render()
  // 切到"音频"页签（React state 变化 → 需要再渲染一次才能拿到新树）。
  const audioTab = findAll(tree, 'dsa-set-tab').find((tab) => tab.children.includes('音频'))
  assert.ok(audioTab, '没有音频页签')
  audioTab.props.onClick()
  const audioTree = await render()
  const cards = findAll(audioTree, 'dsa-set-card-hit')
  assert.equal(cards.length, 1, `音频卡片数量异常：${cards.length}`)
  cards[0].props.onClick()
  const post = calls.find((call) => call.type === 'fetch' && call.init?.method === 'POST')
  assert.ok(post, '点音频卡片没有发 POST')
  const body = JSON.parse(post.init.body)
  assert.equal(body.useAudio, 'builtin/音频/秘书.mp3')
  // 开关由**宿主**在收到 useAudio 时顺手打开（index.js 的 libraryPatch.audioEnabled），
  // 客户端只管"选中了哪一条"，不重复写开关 —— 两边都写会互相覆盖。
  assert.equal(body.audioEnabled, undefined, '客户端不该重复写 audioEnabled')
})

await check('开机音频开关写回 audioEnabled', async () => {
  const { render, calls } = await loadClient({
    status: {
      ok: true,
      enabled: true,
      durationSec: 8,
      mode: 'css',
      custom: false,
      name: '',
      file: '',
      audioEnabled: false,
      audioFile: '',
      audioName: '',
      audioBuiltin: false,
      limitBytes: 1e9,
      library: [],
      cfg: {},
    },
  })
  const tree = await render()
  const audioSwitch = findAll(tree, 'dsa-set-switch').find(
    (sw) => sw.props['aria-label'] === '播放开机音频',
  )
  assert.ok(audioSwitch, '找不到开机音频开关')
  audioSwitch.props.onClick()
  const post = calls.find((call) => call.type === 'fetch' && call.init?.method === 'POST')
  assert.ok(post, '点击开机音频开关没有发 POST')
  assert.deepEqual(JSON.parse(post.init.body), { audioEnabled: true })
})

console.log('== 素材库卡片 ==')

await check('点卡片 → 写回 use（选用未在用的素材）', async () => {
  const { render, calls } = await loadClient({
    status: {
      ok: true,
      enabled: true,
      durationSec: 8,
      mode: 'video',
      custom: true,
      name: '在用.mp4',
      file: 'builtin/MP4/在用.mp4',
      audioFile: '',
      audioBuiltin: false,
      limitBytes: 1e9,
      library: [
        {
          id: 'MP4',
          files: [
            { path: 'builtin/MP4/在用.mp4', name: '在用.mp4', size: 100 },
            { path: 'builtin/MP4/开场.mp4', name: '开场.mp4', size: 100 },
          ],
        },
      ],
      cfg: {},
    },
  })
  const tree = await render()
  const cards = findAll(tree, 'dsa-set-card-hit')
  assert.equal(cards.length, 2, `卡片数量异常：${cards.length}`)
  // 第一张是"在用"（点了不重复写），第二张才真的发请求。
  const target = cards[1]
  target.props.onClick()
  const post = calls.find((call) => call.type === 'fetch' && call.init?.method === 'POST')
  assert.ok(post, '点未在用的卡片没有发 POST')
  assert.deepEqual(JSON.parse(post.init.body), { use: 'builtin/MP4/开场.mp4' })
})

await check('点在用的卡片 → 不重复写配置', async () => {
  const { render, calls } = await loadClient({
    status: {
      ok: true,
      enabled: true,
      durationSec: 8,
      mode: 'video',
      custom: true,
      name: '在用.mp4',
      file: 'builtin/MP4/在用.mp4',
      audioFile: '',
      audioBuiltin: false,
      limitBytes: 1e9,
      library: [
        { id: 'MP4', files: [{ path: 'builtin/MP4/在用.mp4', name: '在用.mp4', size: 100 }] },
      ],
      cfg: {},
    },
  })
  const tree = await render()
  findAll(tree, 'dsa-set-card-hit')[0].props.onClick()
  const post = calls.find((call) => call.type === 'fetch' && call.init?.method === 'POST')
  assert.equal(post, undefined, '点在用的卡片也发了写请求')
})

await check('删除按钮文案区分内置与上传', async () => {
  const { render } = await loadClient({
    status: {
      ok: true,
      enabled: true,
      durationSec: 8,
      mode: 'css',
      custom: false,
      name: '',
      file: '',
      audioFile: '',
      audioBuiltin: false,
      limitBytes: 1e9,
      library: [
        {
          id: 'MP4',
          files: [
            { path: 'builtin/MP4/内置.mp4', name: '内置.mp4', size: 100 },
            { path: '/home/x/startup-animation-media/上传.mp4', name: '上传.mp4', size: 100, uploaded: true },
          ],
        },
      ],
      cfg: {},
    },
  })
  const tree = await render()
  const dels = findAll(tree, 'dsa-set-card-del')
  assert.equal(dels.length, 2, `删除按钮数量异常：${dels.length}`)
  const titles = dels.map((del) => del.props.title)
  assert.ok(
    titles.some((title) => title.includes('从列表移除')),
    `内置素材的删除文案不对：${titles.join(' | ')}`,
  )
  assert.ok(
    titles.some((title) => title === '删除文件'),
    `上传素材的删除文案不对：${titles.join(' | ')}`,
  )
  // 无障碍名要带素材名，否则读屏只会念"删除文件"，不知道删的是哪一条。
  for (const del of dels) {
    assert.ok(
      del.props['aria-label'].includes('.mp4'),
      `删除按钮的无障碍名没有素材名：${del.props['aria-label']}`,
    )
  }
})

await check('视频卡片标时长，读不到时不占位', async () => {
  const { render } = await loadClient({
    status: {
      ok: true,
      enabled: true,
      durationSec: 8,
      mode: 'css',
      custom: false,
      name: '',
      file: '',
      audioFile: '',
      audioBuiltin: false,
      limitBytes: 1e9,
      library: [
        {
          id: 'MP4',
          files: [
            { path: 'builtin/MP4/短.mp4', name: '短.mp4', size: 100, duration: 8.06 },
            { path: 'builtin/MP4/长.mp4', name: '长.mp4', size: 100, duration: 65.4 },
            { path: 'builtin/MP4/坏.mp4', name: '坏.mp4', size: 100 },
          ],
        },
      ],
      cfg: {},
    },
  })
  const tree = await render()
  const badges = findAll(tree, 'dsa-set-card-src').map((node) => texts(node).join(''))
  // 不足一分钟只写秒（四舍五入），超过一分钟用分:秒。
  assert.ok(badges.includes('8s'), `短视频没有时长标记：${badges.join(' | ')}`)
  assert.ok(badges.includes('1:05'), `长视频没有时长标记：${badges.join(' | ')}`)
  // 三条卡片各一个来源标记 + 两个时长 = 5；读不到时长的第三张不多出一个空标记。
  assert.equal(badges.length, 5, `标记数量异常：${badges.join(' | ')}`)
})

await check('内置素材删除 → 只写 forget，不真删', async () => {
  const { render, calls } = await loadClient({
    status: {
      ok: true,
      enabled: true,
      durationSec: 8,
      mode: 'css',
      custom: false,
      name: '',
      file: '',
      audioFile: '',
      audioBuiltin: false,
      limitBytes: 1e9,
      library: [
        { id: 'MP4', files: [{ path: 'builtin/MP4/内置.mp4', name: '内置.mp4', size: 100 }] },
      ],
      cfg: {},
    },
  })
  const tree = await render()
  findAll(tree, 'dsa-set-card-del')[0].props.onClick({ stopPropagation() {} })
  const post = calls.find((call) => call.type === 'fetch' && call.init?.method === 'POST')
  assert.deepEqual(JSON.parse(post.init.body), { forget: 'builtin/MP4/内置.mp4' })
})

console.log('== 宠物 ==')

/** 一个动作（宿主的真实形状：id/name/file/thumb/loop）。 */
const petClip = (id, loop = false) => ({
  id,
  name: id,
  file: `builtin/宠物/噜噜/${id}.webm`,
  thumb: `builtin/宠物/噜噜/thumbs/${id}.webp`,
  loop,
})

/** 小包：4 个动作，应该平铺成动作格。 */
const LULU_PACK = {
  id: 'lulu',
  name: '噜噜',
  description: '一只噜噜',
  credit: null,
  canvas: [480, 648],
  cover: 'builtin/宠物/噜噜/cover.webp',
  roles: { idle: '待机', drag: '', clicks: ['点击回应'], turn: [], moves: [] },
  ambient: ['interact', 'chill'],
  categories: [
    { id: 'interact', name: '互动', cover: 'builtin/宠物/噜噜/thumbs/点击回应.webp', clips: ['点击回应', '害羞捂脸'] },
    { id: 'chill', name: '休闲', cover: 'builtin/宠物/噜噜/thumbs/吃橘子.webp', clips: ['吃橘子', '待机'] },
  ],
  clips: [petClip('待机', true), petClip('点击回应'), petClip('害羞捂脸'), petClip('吃橘子')],
  count: 4,
}

/** 大包：109 个动作，应该按分类展示 + 搜索，不铺动作格。 */
const MAID_CLIPS = Array.from({ length: 109 }, (_, i) => petClip(`动作${String(i + 1).padStart(3, '0')}`))
const MAID_PACK = {
  id: 'maid',
  name: '女仆',
  description: '一只女仆',
  credit: {
    author: 'PC2005-cloud',
    name: 'dsh-pet',
    url: 'https://github.com/PC2005-cloud/dsh-pet',
    license: 'CC BY-NC-SA 4.0',
  },
  canvas: [360, 360],
  cover: 'builtin/宠物/女仆/cover.webp',
  roles: { idle: '动作001', drag: '', clicks: ['动作002'], turn: [], moves: [] },
  ambient: ['play', 'food'],
  categories: [
    { id: 'play', name: '玩耍', cover: 'builtin/宠物/女仆/thumbs/动作001.webp', clips: MAID_CLIPS.slice(0, 60).map((clip) => clip.id) },
    { id: 'food', name: '吃什么', cover: 'builtin/宠物/女仆/thumbs/动作061.webp', clips: MAID_CLIPS.slice(60).map((clip) => clip.id) },
  ],
  clips: MAID_CLIPS,
  count: 109,
}

/**
 * 带宠物域的 manage 状态（宿主的真实回包形状）。
 *
 * `pet.pets` 是**每只宠物的完整状态**：包本体 + 自己的 enabled/x/y。第一只默认开着，
 * 这样「总开关关着、点动作先开总开关」那条路径仍然成立。
 * @param {object[]} [packs] 宠物包。
 * @param {object} [over] 覆盖 pet 的字段（总开关 / 大小 / pets）。
 */
const petStatus = (packs = [LULU_PACK], over = {}) => ({
  ok: true,
  enabled: true,
  durationSec: 8,
  mode: 'css',
  custom: false,
  name: '',
  file: '',
  audioFile: '',
  audioBuiltin: false,
  limitBytes: 1e9,
  library: [],
  cfg: {},
  pet: {
    enabled: false,
    display: 'page',
    size: 176,
    // 默认当作"桌面模式可用"：绝大多数断言关心的是开关与动作，不该被环境差异干扰。
    desktop: { available: true, reason: '' },
    pets: packs.map((pack, index) => ({ ...pack, enabled: index === 0, size: 176, x: 100, y: 100 })),
    ...over,
  },
})

/** 切到宠物页签并返回这一轮渲染的树。 */
const openPetTab = async (render) => {
  const tree = await render()
  findAll(tree, 'dsa-set-tab')
    .find((tab) => tab.children[0] === '宠物')
    .props.onClick()
  return render()
}

await check('页签顺序：MP4 / 壁纸 / 主题 / 音频 / 宠物 / 更新公告', async () => {
  const { render } = await loadClient({ status: petStatus() })
  const tree = await render()
  const labels = findAll(tree, 'dsa-set-tab').map((tab) => tab.children[0])
  assert.deepEqual(labels, ['MP4', '壁纸', '主题', '音频', '宠物', '更新公告'], `页签顺序不对：${labels.join(' / ')}`)
})

await check('宠物页签：开关 + 大小 + 宠物卡 + 动作区', async () => {
  const { render } = await loadClient({ status: petStatus() })
  const petTree = await openPetTab(render)
  const all = texts(petTree)
  assert.ok(all.includes('显示所有宠物'), '没有宠物总开关')
  assert.ok(all.some((line) => line.includes('宠物大小')), '没有大小滑杆')
  assert.ok(all.includes('宠物'), '没有宠物选择标题')
  assert.ok(all.some((line) => line.startsWith('动作')), '没有动作区标题')
  const range = findByProp(petTree, 'type').find(
    (el) => el.props.type === 'range' && el.props['aria-label'] === '宠物大小',
  )
  assert.ok(range, '找不到宠物大小滑杆')
  assert.equal(range.props.min, 100, '下界不是 100px')
  assert.equal(range.props.max, 320, '上界不是 320px')
  const packs = findAll(petTree, 'dsa-set-pet')
  assert.equal(packs.length, 1, `宠物卡数量不对：${packs.length}`)
  assert.ok(texts(packs[0]).includes('噜噜'), '宠物卡上没有名字')
  assert.ok(texts(packs[0]).includes('4 个动作'), `宠物卡上没有动作数：${texts(packs[0]).join('|')}`)
})

await check('宠物页签：显示位置两档（DSH界面 / 全局界面），点「全局界面」写 petDisplay', async () => {
  const { render, calls } = await loadClient({ status: petStatus() })
  const petTree = await openPetTab(render)
  const segs = findAll(petTree, 'dsa-set-seg')
  assert.deepEqual(
    segs.map((seg) => texts(seg)[0]),
    ['DSH界面', '全局界面'],
    `显示位置应当是两档：${segs.map((seg) => texts(seg)[0]).join(' / ')}`,
  )
  // 默认是 DSH界面：第一档高亮。
  assert.deepEqual(segs.map((seg) => seg.props['data-on']), ['1', '0'])
  // 点「全局界面」→ 只发 petDisplay。
  segs[1].props.onClick()
  const post = calls.filter((call) => call.type === 'fetch' && call.init?.method === 'POST').pop()
  assert.ok(post, '点显示位置没有发请求')
  assert.deepEqual(JSON.parse(post.init.body), { petDisplay: 'global' })
})

await check('显示位置：没有「都显示」这一档（它会造出两只宠物）', async () => {
  const { render } = await loadClient({ status: petStatus() })
  const petTree = await openPetTab(render)
  const labels = findAll(petTree, 'dsa-set-seg').map((seg) => texts(seg)[0])
  assert.equal(labels.length, 2, `只该有两档，实际 ${labels.length} 档：${labels.join(' / ')}`)
  assert.ok(!labels.includes('都显示'), '「都显示」必须删掉 —— 它会让同一只宠物出现两次')
})

await check('显示位置：全局界面不可用时那一档禁用并给出原因', async () => {
  const status = petStatus([LULU_PACK], {
    desktop: { available: false, reason: '桌面模式仅支持 Windows' },
  })
  const { render } = await loadClient({ status })
  const petTree = await openPetTab(render)
  const segs = findAll(petTree, 'dsa-set-seg')
  assert.equal(segs[0].props.disabled, false, '「DSH界面」永远可用')
  assert.equal(segs[1].props.disabled, true, '不可用时「全局界面」必须禁用')
  assert.ok(
    texts(petTree).includes('桌面模式仅支持 Windows'),
    `没有把不可用原因显示出来：${texts(petTree).join('|')}`,
  )
})

await check('显示位置：已选「全局界面」时高亮对得上', async () => {
  const { render } = await loadClient({ status: petStatus([LULU_PACK], { display: 'global' }) })
  const petTree = await openPetTab(render)
  const segs = findAll(petTree, 'dsa-set-seg')
  assert.deepEqual(segs.map((seg) => seg.props['data-on']), ['0', '1'])
})

await check('小包动作直接平铺：丢一个动作进去就多一格', async () => {
  const clip = petClip('睡觉', true)
  const pack = { ...LULU_PACK, clips: [...LULU_PACK.clips, clip], count: 5 }
  const { render } = await loadClient({ status: petStatus([pack]) })
  const petTree = await openPetTab(render)
  const cards = findAll(petTree, 'dsa-set-act')
  assert.equal(cards.length, 5, `动作格数不对：${cards.length}`)
  const names = cards.map((card) => texts(card)[0])
  assert.deepEqual(names, ['待机', '点击回应', '害羞捂脸', '吃橘子', '睡觉'], `动作名不对：${names.join(' / ')}`)
  const thumbs = findAll(petTree, 'dsa-set-act-thumb')
  assert.equal(thumbs.length, 5, `动作缩略图数量不对：${thumbs.length}`)
  assert.ok(String(thumbs[0].props.src).includes('thumbs'), `缩略图没指向 thumbs 目录：${thumbs[0].props.src}`)
  assert.equal(thumbs[0].props.alt, '', '缩略图应该是装饰性的（alt 为空）')
})

await check('点动作格 → 通知浮层播这个名字对应的动作', async () => {
  const { render, calls } = await loadClient({ status: petStatus([LULU_PACK], { enabled: true }) })
  const petTree = await openPetTab(render)
  const card = findAll(petTree, 'dsa-set-act').find((el) => texts(el).includes('害羞捂脸'))
  assert.ok(card, '找不到「害羞捂脸」')
  card.props.onClick()
  const play = calls.find((call) => call.type === 'event' && call.name === 'dsa:pet-play')
  assert.ok(play, '没有通知浮层播放')
  assert.equal(play.detail && play.detail.id, '害羞捂脸', `播的动作不对：${JSON.stringify(play.detail)}`)
})

await check('浮层回报当前动作 → 对应那格高亮', async () => {
  const { render, context } = await loadClient({ status: petStatus([LULU_PACK], { enabled: true }) })
  let petTree = await openPetTab(render)
  // 浮层回报的是对象（v1.14.0 起带名字与包名）。
  context.window.dispatchEvent(
    new context.CustomEvent('dsa:pet-state', { detail: { id: '点击回应', name: '点击回应', pack: 'lulu', loop: false } }),
  )
  petTree = await render()
  const on = findAll(petTree, 'dsa-set-act').find((card) => card.props['data-on'] === '1')
  assert.ok(on, '没有高亮任何动作')
  assert.equal(texts(on)[0], '点击回应', `高亮错了：${texts(on)[0]}`)
})

await check('大包不铺动作格：分类卡 + 搜索 + 随机一个', async () => {
  const { render } = await loadClient({ status: petStatus([MAID_PACK], { enabled: true }) })
  const petTree = await openPetTab(render)
  assert.equal(findAll(petTree, 'dsa-set-act').length, 0, '109 个动作不该平铺')
  const cats = findAll(petTree, 'dsa-set-cat')
  assert.equal(cats.length, 2, `分类卡数量不对：${cats.length}`)
  const names = cats.map((cat) => texts(cat)[0])
  assert.deepEqual(names, ['玩耍', '吃什么'], `分类不对：${names.join(' / ')}`)
  // 分类卡的封面 = 该分类**第一个动作**的缩略图（不再有单独的 cat-*.webp 拼图）。
  // 封面 src 会被 petAsset() 包成 /dsh-startup-animation/asset?path=<编码后的包内路径>，先解码再比。
  const covers = cats.map((cat) => {
    const src = String(findAll(cat, 'dsa-set-cat-cover')[0].props.src)
    const raw = src.includes('path=') ? new URLSearchParams(src.split('?')[1]).get('path') : src
    return raw
  })
  assert.deepEqual(
    covers,
    ['builtin/宠物/女仆/thumbs/动作001.webp', 'builtin/宠物/女仆/thumbs/动作061.webp'],
    `分类封面不对：${covers.join(' / ')}`,
  )
  const search = findAll(petTree, 'dsa-set-input')[0]
  assert.ok(search, '没有搜索框')
  assert.equal(search.props.placeholder, '搜索动作', '搜索框占位文案不对')
  assert.ok(texts(petTree).includes('随机一个'), '没有「随机一个」按钮')
})

await check('分类卡图片地址真的落到 thumbs/<第一个动作>.webp', async () => {
  const { render, calls } = await loadClient({ status: petStatus([MAID_PACK], { enabled: true }) })
  await openPetTab(render)
  // 走的是渲染时交给 `<img>` 的 src（真实页面里浏览器就请求这个地址），
  // 不是组件树上的 props —— props 对了但没交给 img，用户看到的仍然是空框。
  const shown = calls.filter((call) => call.type === 'img' && String(call.src).includes('dsa')).length
  const covers = calls
    .filter((call) => call.type === 'img')
    .map((call) => String(call.src))
    .filter((src) => src.includes('thumbs'))
  assert.ok(covers.length >= 2, `分类卡没有把缩略图交给 <img>（共 ${shown} 张图）：${covers.join(' / ')}`)
  for (const src of covers) {
    const raw = src.includes('path=') ? new URLSearchParams(src.split('?')[1]).get('path') : src
    assert.ok(raw.startsWith('builtin/宠物/女仆/thumbs/'), `分类封面指向了非缩略图路径：${raw}`)
  }
})

await check('大包搜索：最多 8 条命中，点 chip 播放', async () => {
  const { render, calls } = await loadClient({ status: petStatus([MAID_PACK], { enabled: true }) })
  let petTree = await openPetTab(render)
  findAll(petTree, 'dsa-set-input')[0].props.onChange({ target: { value: '动作04' } })
  petTree = await render()
  const chips = findAll(petTree, 'dsa-set-chip')
  assert.equal(chips.length, 8, `命中没截到 8 条：${chips.length}`)
  assert.equal(texts(chips[0])[0], '动作040', `第一条不对：${texts(chips[0])[0]}`)
  assert.equal(findAll(petTree, 'dsa-set-cat').length, 0, '搜索结果里不该再显示分类卡')
  const chipThumbs = findAll(petTree, 'dsa-set-chip-thumb')
  assert.equal(chipThumbs.length, 8, `chip 缩略图数量不对：${chipThumbs.length}`)
  chips[0].props.onClick()
  const play = calls.find((call) => call.type === 'event' && call.name === 'dsa:pet-play')
  assert.equal(play && play.detail && play.detail.id, '动作040', 'chip 没有触发播放')
})

await check('搜索无命中 → 说一句没有匹配的动作', async () => {
  const { render } = await loadClient({ status: petStatus([MAID_PACK], { enabled: true }) })
  let petTree = await openPetTab(render)
  findAll(petTree, 'dsa-set-input')[0].props.onChange({ target: { value: '不存在' } })
  petTree = await render()
  assert.equal(findAll(petTree, 'dsa-set-chip').length, 0, '不该有 chip')
  assert.ok(texts(petTree).includes('没有匹配的动作'), '没有空结果提示')
})

await check('点分类卡 → 通知浮层在这个分类里随机演一个', async () => {
  const { render, calls } = await loadClient({ status: petStatus([MAID_PACK], { enabled: true }) })
  const petTree = await openPetTab(render)
  findAll(petTree, 'dsa-set-cat')
    .find((cat) => texts(cat).includes('吃什么'))
    .props.onClick()
  const play = calls.find((call) => call.type === 'event' && call.name === 'dsa:pet-category')
  assert.ok(play, '没有通知浮层按分类播放')
  assert.equal(play.detail && play.detail.id, 'food')
})

await check('「随机一个」→ 通知浮层随机演', async () => {
  const { render, calls } = await loadClient({ status: petStatus([MAID_PACK], { enabled: true }) })
  const petTree = await openPetTab(render)
  const btn = findByProp(petTree, 'className').find((el) => el.props.className === 'dsa-set-btn' && texts(el).includes('随机一个'))
  assert.ok(btn, '找不到「随机一个」按钮')
  btn.props.onClick()
  assert.ok(
    calls.some((call) => call.type === 'event' && call.name === 'dsa:pet-random'),
    '没有通知浮层随机播放',
  )
})

await check('点卡片 = 只看不动配置；卡片开关 = 只开这一只', async () => {
  const { render, calls } = await loadClient({ status: petStatus([LULU_PACK, MAID_PACK], { enabled: true }) })
  let petTree = await openPetTab(render)
  const cards = findAll(petTree, 'dsa-set-pet')
  assert.equal(cards.length, 2, `宠物卡数量不对：${cards.length}`)
  const maidCard = cards.find((card) => texts(card).includes('女仆'))
  assert.ok(maidCard, '找不到女仆卡')
  // ① 点卡片主体 → 只是切换"看哪只"（动作区标题跟着换），不发任何写请求。
  findAll(maidCard, 'dsa-set-pet-hit')[0].props.onClick()
  petTree = await render()
  assert.ok(
    texts(petTree).some((line) => line.startsWith('动作 · 女仆')),
    `动作区没跟着切到女仆：${texts(petTree).filter((line) => line.startsWith('动作')).join('|')}`,
  )
  assert.equal(
    calls.filter((call) => call.type === 'fetch' && call.init?.method === 'POST').length,
    0,
    '只切换视图不该写配置',
  )
  // ② 点卡片右上角开关 → 只发这一只的 petToggle（它本来没开，点了就是开）。
  findByClass(maidCard, 'dsa-set-switch')[0].props.onClick()
  const post = calls.find((call) => call.type === 'fetch' && call.init?.method === 'POST')
  assert.deepEqual(JSON.parse(post.init.body), { petToggle: { pack: 'maid', enabled: true } })
})

await check('多只可以同时开着：每只各自的开关互不影响', async () => {
  const pets = [
    { ...LULU_PACK, enabled: true, x: 100, y: 100 },
    { ...MAID_PACK, enabled: true, x: 20, y: 30 },
  ]
  const { render } = await loadClient({ status: petStatus([], { enabled: true, pets }) })
  const petTree = await openPetTab(render)
  const switches = findByClass(petTree, 'dsa-set-switch').filter((el) => String(el.props['aria-label']).includes('·'))
  assert.equal(switches.length, 2, `宠物卡开关数量不对：${switches.length}`)
  assert.deepEqual(
    switches.map((el) => el.props['aria-checked']),
    ['true', 'true'],
    '两只都开着时两个开关都该是开',
  )
})

await check('素材署名：不占设置页', async () => {
  const { render } = await loadClient({ status: petStatus([MAID_PACK], { enabled: true }) })
  const petTree = await openPetTab(render)
  assert.equal(findAll(petTree, 'dsa-set-credit').length, 0, '署名行还在，作者信息由 README 负责')
  assert.equal(texts(petTree).join(' ').includes('CC BY-NC-SA 4.0'), false, '许可证不应出现在界面上')
})

await check('打开宠物开关 → 写回 petEnabled:true', async () => {
  const { render, calls } = await loadClient({ status: petStatus() })
  const petTree = await openPetTab(render)
  const toggle = findAll(petTree, 'dsa-set-switch').find((el) => el.props['aria-label'] === '显示所有宠物')
  assert.ok(toggle, '找不到宠物开关')
  toggle.props.onClick()
  const post = calls.find((call) => call.type === 'fetch' && call.init?.method === 'POST')
  assert.deepEqual(JSON.parse(post.init.body), { petEnabled: true })
})

await check('宠物没开就点动作 → 先打开宠物，再通知浮层播放', async () => {
  const { render, calls } = await loadClient({ status: petStatus() })
  const petTree = await openPetTab(render)
  findAll(petTree, 'dsa-set-act')
    .find((card) => texts(card).includes('点击回应'))
    .props.onClick()
  const post = calls.find((call) => call.type === 'fetch' && call.init?.method === 'POST')
  assert.deepEqual(JSON.parse(post.init.body), { petEnabled: true }, '没有先把总开关打开')
  // 打开之后再发播放事件（等状态落地），否则浮层还没显示，动作白播。
  await new Promise((resolve) => setTimeout(resolve, 120))
  const play = calls.find((call) => call.type === 'event' && call.name === 'dsa:pet-play')
  assert.ok(play, '没有通知浮层播放')
  assert.equal(play.detail && play.detail.id, '点击回应', `播的动作不对：${JSON.stringify(play.detail)}`)
  assert.equal(play.detail && play.detail.pack, 'lulu', '播放事件没说播哪一只')
})

await check('拖大小滑杆 → 带 pack 立刻推给浮层，落盘走防抖', async () => {
  const { render, calls } = await loadClient({ status: petStatus() })
  const petTree = await openPetTab(render)
  const range = findByProp(petTree, 'type').find(
    (el) => el.props.type === 'range' && el.props['aria-label'] === '宠物大小',
  )
  range.props.onChange({ target: { value: '260' } })
  const size = calls.find((call) => call.type === 'event' && call.name === 'dsa:pet-size')
  assert.ok(size, '拖滑杆没有实时推给浮层（宠物会等回包才变，看着卡）')
  assert.equal(
    JSON.stringify(size.detail),
    JSON.stringify({ pack: 'lulu', size: 260 }),
    `推的尺寸不对：${JSON.stringify(size.detail)}`,
  )
  assert.equal(
    calls.filter((call) => call.type === 'fetch' && call.init?.method === 'POST').length,
    0,
    '滑杆还没停手就不该落盘',
  )
})

await check('宠物大小越界 → 夹到 320 再写回（带 pack）', async () => {
  const { render, calls } = await loadClient({ status: petStatus() })
  const petTree = await openPetTab(render)
  const range = findByProp(petTree, 'aria-label').find((el) => el.props['aria-label'] === '宠物大小')
  range.props.onChange({ target: { value: '9999' } })
  await new Promise((resolve) => setTimeout(resolve, 400))
  const post = calls.find((call) => call.type === 'fetch' && call.init?.method === 'POST')
  assert.deepEqual(JSON.parse(post.init.body), { petResize: { pack: 'lulu', size: 320 } }, '越界值没被夹到 320')
})

// 「全局界面」下桌面窗是独立进程，收不到窗口内的 dsa:pet-size 事件：
// 不补一条实时通道，宠物就只能等 350ms 落盘 → 宿主按新尺寸重建 Electron 进程，
// 用户看到的是"拖的时候没反应，停手闪没一秒再长回来"。
await check('全局界面：拖动大小立刻推预览（不写盘），且一帧只推一次', async () => {
  const { render, calls } = await loadClient({
    status: petStatus([LULU_PACK], { enabled: true, display: 'global' }),
  })
  const petTree = await openPetTab(render)
  const range = findByProp(petTree, 'aria-label').find((el) => el.props['aria-label'] === '宠物大小')
  // 连拖三格：rAF 合并后只该有一次预览请求。
  for (const value of ['200', '240', '280']) range.props.onChange({ target: { value } })
  await new Promise((resolve) => setTimeout(resolve, 80))
  const previews = calls.filter(
    (call) =>
      call.type === 'fetch' &&
      call.init?.method === 'POST' &&
      String(call.init.body).includes('petPreview'),
  )
  assert.equal(previews.length, 1, `预览请求没做逐帧合并（发了 ${previews.length} 次）`)
  // 发的是**最后拖到的那一格**，不是排队时的第一格 —— 否则宠物永远慢半拍。
  assert.deepEqual(
    JSON.parse(previews[0].init.body),
    { petPreview: { pack: 'lulu', size: 280 } },
    `预览推的不是最新值：${previews[0].init.body}`,
  )
  // 停手后才落盘，而且只有一次。
  await new Promise((resolve) => setTimeout(resolve, 400))
  const commits = calls.filter(
    (call) =>
      call.type === 'fetch' &&
      call.init?.method === 'POST' &&
      String(call.init.body).includes('petResize'),
  )
  assert.equal(commits.length, 1, `落盘次数不对（${commits.length}）`)
  assert.deepEqual(JSON.parse(commits[0].init.body), { petResize: { pack: 'lulu', size: 280 } })
})

await check('DSH界面：拖大小不发预览请求（浮层自己就跟手了）', async () => {
  const { render, calls } = await loadClient({ status: petStatus() })
  const petTree = await openPetTab(render)
  const range = findByProp(petTree, 'aria-label').find((el) => el.props['aria-label'] === '宠物大小')
  range.props.onChange({ target: { value: '240' } })
  await new Promise((resolve) => setTimeout(resolve, 80))
  const previews = calls.filter(
    (call) => call.type === 'fetch' && String(call.init?.body ?? '').includes('petPreview'),
  )
  assert.equal(previews.length, 0, '页面档不该发预览请求（多一条无用往返）')
})

await check('每只各记各的大小：切到女仆后，改的是女仆那一份', async () => {
  const pets = [
    { ...LULU_PACK, enabled: true, size: 180, x: 100, y: 100 },
    { ...MAID_PACK, enabled: true, size: 300, x: 20, y: 30 },
  ]
  const { render, calls } = await loadClient({ status: petStatus([], { enabled: true, pets }) })
  let petTree = await openPetTab(render)
  // 选中女仆 → 再拖滑杆，推给浮层的 pack 必须是 maid（不是全局共用一份大小）。
  findAll(petTree, 'dsa-set-pet')
    .find((card) => texts(card).includes('女仆'))
    .children[0].props.onClick()
  petTree = await render()
  assert.ok(
    texts(petTree).some((line) => line.includes('大小 · 女仆')),
    '大小这一行的标签没跟着换宠物',
  )
  const range = findByProp(petTree, 'aria-label').find((el) => el.props['aria-label'] === '宠物大小')
  range.props.onChange({ target: { value: '280' } })
  const size = calls.find((call) => call.type === 'event' && call.name === 'dsa:pet-size')
  assert.equal(
    JSON.stringify(size.detail),
    JSON.stringify({ pack: 'maid', size: 280 }),
    `推的不是女仆那一份：${JSON.stringify(size.detail)}`,
  )
  await new Promise((resolve) => setTimeout(resolve, 400))
  const post = calls.find((call) => call.type === 'fetch' && call.init?.method === 'POST')
  assert.deepEqual(
    JSON.parse(post.init.body),
    { petResize: { pack: 'maid', size: 280 } },
    '落盘没带上 pack',
  )
})

console.log('== 恢复默认与版本 ==')

await check('恢复默认 → DELETE；文案说"内置动画"而不是"原版标配"', async () => {
  const { render, calls } = await loadClient({
    status: {
      ok: true,
      enabled: true,
      durationSec: 8,
      mode: 'video',
      custom: true,
      name: '开场.mp4',
      file: 'builtin/MP4/开场.mp4',
      audioFile: '',
      audioBuiltin: false,
      limitBytes: 1e9,
      library: [],
      cfg: {},
    },
  })
  const tree = await render()
  const restore = findByClass(tree, 'dsa-set-btn').find((btn) => btn.children.includes('恢复默认'))
  assert.ok(restore, '找不到恢复默认按钮')
  restore.props.onClick()
  const del = calls.find((call) => call.type === 'fetch' && call.init?.method === 'DELETE')
  assert.ok(del, '恢复默认没有发 DELETE')
  // 当前还选着自定义素材，所以素材行显示的是"内置 · 开场"；等配置回落到
  // 无素材时才显示"内置动画"。两种文案都不能再叫"原版标配"。
  const all = texts(tree)
  assert.ok(
    !all.some((text) => text.includes('原版标配')),
    `界面里还留着"原版标配"：${all.filter((t) => t.includes('原版')).join(' | ')}`,
  )
})

await check('没有选用素材时 → 素材行显示"内置动画"', async () => {
  const { render } = await loadClient({
    status: {
      ok: true,
      enabled: true,
      durationSec: 8,
      mode: 'css',
      custom: false,
      name: '',
      file: '',
      audioFile: '',
      audioBuiltin: false,
      limitBytes: 1e9,
      library: [],
      cfg: {},
    },
  })
  const tree = await render()
  assert.ok(
    texts(tree).includes('内置动画'),
    `素材行没有显示"内置动画"：${texts(tree).join(' | ')}`,
  )
})

await check('版本小字显示当前版本', async () => {
  const { render } = await loadClient({ self: { installed: false, selected: false } })
  const tree = await render()
  const badge = findAll(tree, 'dsa-set-ver')[0]
  assert.ok(badge, '没有版本小字')
  assert.ok(
    badge.children.some((child) => typeof child === 'string' && child.includes('1.10.0')),
    `版本小字没有版本号：${JSON.stringify(badge.children)}`,
  )
})

await check('有新版 + 已安装 → 版本小字变成一键更新按钮，不再跳 GitHub', async () => {
  const { render, calls } = await loadClient({
    self: { installed: true, selected: true, spec: 'file:whatever' },
    update: {
      ok: true,
      current: '1.10.0',
      latest: '1.11.0',
      reachable: true,
      updateAvailable: true,
      releasesUrl: 'https://github.com/WWFZS/dsh-plugin-startup-animation/releases',
    },
  })
  const tree = await render()
  const button = findByClass(tree, 'dsa-set-ver-btn')[0]
  assert.ok(button, '有新版时版本小字没有变成按钮')
  // 按钮文案带当前版本与目标版本，用户知道自己从哪更新到哪。
  const label = button.children.join('')
  assert.ok(label.includes('v1.10.0'), `按钮没带当前版本：${label}`)
  assert.ok(label.includes('更新到 1.11.0'), `按钮没带目标版本：${label}`)
  button.props.onClick()
  await Promise.resolve()
  await Promise.resolve()
  // 一键更新：POST {action:'update'} 到 manage，不是 window.open 跳 Release 页。
  const post = calls.find(
    (call) =>
      call.type === 'fetch' && call.init?.method === 'POST' && String(call.init?.body ?? '').includes('"action"'),
  )
  assert.ok(post, '点击没有发出更新请求')
  const sent = JSON.parse(String(post.init.body))
  assert.equal(sent.action, 'update', `动作不对：${String(post.init.body)}`)
  const opened = calls.find((call) => call.type === 'open')
  assert.equal(opened, undefined, '仍然跳转了 GitHub')
})

await check('有新版但 link: 安装 → 版本小字保持纯文字（不给更新按钮）', async () => {
  const { render, calls } = await loadClient({
    self: { installed: true, selected: true, spec: 'link:D:/DeepSeek启动动画' },
    update: {
      ok: true,
      current: '1.11.1',
      latest: '1.11.2',
      reachable: true,
      updateAvailable: true,
      releasesUrl: 'https://github.com/WWFZS/dsh-plugin-startup-animation/releases',
    },
  })
  const tree = await render()
  assert.equal(findByClass(tree, 'dsa-set-ver-btn').length, 0, 'link 安装也给了版本小字更新按钮')
  // 纯文字 span 仍然在，带"更新到"提示（title 里），只是不可点。
  const badge = findAll(tree, 'dsa-set-ver')[0]
  assert.ok(badge, '版本号消失了')
  const post = calls.find(
    (call) =>
      call.type === 'fetch' && call.init?.method === 'POST' && String(call.init?.body ?? '').includes('"action"'),
  )
  assert.equal(post, undefined, 'link 安装发出了更新请求')
})

console.log('== 卸载 / 更新（v1.11.0）==')

await check('没装在 profile 里 → 不显示卸载/更新区', async () => {
  const { render } = await loadClient({ self: { ok: true, installed: false, selected: false } })
  const tree = await render()
  assert.equal(findAll(tree, 'dsa-set-self').length, 0, '不该显示自管区')
})

await check('装在 profile 里 → 显示卸载按钮', async () => {
  const { render } = await loadClient({ self: { ok: true, installed: true, selected: true } })
  const tree = await render()
  const panel = findAll(tree, 'dsa-set-self')[0]
  assert.ok(panel, '没显示自管区')
  const labels = texts(panel)
  assert.ok(labels.includes('卸载插件'), `没有卸载按钮：${labels.join(' | ')}`)
  // 没有新版本时不该有更新按钮（不给用户一个按了没用的按钮）。
  assert.ok(!labels.some((text) => text.startsWith('更新到')), `不该显示更新按钮：${labels.join(' | ')}`)
})

await check('有新版本 → 同时显示更新按钮', async () => {
  const { render } = await loadClient({
    self: { ok: true, installed: true, selected: true },
    update: {
      ok: true,
      current: '1.10.0',
      latest: '1.11.0',
      reachable: true,
      updateAvailable: true,
      releasesUrl: 'https://github.com/WWFZS/dsh-plugin-startup-animation/releases',
    },
  })
  const tree = await render()
  const panel = findAll(tree, 'dsa-set-self')[0]
  const labels = texts(panel)
  assert.ok(labels.includes('更新到 1.11.0'), `没有更新按钮：${labels.join(' | ')}`)
  assert.ok(labels.includes('卸载插件'), '没有卸载按钮')
})

await check('link: 安装（指向源码目录）→ 不显示更新按钮', async () => {
  const { render } = await loadClient({
    self: { installed: true, selected: true, spec: 'link:D:/DeepSeek启动动画' },
    update: {
      ok: true,
      current: '1.11.1',
      latest: '1.11.2',
      reachable: true,
      updateAvailable: true,
      releasesUrl: 'https://github.com/WWFZS/dsh-plugin-startup-animation/releases',
    },
  })
  const tree = await render()
  const panel = findAll(tree, 'dsa-set-self')[0]
  assert.ok(panel, '没显示自管区')
  const labels = texts(panel)
  // 开发链接不指向任何版本；用 tgz 覆盖会把链接换成发行包 —— 不是用户想要的。
  assert.ok(!labels.some((text) => text.startsWith('更新到')), `link 安装不该有更新按钮：${labels.join(' | ')}`)
  assert.ok(labels.includes('卸载插件'), '卸载按钮应该照常可用')
})

await check('点卸载 → 先确认，再 POST action=uninstall', async () => {
  const { render, calls } = await loadClient({
    self: { ok: true, installed: true, selected: true },
    selfResult: { ok: true, restartRequired: true, message: '已卸载' },
  })
  const tree = await render()
  const panel = findAll(tree, 'dsa-set-self')[0]
  // 按钮的 className 有两个类（dsa-set-btn dsa-set-btn-danger），按 class 精确匹配找不到 ——
  // 这里按 class **包含** 找。
  const button = findByClass(tree, 'dsa-set-btn').find((btn) => btn.children.includes('卸载插件'))
  assert.ok(button, '找不到卸载按钮')
  button.props.onClick()
  // 确认框要先过。
  const confirmed = calls.find((call) => call.type === 'confirm')
  assert.ok(confirmed, '没有确认就动手了')
  await Promise.resolve()
  await Promise.resolve()
  const post = calls.find(
    (call) => call.type === 'fetch' && call.init?.method === 'POST' && String(call.init?.body ?? '').includes("action"),
  )
  assert.ok(post, '没有发卸载请求')
  const sent = JSON.parse(String(post.init.body))
  assert.equal(sent.action, 'uninstall', `动作不对：${String(post.init.body)}`)
})

await check('用户在确认框点取消 → 不发请求', async () => {
  const { render, calls } = await loadClient({
    self: { ok: true, installed: true, selected: true },
    confirmResult: false,
  })
  const tree = await render()
  const button = findByClass(tree, 'dsa-set-btn').find((btn) => btn.children.includes('卸载插件'))
  assert.ok(button, '找不到卸载按钮')
  button.props.onClick()
  await Promise.resolve()
  await Promise.resolve()
  const post = calls.find(
    (call) => call.type === 'fetch' && call.init?.method === 'POST' && String(call.init?.body ?? '').includes("action"),
  )
  assert.equal(post, undefined, '取消后仍然发了请求')
})

await check('点更新 → POST action=update', async () => {
  const { render, calls } = await loadClient({
    self: { ok: true, installed: true, selected: true },
    update: {
      ok: true,
      current: '1.10.0',
      latest: '1.11.0',
      reachable: true,
      updateAvailable: true,
      releasesUrl: 'https://github.com/WWFZS/dsh-plugin-startup-animation/releases',
    },
    selfResult: { ok: true, restartRequired: true, message: '已更新' },
  })
  const tree = await render()
  const button = findByClass(tree, 'dsa-set-btn').find((btn) => btn.children.includes('更新到 1.11.0'))
  assert.ok(button, '找不到更新按钮')
  button.props.onClick()
  await Promise.resolve()
  await Promise.resolve()
  const post = calls.find(
    (call) => call.type === 'fetch' && call.init?.method === 'POST' && String(call.init?.body ?? '').includes("action"),
  )
  assert.ok(post, '没有发更新请求')
  const sent = JSON.parse(String(post.init.body))
  assert.equal(sent.action, 'update', `动作不对：${String(post.init.body)}`)
})

await check('旧包清扫：宿主给出 self.legacy 就静默清一次；没有就一次都不打', async () => {
  // 2.0.0 的保险：跳版手动装新包的人，机器上会同时留着旧包 —— 两个都激活就是
  // 两层壁纸、两只宠物。判定权在宿主（`self.legacy`），客户端只照做 —— 策略不写两份。
  // 挂在"插件加载"上而不是设置页的 effect 里：清残留和"有没有打开设置页"无关。
  const legacyPosts = (calls) =>
    calls.filter(
      (call) => call.type === 'fetch' && call.init?.method === 'POST' && String(call.init?.body ?? '').includes('"dropLegacy"'),
    )
  const withNext = await loadClient({
    status: { ok: true, version: '1.35.0' },
    self: { ok: true, installed: true, selected: true, spec: '^2.0.0', legacy: 'dsh-plugin-startup-animation' },
    selfResult: { ok: true, dropped: true, restartRequired: true, message: '旧插件已清除' },
  })
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
  assert.equal(legacyPosts(withNext.calls).length, 1, `清旧名请求发了 ${legacyPosts(withNext.calls).length} 次（应只发一次）`)

  // 没有 self.legacy（本地目录安装的旧包 / 本来就没有残留）→ 一次都不许打，
  // 否则每次启动都在用户机器上白跑一遍 pnpm。
  const plain = await loadClient({ status: { ok: true, version: '2.0.0' }, self: { ok: true, installed: true, selected: true } })
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
  assert.equal(legacyPosts(plain.calls).length, 0, '没有残留指令却发了请求')
})

console.log('== 更新公告 ==')

/** 一份按真实 Release 写法排版的正文：标题、分节、加粗、代码块、安装链接都在里面。 */
const RELEASE_BODY = [
  '## 开机动画 v1.13.0',
  '',
  '公告页签上线。',
  '',
  '### 改了什么',
  '',
  '- 标题旁的版本号点一下就地更新',
  '- **不再跳转** GitHub 手动下载',
  '',
  '```sh',
  'npm i dsh-plugin-startup-animation',
  '```',
  '',
  '### 安装',
  '',
  'https://example.com/dsh-plugin-startup-animation.tgz',
].join('\n')

await check('更新公告页签：渲染 Release 正文，安装段/代码块不进来', async () => {
  const { render, calls } = await loadClient({
    update: {
      ok: true,
      current: '1.12.0',
      latest: '1.13.0',
      reachable: true,
      updateAvailable: true,
      notes: RELEASE_BODY,
    },
  })
  const tree = await render()
  const tab = findAll(tree, 'dsa-set-tab').find((item) => item.children.includes('更新公告'))
  assert.ok(tab, '没有更新公告页签')
  tab.props.onClick()
  const panel = await render()
  // 页面上只有这一个 tabpanel，抬头标出这是哪一版的公告。
  const panels = findAll(panel, 'dsa-set-panel')
  assert.equal(panels.length, 1, `面板数量异常：${panels.length}`)
  assert.equal(panels[0].props['aria-label'], '更新公告')
  const all = texts(panel)
  assert.ok(all.includes('v1.13.0 更新了什么'), `抬头不对：${all.join(' | ')}`)
  assert.ok(
    all.some((text) => text.includes('标题旁的版本号点一下就地更新')),
    `要点没渲染：${all.join(' | ')}`,
  )
  // 加粗符号要去掉（设置页不渲染富文本）。
  assert.ok(all.some((text) => text.includes('不再跳转 GitHub 手动下载')), `加粗没剥干净：${all.join(' | ')}`)
  // 只看**可见文本**：`<style>` 里的 CSS 统一用 `**` 当 class 选择器通配符，它不是正文。
  const visible = findAll(panel, 'span').flatMap((node) => texts({ children: node.children }))
  assert.ok(!visible.some((text) => text.includes('**')), `正文里留着 markdown 加粗符号：${visible.join(' | ')}`)
  // 安装链接与代码示例属于"怎么装"，不是"这次改了什么"。
  assert.ok(!all.some((text) => text.includes('example.com')), `安装链接混进了公告：${all.join(' | ')}`)
  assert.ok(!all.some((text) => text.includes('npm i ')), `代码块混进了公告：${all.join(' | ')}`)
  // 「安装」小节与 Release 标题行是重复/无关信息：一个被截断，一个被抬头取代。
  assert.ok(!all.some((text) => text === '安装'), `「安装」小节标题混进了公告：${all.join(' | ')}`)
  assert.ok(!all.some((text) => text.includes('开机动画 v1.13.0')), `Release 标题与抬头重复：${all.join(' | ')}`)
  // 公告不是素材分类：切过去就不该再有上传入口，也不该发任何写请求。
  assert.ok(!all.some((text) => text.startsWith('选择文件')), '公告页里还留着上传入口')
  const post = calls.find((call) => call.type === 'fetch' && call.init?.method === 'POST')
  assert.equal(post, undefined, '切到更新公告不该发写请求')
})

await check('拿不到 Release 正文（离线）→ 公告页只显示"检查不到更新"，不报错', async () => {
  const { render } = await loadClient({
    update: { ok: true, current: '1.12.0', reachable: false, updateAvailable: false, reason: 'network' },
  })
  const tree = await render()
  findAll(tree, 'dsa-set-tab')
    .find((item) => item.children.includes('更新公告'))
    .props.onClick()
  const panel = await render()
  const all = texts(panel)
  assert.ok(all.includes('检查不到更新'), `离线时该是安静的提示：${all.join(' | ')}`)
  // 没有版本号就没有抬头 —— 宁可少一行，也不拼出"v 更新了什么"。
  assert.ok(!all.some((text) => text.includes('v 更新')), `不该出现拼凑的抬头：${all.join(' | ')}`)
})

const themeStatus = (wallpaper) => ({
  ok: true,
  version: '1.25.0',
  enabled: true,
  mode: 'video',
  src: '/dsh-startup-animation/asset',
  custom: true,
  name: '多重影像.mp4',
  file: 'builtin/MP4/多重影像.mp4',
  builtin: true,
  deleted: [],
  library: [
    {
      id: 'MP4',
      files: [
        { path: 'builtin/MP4/多重影像.mp4', name: '多重影像.mp4', size: 100 },
        // 只当开机动画用的片段：留在素材库里，但主题页签不该把它列成候选。
        { path: 'builtin/MP4/剑一.mp4', name: '剑一.mp4', size: 100, themeable: false },
      ],
    },
    { id: '图片', files: [{ path: 'builtin/图片/漫威-漫威宇宙.jpg', name: '漫威-漫威宇宙.jpg', size: 100 }] },
  ],
  wallpaper: {
    enabled: true,
    file: 'builtin/MP4/多重影像.mp4',
    src: '/dsh-startup-animation/asset?path=builtin%2FMP4%2F%E5%A4%9A%E9%87%8D%E5%BD%B1%E5%83%8F.mp4',
    kind: 'video',
    name: '多重影像.mp4',
    preset: 'frosted',
    scrim: 0,
    blur: 0,
    saturate: 1,
    glassAlpha: 0,
    surfaceBlur: 24,
    hint: ['#12161f', '#2b3a55', '#7c93b8', '#05070c'],
    ...wallpaper,
  },
  cfg: {},
})

const openThemeTab = async (render) => {
  const tree = await render()
  findAll(tree, 'dsa-set-tab')
    .find((tab) => tab.children[0] === '主题')
    .props.onClick()
  return render()
}

await check('主题页签：开关 + 预设卡 + 微调滑杆 + 素材卡片', async () => {
  const { render, calls } = await loadClient({ status: themeStatus() })
  const tree = await openThemeTab(render)
  const all = texts(tree)
  // 开关：带 aria-checked 的那一个，且读出来是"开着"。
  const switches = findAll(tree, 'dsa-set-switch').filter((node) => node.props['aria-label'] === '界面壁纸')
  assert.equal(switches.length, 1, `主题页签的开关数量不对：${switches.length}`)
  assert.equal(switches[0].props['aria-checked'], 'true')
  // 预设：5 套出厂预设（含"亮"），每格一个按钮。
  const presets = findAll(tree, 'dsa-set-preset')
  assert.equal(presets.length, 5, `预设数量不对：${presets.length}`)
  assert.ok(all.includes('亮'), `没有"亮"：${all.join(' | ')}`)
  assert.ok(all.includes('暗'), `没有"暗"：${all.join(' | ')}`)
  // 当前预设那格是按下态，其余不是。
  assert.equal(presets.filter((node) => node.props['aria-pressed'] === 'true').length, 1, '按下态数量不对')
  // 三个滑杆：遮罩/模糊/色彩。
  const ranges = findAll(tree, 'dsa-set-range').filter((node) => ['遮罩厚度', '壁纸模糊', '色彩浓度'].includes(node.props['aria-label']))
  assert.equal(ranges.length, 3, `滑杆数量不对：${ranges.length}`)
  // 素材：视频与图片都在（视频排在前面）。名字在 aria-label 里，不在纯文本里。
  // 素材库里有 3 条，但标了 `themeable: false` 的那条（剑一）不该出现在主题候选里 ——
  // 它只当开机动画用。
  const cards = findAll(tree, 'dsa-set-card-hit')
  assert.equal(cards.length, 2, `素材卡片数量不对：${cards.length}`)
  const cardNames = cards.map((node) => node.props['aria-label']).join(' | ')
  assert.ok(cardNames.includes('多重影像.mp4') && cardNames.includes('漫威-漫威宇宙.jpg'), `素材没列全：${cardNames}`)
  assert.ok(!cardNames.includes('剑一'), `不作主题的素材混进了主题候选：${cardNames}`)
})

await check('主题页签：预设卡上每格都有对比度数字（不依赖背景层广播）', async () => {
  const { render } = await loadClient({ status: themeStatus() })
  const tree = await openThemeTab(render)
  // 这里**没有**任何 dsa:wall-decision 广播（背景层还在起），拿到的只有 wallpaper.hint。
  // 七格必须照样算得出数：否则用户看到七张空卡片，以为功能是坏的。
  const ratios = findByClass(tree, 'dsa-set-preset-ratio')
  assert.equal(ratios.length, 5, `预设对比度数量不对：${ratios.length}`)
  for (const node of ratios) {
    const text = node.children[0]
    const value = Number(String(text).replace(':1', ''))
    assert.ok(Number.isFinite(value) && value >= 4.5, `对比度算错了：${text}`)
  }
})

await check('主题页签：点预设卡 → 只换颜色配方，不动三根滑杆', async () => {
  const { render, calls } = await loadClient({ status: themeStatus({ scrim: 0.4, blur: 6, saturate: 1.5 }) })
  const tree = await openThemeTab(render)
  const night = findAll(tree, 'dsa-set-preset').find((node) => texts({ children: node.children }).includes('暗'))
  assert.ok(night, '找不到「暗」预设')
  night.props.onClick()
  const post = calls.find((call) => call.type === 'fetch' && call.init?.method === 'POST')
  assert.ok(post, '点预设没有发 POST')
  // 用户报的 bug：三根滑杆"时不时还原为默认值"。根因之一就是这里 —— 点预设时
  // 顺手把 wallpaperScrim/Blur/Saturate 写成 'auto'，而宿主把 'auto' 当成
  // **删除这个键**，于是磁盘上用户调好的值真没了。
  // 五套预设在这三项上本来就是同一组值（0 / 0 / 1），清它们不是"换观感"，
  // 只是把用户调好的东西删掉。所以载荷里必须**只有**预设自己的键。
  assert.deepEqual(JSON.parse(post.init.body), {
    wallpaperPreset: 'night',
    wallpaperGlass: 'auto',
  })
})

await check('主题页签：点素材卡 → 写 wallpaperFile 并顺手打开壁纸', async () => {
  const { render, calls } = await loadClient({ status: themeStatus({ enabled: false, file: '', src: '', kind: '' }) })
  const tree = await openThemeTab(render)
  const card = findAll(tree, 'dsa-set-card-hit').find((node) => {
    const label = node.props['aria-label'] || ''
    return label.includes('漫威')
  })
  assert.ok(card, '找不到图片素材卡')
  card.props.onClick()
  const post = calls.find((call) => call.type === 'fetch' && call.init?.method === 'POST')
  assert.deepEqual(JSON.parse(post.init.body), {
    wallpaperFile: 'builtin/图片/漫威-漫威宇宙.jpg',
    wallpaperEnabled: true,
  })
})

await check('主题页签：遮罩滑杆从 0 开始（想原样透出壁纸就能拖到 0）', async () => {
  const { render } = await loadClient({ status: themeStatus({ scrim: 0.3 }) })
  const tree = await openThemeTab(render)
  const scrim = findByClass(tree, 'dsa-set-range').find((node) => node.props['aria-label'] === '遮罩厚度')
  assert.ok(scrim, '没有遮罩滑杆')
  // 下限就是 0：安全线在引擎里（玻璃厚度会把面板抬回来），不该靠滑杆下限锁人。
  assert.equal(Number(scrim.props.min), 0, `遮罩下限是 ${scrim.props.min}，应该允许 0`)
})
await check('主题页签：只剩三根滑杆（遮罩厚度 / 壁纸模糊 / 色彩浓度）', async () => {
  const { render } = await loadClient({ status: themeStatus() })
  const tree = await openThemeTab(render)
  const labels = findAll(tree, 'dsa-set-range').map((node) => node.props['aria-label'])
  assert.ok(!labels.includes('面板模糊'), `滑杆里还有「面板模糊」：${labels.join('/')}`)
  // 玻璃厚度也收掉了：实测只有 0 才看得见壁纸，往上加就是一层实色，留着只会误导。
  assert.ok(!labels.includes('玻璃厚度'), `滑杆里还有「玻璃厚度」：${labels.join('/')}`)
  // 页面上还有个开机动画的「展示时长」，不在主题面板里。
  assert.deepEqual(
    labels.filter((label) => label !== '展示时长'),
    ['遮罩厚度', '壁纸模糊', '色彩浓度'],
  )
})
await check('三根滑杆的量程：遮罩 0–80%、模糊 0–80%（= 10px）、浓度 100%–200%', async () => {
  // 量程与"存盘单位"是两件事：滑杆走**界面刻度**（百分比 / 倍数），
  // 存盘仍是 scrim 0–0.8、blur 0–10px、saturate 1–2×。
  const wall = await import('../lib/wallpaper.mjs')
  assert.equal(wall.SCREEN_LIMITS.scrim[1], 0.8, '遮罩上限不是 80%')
  assert.equal(wall.SCREEN_LIMITS.blur[1], 10, '壁纸模糊上限不是 10px')
  assert.deepEqual([...wall.SCREEN_LIMITS.saturate], [1, 2], '色彩浓度量程不是 1×–2×')
  const { render } = await loadClient({ status: themeStatus() })
  const tree = await openThemeTab(render)
  const ranges = (label) => findByClass(tree, 'dsa-set-range').find((node) => node.props['aria-label'] === label)
  const box = (label) => [Number(ranges(label).props.min), Number(ranges(label).props.max), Number(ranges(label).props.step)]
  assert.deepEqual(box('遮罩厚度'), [0, 80, 1], '遮罩滑杆不是 0–80%、一格 1%')
  assert.deepEqual(box('壁纸模糊'), [0, 80, 1], '模糊滑杆不是 0–80%、一格 1%')
  // 三档：min 1 / max 2 / step 0.5 —— 滑杆只有 1×、1.5×、2× 三个落点。
  assert.deepEqual(box('色彩浓度'), [100, 200, 1], '浓度滑杆不是 100%–200%、一格 1%')
})

await check('主题页签：壁纸关闭时滑杆禁用（没有壁纸可调）', async () => {
  const { render } = await loadClient({ status: themeStatus({ enabled: false }) })
  const tree = await openThemeTab(render)
  for (const range of findAll(tree, 'dsa-set-range').filter((node) => ['遮罩厚度', '壁纸模糊', '色彩浓度'].includes(node.props['aria-label']))) {
    assert.equal(range.props.disabled, true, `${range.props['aria-label']} 在壁纸关闭时仍可拖`)
  }
})

await check('主题页签：字体颜色八个选项（系统默认 + 七色），点一下只发 wallpaperTextColor', async () => {
  const { render, calls } = await loadClient({ status: themeStatus() })
  const tree = await openThemeTab(render)
  const colors = findByClass(tree, 'dsa-set-color')
  assert.equal(colors.length, 8, `色板应该有 8 格，实际 ${colors.length}`)
  const names = colors.map((node) => node.props['aria-label'].replace('字体颜色 ', ''))
  // 不含黑/白：那两个就是系统默认在深底/浅底上的答案，单列出来会显得是两回事。
  assert.deepEqual(names, ['系统默认', '红', '橙', '黄', '绿', '青', '蓝', '紫'])
  // 点黄色：只发这一个键，别把整套预设一起重发（那会顺手清掉用户的微调）。
  const yellow = colors.find((node) => node.props['aria-label'] === '字体颜色 黄')
  yellow.props.onClick()
  const post = calls.filter((call) => call.type === 'fetch' && call.init?.method === 'POST').pop()
  assert.deepEqual(JSON.parse(post.init.body), { wallpaperTextColor: '#ffe066' })
})
await check('主题页签：当前字体颜色会被标成选中', async () => {
  const { render } = await loadClient({ status: themeStatus({ textColor: '#4dd8e6' }) })
  const tree = await openThemeTab(render)
  const pressed = findByClass(tree, 'dsa-set-color').filter((node) => node.props['aria-pressed'] === 'true')
  assert.equal(pressed.length, 1, `应该只有一格选中，实际 ${pressed.length}`)
  assert.equal(pressed[0].props['aria-label'], '字体颜色 青')
})
await check('主题页签：壁纸关闭时色板禁用（没有壁纸可调）', async () => {
  const { render } = await loadClient({ status: themeStatus({ enabled: false }) })
  const tree = await openThemeTab(render)
  for (const node of findByClass(tree, 'dsa-set-color')) {
    assert.equal(node.props.disabled, true, `${node.props['aria-label']} 在壁纸关闭时仍可点`)
  }
})
await check('字体颜色：点色块后背景层真的重算成新颜色（不只是卡片变）', async () => {
  // 这条测试盯的是实际踩到的坑：decideAndApply 构造 preset 时漏了 textColor，
  // 于是设置页的卡片、对比度读数全对，但界面上的字还是自动色 —— 用户点了没反应。
  const { render, calls } = await loadClient({ status: themeStatus({ textColor: 'auto' }) })
  const tree = await openThemeTab(render)
  const purple = findByClass(tree, 'dsa-set-color').find((node) => node.props['aria-label'] === '字体颜色 紫')
  assert.ok(purple, '没有紫色可选')
  purple.props.onClick()
  // paintNow 会在 POST 之前先本地派发一次 dsa:wall-sync，让背景层当场重画。
  const sync = calls.filter((call) => call.type === 'event' && call.name === 'dsa:wall-sync').pop()
  assert.ok(sync, '点色块没有派发 dsa:wall-sync')
  const detail = sync.detail
  assert.equal(detail.textColor, '#c084fc', `派发出去的 textColor 是 ${detail.textColor}`)
  // 背景层拿到的这份配置必须能算出紫色字。
  const wall = await import('../lib/wallpaper.mjs')
  const preset = wall.resolvePreset({ preset: detail.preset, textColor: detail.textColor })
  const tokens = wall.deriveTokens(wall.decideTheme(wall.analyzeColors(['#101014', '#16161c']), preset), preset, { dark: false })
  assert.equal(tokens['dsa-wall-ink'], 'rgb(192, 132, 252)', `界面上的字色是 ${tokens['dsa-wall-ink']}`)
})
await check('主题页签：读不清的颜色会被标出来，且读数跟着当前颜色走', async () => {
  // 亮壁纸（八骏图那类）上紫色只有 1.2:1 —— 之前界面照样显示 5.42:1，
  // 用户以为"设置生效了但字看不清"，其实是这个颜色在这张壁纸上本来就不行。
  const bright = themeStatus({ preset: 'frosted', hint: ['#fffefd', '#ede6dd', '#d5c2ae', '#1a0e05'] })
  const { render } = await loadClient({ status: bright })
  const tree = await openThemeTab(render)
  const colors = findByClass(tree, 'dsa-set-color')
  // 亮壁纸（平均亮度 0.426）上，亮的颜色都不够读，系统默认（深字）够。
  const autoCell = colors.find((node) => node.props['data-color'] === 'auto')
  const yellow = colors.find((node) => node.props['data-color'] === 'yellow')
  const cyan = colors.find((node) => node.props['data-color'] === 'cyan')
  assert.ok(autoCell, '没有系统默认格')
  assert.notEqual(autoCell.props['data-weak'], '1', '亮壁纸上的系统默认被误标成读不清')
  assert.equal(yellow.props['data-weak'], '1', '亮壁纸上的黄字没被标记为读不清')
  assert.equal(cyan.props['data-weak'], '1', '亮壁纸上的青字没被标记为读不清')
  // 每个色格的 title 都带这张壁纸上的实测对比度。
  for (const node of colors) {
    assert.match(String(node.props.title), /\d+(\.\d+)?:1/, node.props['data-color'] + ' 的提示里没有对比度')
  }
})
await check('MP4/壁纸页签的素材卡上不再有「当壁纸」按钮（选主题只在主题页签里做）', async () => {
  const status = themeStatus()
  const { render } = await loadClient({ status })
  const tree = await render()
  assert.equal(findByClass(tree, 'dsa-set-card-wall').length, 0, '素材卡上仍有「当壁纸」按钮')
})

await check('主题滑杆：拖动只本地跟手，松手才落盘一次', async () => {
  const { render, calls } = await loadClient({ status: themeStatus() })
  const tree = await openThemeTab(render)
  const scrim = findByClass(tree, 'dsa-set-range').find((node) => node.props['aria-label'] === '遮罩厚度')
  assert.ok(scrim, '没有遮罩滑杆')
  // 三格拖拽：每一格都只改本地值，别急着 POST（POST 一次要等回包，滑块就滞后了）。
  // 滑杆的 value 是**界面刻度**（0–80 的百分比），存盘时才换算成 0–0.8 的比例。
  for (const value of ['40', '50', '60']) scrim.props.onChange({ target: { value } })
  const posted = calls.filter((call) => call.type === 'fetch' && call.init?.method === 'POST')
  assert.equal(posted.length, 0, '拖动过程中就在发请求了')
  scrim.props.onPointerUp({ target: { value: '60' } })
  const after = calls.filter((call) => call.type === 'fetch' && call.init?.method === 'POST')
  assert.equal(after.length, 1, `松手后应该只落盘一次，实际 ${after.length} 次`)
  assert.equal(JSON.parse(after[0].init.body).wallpaperScrim, 0.6, '60% 落盘不是 0.6')
})

await check('主题滑杆：读数就是真值，不再是"量程位置"', async () => {
  // 以前为了让三根"看着统一"，读数被硬拗成"量程位置 0–100"：遮罩 0.4 显示 50%、
  // 模糊 6px 显示 60%、浓度 1.3× 显示 77% —— 三个数都对不上配置里存的数，
  // 用户当然觉得"不准"。
  //
  // 现在读数就是那个数：遮罩 0.4 → 40%、模糊 6px → 48%（1% = 0.125px）、
  // 浓度 → 1.5×。换算规则只有一处（SLIDERS 的 toDisplay / read）。
  const { render } = await loadClient({ status: themeStatus({ scrim: 0.4, blur: 6, saturate: 1.5 }) })
  const tree = await openThemeTab(render)
  const rows = findByClass(tree, 'dsa-set-row')
  /** 某根滑杆所在行里的读数。 */
  const readOf = (label) => {
    const row = rows.find((node) => texts({ children: node.children }).includes(label))
    assert.ok(row, `找不到「${label}」那一行`)
    return findByClass(row, 'dsa-set-sec').map((node) => node.children.join(''))[0]
  }
  assert.equal(readOf('遮罩厚度'), '40%', `遮罩读数是 ${readOf('遮罩厚度')}`)
  assert.equal(readOf('壁纸模糊'), '48%', `模糊读数是 ${readOf('壁纸模糊')}（6px 应该是 48%）`)
  assert.equal(readOf('色彩浓度'), '150%', `色彩浓度读数是 ${readOf('色彩浓度')}（1.5× 应该显示 150%）`)
  // 真值（px / 原图说明）留在 title 里，刻度之外的信息不丢。
  const titleOf = (label) => {
    const row = rows.find((node) => texts({ children: node.children }).includes(label))
    return findByClass(row, 'dsa-set-sec')[0].props.title
  }
  assert.equal(titleOf('壁纸模糊'), '6px', `模糊的 px 真值没进 title：${titleOf('壁纸模糊')}`)
  assert.equal(titleOf('色彩浓度'), '1.5×', `浓度的倍数没进 title：${titleOf('色彩浓度')}`)
})

await check('色彩浓度：100%–200% 连续，默认 100%（原图）', async () => {
  const { render, calls } = await loadClient({ status: themeStatus({ scrim: 0, blur: 0, saturate: 1 }) })
  const tree = await openThemeTab(render)
  const range = findByClass(tree, 'dsa-set-range').find((node) => node.props['aria-label'] === '色彩浓度')
  assert.ok(range, '没有色彩浓度滑杆')
  // 出厂就是原图：读数 `100%`，title 里写明"原图"（倍数只在这里出现）。
  const row = findByClass(tree, 'dsa-set-row').find((node) => texts({ children: node.children }).includes('色彩浓度'))
  const sec = findByClass(row, 'dsa-set-sec')[0]
  assert.equal(sec.children.join(''), '100%', `默认读数不是 100%：${sec.children.join('')}`)
  assert.equal(sec.props.title, '1× 原图', `默认的说明不是"原图"：${sec.props.title}`)
  // 连续：一格 1%，任何百分比都能落，不再吸到 1×/1.5×/2× 三个落点。
  assert.equal(Number(range.props.step), 1, '一格不是 1%')
  assert.equal(Number(range.props.min), 100, '下限不是 100%')
  assert.equal(Number(range.props.max), 200, '上限不是 200%')
  // 170% 是最有说服力的：它在"三档"那套里根本落不下去。
  range.props.onChange({ target: { value: '170' } })
  range.props.onPointerUp({ target: { value: '170' } })
  const post = calls.filter((call) => call.type === 'fetch' && call.init?.method === 'POST').pop()
  assert.equal(JSON.parse(post.init.body).wallpaperSaturate, 1.7, `170% 落盘成了 ${post.init.body}`)
})

await check('主题滑杆：拖动期间不触发 React 重渲染（丝滑的关键）', async () => {
  // 用户报"滑杆不够丝滑"。根因不是算法慢（一次渲染才 0.68ms），而是**每格拖动事件
  // 都 setDrag → 整个主题面板重渲染**：14 次 presetPreview（5 张预设卡 + 8 个色块
  // + 1 次读数）全跑一遍。60–240 事件/秒叠起来就是每秒几十到上百毫秒的主线程占用，
  // 滑块跟手但页面发涩。
  //
  // 现在的分工：每格只改 DOM（滑块 value + 读数）+ 让壁纸层重画，**零 React 渲染**；
  // 只有"开始拖"和"松手"才动 state。这条测试锁的就是"每格不许动 state"。
  const { render, calls, React } = await loadClient({ status: themeStatus({ scrim: 0, blur: 0, saturate: 1 }) })
  let tree = await openThemeTab(render)
  const scrim = () => findByClass(tree, 'dsa-set-range').find((node) => node.props['aria-label'] === '遮罩厚度')
  /** 遮罩那根滑杆右侧读数的**真 DOM 节点**（不是组件树里的文本）。 */
  const scrimReadout = () => {
    const row = findByClass(tree, 'dsa-set-row').find((n) => texts({ children: n.children }).includes('遮罩厚度'))
    return findByClass(row, 'dsa-set-sec')[0].__refNode
  }

  // 拖第一格：这一刻允许更新 state 一次（为了切 disabled）。
  scrim().props.onChange({ target: { value: '20' } })
  tree = await render()
  // 20% 就是 20% —— 读数是真值，不再换算成什么"量程位置"。
  assert.equal(scrimReadout().textContent, '20%', `第一格没写进 DOM：${scrimReadout().textContent}`)

  // 再拖 20 格：**一格都不许再更新 state**（真 React 里那就是 20 次整页重渲染），
  // 但 DOM 读数必须一路跟着走。
  const beforeUpdates = React.__stateUpdates().length
  for (let i = 0; i < 20; i += 1) {
    scrim().props.onChange({ target: { value: String(22 + i) } })
  }
  const updates = React.__stateUpdates().length - beforeUpdates
  assert.equal(updates, 0, `拖了 20 格却更新了 ${updates} 次 state（真 React 会整页重渲染 ${updates} 次）`)
  // 期间没有任何一次 render()：如果组件还靠 setGrip 驱动，DOM 读数就还停在 20%。
  assert.notEqual(scrimReadout().textContent, '20%', '拖了 20 格，读数一点没变 —— 说明没有直接改 DOM')
  assert.match(scrimReadout().textContent, /^\d+%$/, `读数不是百分比：${scrimReadout().textContent}`)
  // 松手只落盘一次。
  const postsBefore = calls.filter((call) => call.type === 'fetch' && call.init?.method === 'POST').length
  scrim().props.onPointerUp({ target: { value: '60' } })
  const postsAfter = calls.filter((call) => call.type === 'fetch' && call.init?.method === 'POST').length
  assert.equal(postsAfter - postsBefore, 1, `松手应该只落盘一次，实际 ${postsAfter - postsBefore} 次`)
  assert.equal(JSON.parse(calls.filter((call) => call.type === 'fetch' && call.init?.method === 'POST').pop().init.body).wallpaperScrim, 0.6)
})

await check('主题滑杆：拖动中途发生重渲染，滑块不许被写回拖动前的值', async () => {
  // 用户报的"一抖一抖"的直接成因：本地值若只在"开始拖"那一刻记一次，之后每一格的
  // 值只写在 DOM 上；此时任何一次无关的重渲染（busy 开关、消息自动消失、背景层广播）
  // 都会把受控 input 的 value 写成**开头记的那一格** —— 滑块当场弹回起点，
  // 下一次鼠标移动再把它顶回去。
  //
  // 现在真值在 gripRef 里每格都更新，重渲染读的是它，所以拖到第几格就渲染第几格。
  const { render } = await loadClient({ status: themeStatus({ scrim: 0, blur: 0, saturate: 1 }) })
  let tree = await openThemeTab(render)
  const range = () => findByClass(tree, 'dsa-set-range').find((node) => node.props['aria-label'] === '遮罩厚度')
  const readout = () => {
    const row = findByClass(tree, 'dsa-set-row').find((node) => texts({ children: node.children }).includes('遮罩厚度'))
    return findByClass(row, 'dsa-set-sec')[0].children.join('')
  }
  // 滑杆是**非受控**的（不给 value），值只能从它自己的 DOM 节点读 —— 这本身就是约定：
  // 传了 value，React 会在每个事件后把控件回写成"拖动第一格"的值（真浏览器实测）。
  const inputValue = () =>
    findByClass(tree, 'dsa-set-range').find((node) => node.props['aria-label'] === '遮罩厚度').__refNode.value
  range().props.onChange({ target: { value: '20' } })
  tree = await render()
  range().props.onChange({ target: { value: '41' } })
  // 这次 render 相当于"拖动期间来了一次无关的重渲染"。
  tree = await render()
  assert.equal(inputValue(), '41', `重渲染把滑块写回了 ${inputValue()}（应该还是 41）`)
  assert.equal(readout(), '41%', `重渲染把读数写回了 ${readout()}（应该还是 41%）`)
})

await check('主题滑杆：range 必须是非受控的（受控 + 手改 DOM 会被 React 回写）', async () => {
  // 真浏览器实测的坑：`value={X}` 的 range 会在**每个离散事件后**被 React 恢复成
  // "上次渲染的 props 值"。拖动期间我们故意不重渲染（一渲染就是整页重绘），于是每次
  // 事件后滑块都被写回拖动开始那一格 —— 读数 80%、滑块却贴在左边，用户看到的就是
  // "都拉满 80% 了，还没占满"。所以这根 range **不许有 value / defaultValue**，
  // 值只由 paintSliderDom 与 ref 回调写。
  const { render } = await loadClient({ status: themeStatus({ scrim: 0.4, blur: 6, saturate: 1.5 }) })
  const tree = await openThemeTab(render)
  for (const node of findAll(tree, 'dsa-set-range').filter((item) => ['遮罩厚度', '壁纸模糊', '色彩浓度'].includes(item.props['aria-label']))) {
    assert.equal(node.props.value, undefined, `${node.props['aria-label']} 还是受控的（传了 value）`)
    assert.equal(node.props.defaultValue, undefined, `${node.props['aria-label']} 传了 defaultValue，同样会被 React 回写`)
  }
})

await check('主题滑杆：松手后回包没落地之前，滑块不许弹回旧值', async () => {
  // "波动"里最扎眼的那一下：松手瞬间滑块**弹回拖动前的位置**，等回包到了再跳回来。
  // 根因是松手就把本地值清掉、界面立刻回到 cfg 里的旧值（而 cfg 要等 POST 回包才更新）。
  //
  // 现在的约定：松手后本地值继续顶着（只把 live 置 false），回包落地才交还给 cfg。
  const { render, gates } = await loadClient({
    status: themeStatus({ scrim: 0, blur: 0, saturate: 1 }),
    // 回包压在闸门里 —— 真实网络里那几毫秒就是这个窗口。
    // 只拦遮罩那一次 POST：GET 状态与其它请求照常立刻回，否则连首屏都挂在那儿。
    responseFor: (body) =>
      body !== null && typeof body === 'object' && 'wallpaperScrim' in body
        ? themeStatus({ scrim: body.wallpaperScrim, blur: 0, saturate: 1 })
        : undefined,
  })
  let tree = await openThemeTab(render)
  const range = () => findByClass(tree, 'dsa-set-range').find((node) => node.props['aria-label'] === '遮罩厚度')
  const readout = () => {
    const row = findByClass(tree, 'dsa-set-row').find((node) => texts({ children: node.children }).includes('遮罩厚度'))
    return findByClass(row, 'dsa-set-sec')[0].children.join('')
  }
  range().props.onChange({ target: { value: '40' } })
  tree = await render()
  range().props.onPointerUp({ target: { value: '40' } })
  tree = await render()
  const inputValue = () =>
    findByClass(tree, 'dsa-set-range').find((node) => node.props['aria-label'] === '遮罩厚度').__refNode.value
  assert.equal(gates.length, 1, `松手没有落盘（闸门里 ${gates.length} 个请求）`)
  assert.equal(readout(), '40%', `回包还没到，读数就弹回 ${readout()} 了`)
  assert.equal(inputValue(), '40', `回包还没到，滑块就被写回 ${inputValue()} 了`)
  // 回包落地：服务器回的就是 40%，界面不该有任何跳动。
  gates[0].settle()
  for (let i = 0; i < 40; i += 1) await Promise.resolve()
  tree = await render()
  assert.equal(readout(), '40%', `回包落地后读数变成了 ${readout()}`)
  assert.equal(inputValue(), '40', `回包落地后滑块变成了 ${inputValue()}`)
})

await check('主题滑杆：先发的请求后回来时，不许把刚调好的值盖回去', async () => {
  // 用户报"三根滑杆时不时还原为默认值"的**另一半**原因：连着动两根滑杆时两个 POST
  // 同时在飞，而回包顺序不保证与发出顺序一致。先发的那个带着**旧状态**回来，
  // 会把已经调好的值盖回去 —— 界面上就是"刚调好，过一下自己弹回默认"。
  // 磁盘上其实是对的，错的只是这份界面状态，所以刷新一下又好。
  //
  // 关键：假宿主必须**累积**状态（和真宿主一样，每次写都在上一份基础上改），
  // 这样每个回包都是"那一刻的完整真相"—— 于是后到的旧回包确实带着过期的 blur。
  let fake = themeStatus({ scrim: 0, blur: 0, saturate: 1 })
  const { render, calls, gates } = await loadClient({
    status: fake,
    responseFor: (body) => {
      if (body === null || typeof body !== 'object') return undefined
      if (body.wallpaperScrim === undefined && body.wallpaperBlur === undefined) return undefined
      if (body.wallpaperScrim !== undefined) fake = themeStatus({ ...fake.wallpaper, scrim: body.wallpaperScrim })
      if (body.wallpaperBlur !== undefined) fake = themeStatus({ ...fake.wallpaper, blur: body.wallpaperBlur })
      return fake
    },
  })
  let tree = await openThemeTab(render)
  const range = (label) => findByClass(tree, 'dsa-set-range').find((node) => node.props['aria-label'] === label)
  const readOf = (label) => {
    const row = findByClass(tree, 'dsa-set-row').find((node) => texts({ children: node.children }).includes(label))
    return findByClass(row, 'dsa-set-sec').map((node) => node.children.join(''))[0]
  }
  // 第一次：遮罩 → 40%（POST A 在飞）。
  range('遮罩厚度').props.onPointerUp({ target: { value: '40' } })
  // 第二次：模糊 → 6px（滑杆刻度是 48%）。B 比 A 新。
  range('壁纸模糊').props.onPointerUp({ target: { value: '48' } })
  assert.equal(gates.length, 2, `应该有两个待回包请求，实际 ${gates.length}`)
  // **先让 B（新的）回来**，再让 A（旧的）回来 —— 这就是乱序。
  gates[1].settle()
  for (let i = 0; i < 40; i += 1) await Promise.resolve()
  gates[0].settle()
  for (let i = 0; i < 40; i += 1) await Promise.resolve()
  tree = await render()
  // 最终必须停在最后调好的那组值上：迟到的旧回包不许把 blur 拨回 0。
  assert.equal(readOf('遮罩厚度'), '40%', `遮罩被旧回包改掉了：${readOf('遮罩厚度')}`)
  assert.equal(readOf('壁纸模糊'), '48%', `模糊被旧回包盖回默认值了：${readOf('壁纸模糊')}`)
})

await check('主题壁纸：换预设不清三根滑杆（用户调好的值要留在盘上）', async () => {
  // 这条盯的是**磁盘**那一侧：`paintNow` 与 POST 载荷都不许再把三根滑杆写成 'auto'。
  // 宿主把 'auto' 当成"删除这个键"，所以清一次 = 用户调的值真没了（刷新也回不来）。
  const { render, calls } = await loadClient({ status: themeStatus({ scrim: 0.4, blur: 6, saturate: 1.5 }) })
  const tree = await openThemeTab(render)
  const frost = findAll(tree, 'dsa-set-preset').find((node) => texts({ children: node.children }).includes('亮'))
  frost.props.onClick()
  // ① POST 载荷里只有预设自己的键。
  const post = calls.filter((call) => call.type === 'fetch' && call.init?.method === 'POST').pop()
  const body = JSON.parse(post.init.body)
  for (const key of ['wallpaperScrim', 'wallpaperBlur', 'wallpaperSaturate']) {
    assert.ok(!(key in body), `换预设把 ${key} 写进了请求体：${post.init.body}`)
  }
  // ② 当场广播给背景层的那份配置里，三根滑杆仍是用户的数值（不是 'auto'、不是 0）。
  const sync = calls.filter((call) => call.type === 'event' && call.name === 'dsa:wall-sync').pop()
  assert.ok(sync, '换预设没有广播 dsa:wall-sync')
  assert.equal(sync.detail.scrim, 0.4, `广播里遮罩变成了 ${sync.detail.scrim}`)
  assert.equal(sync.detail.blur, 6, `广播里模糊变成了 ${sync.detail.blur}`)
  assert.equal(sync.detail.saturate, 1.5, `广播里色彩浓度变成了 ${sync.detail.saturate}`)
})

await check('主题壁纸：让位变量必须带 !important（内核把令牌写成 body 内联样式）', async () => {
  const { calls } = await loadClient({ status: themeStatus() })
  // 壁纸层在 apply 里异步拉一次 manage，等它铺完。
  await new Promise((resolve) => setTimeout(resolve, 60))
  const sheets = calls.filter((call) => call.type === 'style')
  assert.ok(sheets.length > 0, '壁纸层没有写出样式表')
  const css = sheets[sheets.length - 1].el.textContent
  // 内核的 ThemePresenter 用 body.style.setProperty 落地令牌；不带 !important 的作者声明
  // 必输给内联，令牌顶不掉 → 列底还是内核那套实色 → 壁纸永远看不见。
  //
  // 列底出厂是 **transparent**（玻璃厚度 0 = 壁纸原样）。透明也要带 !important ——
  // 内核把令牌写成 body 内联样式，不带 !important 的作者声明一律输给它。
  assert.match(
    css,
    /--dsw-alias-bg-base:\s*(transparent|rgba\([^)]*\))\s*!important/,
    `让位变量没带 !important，会被 body 内联样式压住：${css.slice(0, 200)}`,
  )
  assert.match(css, /--dsw-specific-sidebar-fill:\s*(transparent|rgba\([^)]*\))\s*!important/, '侧栏底没接管')
  // 画布本身也要放空：首帧 CSS 直接写死 background-color（深色主题是 #151517）。
  // body 必须显式 transparent —— 少它一份，壁纸就被那层实色盖死。
  assert.match(css, /body\{background:transparent !important/, 'body 底色没放空')
  // html 上垫的是壁纸自己的代表色，而不是留空：掉层时退化成本色，不闪白。
  assert.match(css, /html\{background-color:#[0-9a-f]{6} !important/, 'html 没垫壁纸底色')
  // 输入框 / @ 菜单必须接手成**带 α 的玻璃**：不接的话它们还是玻璃色（不透明），
  // 壁纸在输入框底下完全看不见 —— 用户报的"输入框不透"就是这一行没接。
  assert.match(css, /--dsw-specific-input-major:\s*rgba\(\d+, \d+, \d+, 0?\.\d+\)\s*!important/, `输入框底不是带 α 的玻璃：${css.slice(0, 200)}`)
  assert.match(css, /--dsw-specific-menu:\s*rgba\(/, '@ 菜单底不是带 α 的玻璃')
  assert.match(css, /--dsw-alias-button-floating-fill:\s*rgba\(/, '框内按钮没跟着玻璃化')
  // 卡片（列/底栏那块实面）**不动**：它得托住正文，改成半透等于把正文交给壁纸。
  assert.match(css, /--dsa-card:\s*#[0-9a-f]{6}/, '卡片底被改成了半透明 —— 正文会压在壁纸上')
  // 绝不碰字号的通道。
  assert.ok(!/font-size|font-family|--dsh-content-font-size/.test(css), `样式表里混进了排版变量：${css}`)
})

await check('主题壁纸：换预设立刻广播给背景层（不用等回包也不用刷新）', async () => {
  const { render, calls } = await loadClient({ status: themeStatus() })
  const tree = await openThemeTab(render)
  const matte = findAll(tree, 'dsa-set-preset').find((node) => texts({ children: node.children }).includes('暗'))
  assert.ok(matte, '没有预设卡')
  // 背景层是常驻的独立实例，只靠 window 事件桥接：不广播就只改了设置页自己的卡片，
  // 界面要等下次刷新才变。**点下去当场**就得广播，不能等回包 —— 那几毫秒就是"点了没动静"。
  matte.props.onClick()
  const immediate = calls.filter((call) => call.type === 'event' && call.name === 'dsa:wall-sync')
  assert.equal(immediate.length, 1, `点下去应该当场广播一次，实际 ${immediate.length} 次`)
  // 且这次带的是**亮自己的**观感：残留的滑杆值不能盖住预设。
  // 预设只负责颜色，遮挡一律回 0 —— 点预设 = 回到"壁纸原样透出来"。
  assert.equal(immediate[0].detail.preset, 'night')
  assert.equal(immediate[0].detail.scrim, 0, `预设不该自带幕浓度：${immediate[0].detail.scrim}`)
  assert.equal(immediate[0].detail.glassAlpha, 0, `预设不该自带玻璃遮挡：${immediate[0].detail.glassAlpha}`)
  assert.equal(immediate[0].detail.surfaceBlur, 22, `预设自带的磨砂半径丢了：${immediate[0].detail.surfaceBlur}`)
  assert.equal(immediate[0].detail.enabled, true)
  // 回包到了再同步一次（服务器是唯一真相）。值一样，背景层会自己短路。
  await new Promise((resolve) => setTimeout(resolve, 30))
  const after = calls.filter((call) => call.type === 'event' && call.name === 'dsa:wall-sync')
  assert.ok(after.length >= 2, `回包后应该再同步一次，实际 ${after.length} 次`)
  assert.ok(after[after.length - 1].detail && typeof after[after.length - 1].detail.enabled === 'boolean', '广播里没带 wallpaper 段')
})
await check('主题壁纸：点预设当场换掉屏幕上的观感（不止广播，画面真的重画）', async () => {
  const { render, calls } = await loadClient({ status: themeStatus() })
  const tree = await openThemeTab(render)
  const before = calls.filter((call) => call.type === 'style')
  const beforeCss = before.length > 0 ? before[before.length - 1].el.textContent : ''
  // 任何面板上都不许再叠背后模糊：它会糊掉列里自己的正文 —— 这正是
  // "设置页的字清楚、对话窗口整个是模糊的"那个 bug 的根。
  assert.ok(!/backdrop-filter:\s*blur/.test(beforeCss), `样式表里又出现了背后模糊：${beforeCss.slice(0, 200)}`)
  // 但壁纸层自己该糊：磨砂感只能落在壁纸层上，才不影响字。
  // **只由「壁纸模糊」那根管**（`blur`），不再吃预设的 surfaceBlur —— 用后者当主模糊
  // 会让「可读优先」一上手就把壁纸糊掉 24px，用户看到的就是"背景不显示"。
  assert.ok(beforeCss.includes('filter:blur(0px)'), `壁纸层不该被预设糊掉：${beforeCss.slice(0, 200)}`)
  const matte = findAll(tree, 'dsa-set-preset').find((node) => texts({ children: node.children }).includes('亮'))
  assert.ok(matte, '找不到「亮」预设')
  matte.props.onClick()
  // 就在点击当下读：这一层是同步画完的。不能等回包 —— 垫片的 POST 只会把**传进来的**
  // 状态原样吐回来（它不模拟写盘），再等下去就等于断言"回包把画面盖回去"。
  const after = calls.filter((call) => call.type === 'style')
  const css = after[after.length - 1].el.textContent
  // 换预设必须真的换掉观感。七套预设的颜色（釉色）与磨砂半径都不同，但「亮」和
  // 「可读优先」是**同一套釉色**（只差磨砂半径，这是照参考实现的设计）—— 所以这里
  // 换成点「暗」：它的釉色是深蓝，浮层色必须真的变。
  const night = findAll(tree, 'dsa-set-preset').find((node) => texts({ children: node.children }).includes('暗'))
  assert.ok(night, '找不到「暗」预设')
  night.props.onClick()
  const css2 = calls.filter((call) => call.type === 'style').pop().el.textContent
  const layer3 = (text) => (text.match(/--dsw-alias-bg-layer-3:(#[0-9a-f]{6})/) || [])[1]
  assert.ok(layer3(css2) !== undefined, `样式表里没有浮层色：${css2.slice(-320)}`)
  assert.notEqual(css2, beforeCss, '换预设没重画样式表，说明只是换了卡片')
  assert.notEqual(layer3(css2), layer3(beforeCss), '浮层色没跟着预设换，界面看起来不会变')
})

console.log('== 壁纸视频卡住自愈（用户报"动着动着不动了"）==')

await check('壁纸视频有自愈看门狗：该播却没播时才拉，且尊重减少动态效果', () => {
  // 这条是回归锚点。事故形状：主题视频停在半路不再动，而这条链路上当时
  // **只有 visibilitychange 一个恢复入口** —— 任何不翻转 document.hidden 的暂停
  // （Chromium 媒体优化、系统休眠唤醒、遮挡解除）都会让它永久卡死。
  const src = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')

  // ① 必须真的有一个周期性检查，并且条件齐全。
  assert.ok(src.includes('HEAL_TICK_MS'), '缺少自愈轮询的间隔常量')
  const heal = /const healIfStalled = \(\) => \{([\s\S]{0,900}?)\n      \}/.exec(src)
  assert.ok(heal !== null, '找不到 healIfStalled —— 壁纸视频停了就再没人拉回来')
  const body = heal[1]
  assert.ok(body.includes('document.hidden'), '看门狗没有排除"页面本来就不可见"')
  assert.ok(body.includes('el.autoplay'), '看门狗没有区分"本来就该播"与"故意不播"')
  assert.ok(body.includes('el.paused'), '看门狗没有判断"确实停住了"')
  assert.ok(body.includes('el.ended'), '看门狗没有排除"播到结尾"')
  assert.ok(body.includes('.play()'), '看门狗没有真的去起播')

  // ② 看门狗必须挂在真实定时器上，且在 destroy 里收掉（否则销毁后还在碰 DOM）。
  assert.ok(/setInterval\(healIfStalled/.test(src), '看门狗没有挂到 setInterval')
  assert.ok(/startHeal\(\)/.test(src), '看门狗没被启动')
  const destroy = src.slice(src.indexOf('destroy() {'), src.indexOf('destroy() {') + 600)
  assert.ok(/stopHeal\(\)/.test(destroy), 'destroy 没有停掉看门狗')

  // ③ 减少动态效果：只关 autoplay（= 从头就不播），**不许再关 loop**。
  //    关 loop 的旧写法意味着"允许播、但不回头"，一旦有别的路径让它跑起来，
  //    就停在最后一帧 —— 那正是用户看到的那个症状。
  const reduceBlock = /prefers-reduced-motion: reduce[\s\S]{0,400}?\n          \}/.exec(src)
  assert.ok(reduceBlock !== null, '找不到 prefers-reduced-motion 分支')
  assert.ok(reduceBlock[0].includes('next.autoplay = false'), '减少动态效果没有关掉 autoplay')
  assert.ok(!reduceBlock[0].includes('next.loop = false'), '减少动态效果又在关 loop —— 会停在最后一帧')
})

console.log('')
if (failures > 0) {
  console.error(`${failures} 项失败`)
  process.exit(1)
}
console.log('CLIENT TEST PASS')