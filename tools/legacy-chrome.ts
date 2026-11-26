/**
 * 老内核（Chromium < 115）JS API 补齐。
 *
 * 背景：Dify 1.15 的 browserslist 是 `last 1 Chrome version` / `and_chr >= 126`，
 * 构建产物不做 downlevel，直接使用现代 API。Chromium 内核停在 90 时，
 * 以下 API 原生不存在，一命中就是 TypeError，页面直接崩。
 *
 * 本模块要求：
 * 1、**零依赖**。它会被放在 instrumentation-client.ts 的第一个 import，
 *    依赖任何模块都可能导致那些模块先求值、先用到缺失 API。
 * 2、**只补不改**。所有 define 都先检测原生实现，存在则跳过，不覆盖。
 * 3、**幂等**。重复 import 不会重复安装。
 * 4、属性描述符与原生一致（non-enumerable / writable / configurable）。
 *
 * 清单依据 2026-11 在 Chromium 90.0.4430.246 上的实测结果，
 * 括号内是 `.next/static/chunks` 里统计到的真实调用点数。
 */

type AnyFunction = (...args: any[]) => any
type AnyRecord = Record<string, any>

const INSTALLED_FLAG = '__DIFY_LEGACY_POLYFILL_INSTALLED__'

// 注意 target 必须是 any：Array.prototype / PromiseConstructor / typeof Object
// 这些类型都没有 string 索引签名，声明成 Record<string, any> 会触发 TS 报错。
function defineMember(target: any, key: string, value: unknown) {
  if (!target)
    return
  // 已存在原生实现则不覆盖（注意：key 存在但值为 undefined 的情况要覆盖）
  if (typeof target[key] === 'function')
    return
  try {
    Object.defineProperty(target, key, {
      value,
      writable: true,
      enumerable: false,
      configurable: true,
    })
  }
  catch {
    // 宿主对象上属性不可配置时放弃，不影响主流程
  }
}

// ---------------------------------------------------------------- structuredClone (Chrome 98, 产物 27 处)

/**
 * 原生 structuredClone 无法降级为 JSON 深拷贝（会丢 Date/Map/Set/ArrayBuffer、
 * 会因循环引用直接抛错），所以这里写一个完整的结构化克隆。
 *
 * 宿主对象（Blob/File/ImageData/DOM 节点/函数）原生会抛 DataCloneError，
 * 这里降级为返回原引用——宁可共享引用也不要让业务崩掉。
 */
function cloneDeep<T>(input: T, seen: Map<unknown, unknown>, path: unknown[] = []): T {
  if (input === null || typeof input !== 'object')
    return input

  const value = input as AnyRecord

  if (seen.has(value))
    return seen.get(value) as T

  // 循环引用防护（同时也会被自身路径检测兜住）
  if (path.includes(value))
    return value as unknown as T

  if (value instanceof Date)
    return new Date(value.getTime()) as unknown as T
  if (value instanceof RegExp)
    return new RegExp(value.source, value.flags) as unknown as T
  if (value instanceof ArrayBuffer)
    return value.slice(0) as unknown as T
  if (ArrayBuffer.isView(value)) {
    if (value instanceof DataView)
      return new DataView(value.buffer.slice(0), value.byteOffset, value.byteLength) as unknown as T
    // TypedArray 构造器接受同类实例并复制数据
    return new (value.constructor as any)(value) as unknown as T
  }

  if (value instanceof Map) {
    const out = new Map()
    seen.set(value, out)
    value.forEach((v: unknown, k: unknown) => {
      out.set(cloneDeep(k, seen, path.concat(value)), cloneDeep(v, seen, path.concat(value)))
    })
    return out as unknown as T
  }

  if (value instanceof Set) {
    const out = new Set()
    seen.set(value, out)
    value.forEach((v: unknown) => out.add(cloneDeep(v, seen, path.concat(value))))
    return out as unknown as T
  }

  if (Array.isArray(value)) {
    const out: unknown[] = []
    seen.set(value, out)
    for (let i = 0; i < value.length; i++)
      out[i] = cloneDeep(value[i], seen, path.concat(value))
    return out as unknown as T
  }

  if (value instanceof Error) {
    const out = new (value.constructor as any)(value.message)
    out.name = value.name
    if ('stack' in value)
      out.stack = value.stack
    if ('cause' in value)
      out.cause = cloneDeep((value as AnyRecord).cause, seen, path.concat(value))
    seen.set(value, out)
    return out as unknown as T
  }

  // 宿主对象（Blob / File / ImageData / ImageBitmap / DOM 节点等）无法克隆，返回原引用
  const tag = Object.prototype.toString.call(value)
  if (tag !== '[object Object]')
    return input

  const out = Object.create(Object.getPrototypeOf(value))
  seen.set(value, out)
  for (const key of Object.keys(value))
    out[key] = cloneDeep(value[key], seen, path.concat(value))
  return out as unknown as T
}

function structuredClonePolyfill<T>(input: T): T {
  return cloneDeep(input, new Map())
}

// ---------------------------------------------------------------- Promise.withResolvers (Chrome 119, 产物 42 处)

function promiseWithResolvers<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// ---------------------------------------------------------------- crypto.randomUUID (Chrome 92, 产物 15 处)

function randomUUIDPolyfill(): string {
  const bytes = new Uint8Array(16)
  const cryptoObj = globalThis.crypto
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function')
    cryptoObj.getRandomValues(bytes)
  else
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256)

  // 版本 4 + RFC 4122 variant
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80

  const hex: string[] = []
  for (let i = 0; i < 16; i++) hex.push(bytes[i].toString(16).padStart(2, '0'))
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`
}

// ---------------------------------------------------------------- Object.groupBy / Map.groupBy (Chrome 117)

function objectGroupBy(items: Iterable<unknown>, callback: (item: unknown, index: number) => PropertyKey) {
  const out: AnyRecord = Object.create(null)
  let index = 0
  for (const item of items) {
    const key = String(callback(item, index++))
    if (Object.prototype.hasOwnProperty.call(out, key))
      out[key].push(item)
    else
      out[key] = [item]
  }
  return out
}

function mapGroupBy(items: Iterable<unknown>, callback: (item: unknown, index: number) => unknown) {
  const out = new Map<unknown, unknown[]>()
  let index = 0
  for (const item of items) {
    const key = callback(item, index++)
    const bucket = out.get(key)
    if (bucket)
      bucket.push(item)
    else
      out.set(key, [item])
  }
  return out
}

// ---------------------------------------------------------------- Array.prototype 新方法 (Chrome 92~110)

function arrayFindLast(this: unknown[], predicate: AnyFunction, thisArg?: unknown) {
  for (let i = this.length - 1; i >= 0; i--) {
    if (predicate.call(thisArg, this[i], i, this))
      return this[i]
  }
  return undefined
}

function arrayFindLastIndex(this: unknown[], predicate: AnyFunction, thisArg?: unknown) {
  for (let i = this.length - 1; i >= 0; i--) {
    if (predicate.call(thisArg, this[i], i, this))
      return i
  }
  return -1
}

function arrayToReversed(this: unknown[]) {
  return this.slice().reverse()
}

function arrayToSorted(this: unknown[], compareFn?: AnyFunction) {
  return this.slice().sort(compareFn as any)
}

function arrayToSpliced(this: unknown[], start: number, deleteCount?: number, ...items: unknown[]) {
  const copy = this.slice()
  // 只传 start 时语义是「删到末尾」
  if (arguments.length <= 1)
    copy.splice(start)
  else
    copy.splice(start, deleteCount as number, ...items)
  return copy
}

function arrayWith(this: unknown[], index: number, value: unknown) {
  const len = this.length
  const actual = index < 0 ? len + index : index
  if (actual < 0 || actual >= len)
    throw new RangeError('Invalid index')
  const copy = this.slice()
  copy[actual] = value
  return copy
}

// ---------------------------------------------------------------- String.prototype.at / Array.prototype.at (Chrome 92)

function atPolyfill(this: string | unknown[], index: number) {
  const len = this.length
  const actual = index < 0 ? len + index : index
  if (actual < 0 || actual >= len)
    return undefined
  return (this as AnyRecord)[actual]
}

// ---------------------------------------------------------------- Object.hasOwn (Chrome 93)

function objectHasOwn(target: unknown, key: PropertyKey) {
  return Object.prototype.hasOwnProperty.call(target, key)
}

// ---------------------------------------------------------------- AbortSignal 静态与实例方法 (Chrome 100~116)

function abortSignalAbort(reason?: unknown) {
  const controller = new AbortController()
  try {
    controller.abort(reason)
  }
  catch {
    controller.abort()
  }
  return controller.signal
}

function abortSignalTimeout(ms: number) {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    try {
      controller.abort(new DOMException('signal timed out', 'TimeoutError'))
    }
    catch {
      // Chrome 90 的 abort() 不接受 reason 参数
      controller.abort()
    }
  }, ms)
  // 让 Node 侧（SSR / 测试）不被定时器挂住
  const maybeUnref = (timer as AnyRecord)?.unref
  if (typeof maybeUnref === 'function')
    maybeUnref.call(timer)
  return controller.signal
}

function abortSignalAny(signals: AbortSignal[]) {
  const controller = new AbortController()

  const alreadyAborted = signals.find(signal => signal.aborted)
  if (alreadyAborted) {
    try {
      controller.abort((alreadyAborted as AnyRecord).reason)
    }
    catch {
      controller.abort()
    }
    return controller.signal
  }

  for (const signal of signals) {
    signal.addEventListener('abort', () => {
      try {
        controller.abort((signal as AnyRecord).reason)
      }
      catch {
        controller.abort()
      }
    }, { once: true })
  }

  return controller.signal
}

function abortSignalThrowIfAborted(this: AbortSignal) {
  if (this.aborted) {
    const reason = (this as AnyRecord).reason
    throw reason !== undefined ? reason : new DOMException('signal is aborted without reason', 'AbortError')
  }
}

// ---------------------------------------------------------------- URL.canParse (Chrome 120)

function urlCanParse(input: string, base?: string) {
  try {
    // 构造函数会在非法 URL 时抛 TypeError
    // eslint-disable-next-line no-new
    new URL(input, base)
    return true
  }
  catch {
    return false
  }
}

// ---------------------------------------------------------------- 安装

export function installLegacyChromePolyfills() {
  const scope = globalThis as AnyRecord
  if (scope[INSTALLED_FLAG])
    return
  scope[INSTALLED_FLAG] = true

  // structuredClone / Promise.withResolvers
  defineMember(scope, 'structuredClone', structuredClonePolyfill)
  defineMember(Promise, 'withResolvers', promiseWithResolvers)

  // Object.groupBy / Map.groupBy
  defineMember(Object, 'groupBy', objectGroupBy)
  defineMember(Map, 'groupBy', mapGroupBy)

  // Object.hasOwn
  defineMember(Object, 'hasOwn', objectHasOwn)

  // Array / String 原型方法
  defineMember(Array.prototype, 'at', atPolyfill)
  defineMember(String.prototype, 'at', atPolyfill)
  defineMember(Array.prototype, 'findLast', arrayFindLast)
  defineMember(Array.prototype, 'findLastIndex', arrayFindLastIndex)
  defineMember(Array.prototype, 'toReversed', arrayToReversed)
  defineMember(Array.prototype, 'toSorted', arrayToSorted)
  defineMember(Array.prototype, 'toSpliced', arrayToSpliced)
  defineMember(Array.prototype, 'with', arrayWith)

  // crypto.randomUUID
  if (scope.crypto)
    defineMember(scope.crypto, 'randomUUID', randomUUIDPolyfill)
  else if (typeof scope.Crypto !== 'undefined' && scope.Crypto.prototype)
    defineMember(scope.Crypto.prototype, 'randomUUID', randomUUIDPolyfill)

  // AbortSignal
  defineMember(scope.AbortSignal, 'abort', abortSignalAbort)
  defineMember(scope.AbortSignal, 'timeout', abortSignalTimeout)
  defineMember(scope.AbortSignal, 'any', abortSignalAny)
  defineMember(scope.AbortSignal?.prototype, 'throwIfAborted', abortSignalThrowIfAborted)

  // URL.canParse (Chrome 120)
  defineMember(scope.URL, 'canParse', urlCanParse)
}

installLegacyChromePolyfills()
