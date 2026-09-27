import { describe, expect, it } from 'vitest'
import { Config, readValue } from '../src/config.js'

/**
 * 跨宿主版本的取值与 schema 护栏。
 *
 * dsh >= 0.1.7 会把 volatile 字段以 `Volatile<T>`（带 .get()）递给插件，旧版本给的是普通值。
 * readValue 必须两种形态都取到原始值，否则升级后会出现「配置读成对象、链式调用崩溃」。
 * 同理，Config schema 在 0.1.5/0.1.6（schemastery 无 .volatile）与 0.1.7+ 都要能正常构建。
 */

describe('readValue — 普通值原样返回', () => {
  it('字符串与数字原样返回', () => {
    expect(readValue('https://outline.example.com')).toBe('https://outline.example.com')
    expect(readValue(15000)).toBe(15000)
    expect(readValue(0)).toBe(0)
    expect(readValue('')).toBe('')
  })

  it('空值与 undefined 不抛异常', () => {
    expect(readValue(undefined)).toBeUndefined()
    expect(readValue(null)).toBeNull()
  })

  it('普通对象不会被误判为包装值', () => {
    const plain = { 部署: ['上线', '发布'] }
    expect(readValue(plain)).toBe(plain)
  })

  it('数组不会被误判为包装值', () => {
    const list = ['上线', '发布']
    expect(readValue(list)).toBe(list)
  })
})

describe('readValue — 解包 Volatile<T>', () => {
  it('取到 .get() 的原始值', () => {
    const wrapped = { get: () => 'https://outline.example.com' }
    expect(readValue<string>(wrapped as never)).toBe('https://outline.example.com')
  })

  it('数值型 volatile 字段解包后仍是数字', () => {
    expect(readValue<number>({ get: () => 60000 } as never)).toBe(60000)
  })

  it('对象型 volatile 字段（synonyms）解包后内容正确', () => {
    const inner = { 部署: ['上线'] }
    expect(readValue({ get: () => inner } as never)).toBe(inner)
  })

  it('解包结果可用于链式调用（模拟 config.baseUrl.trim()）', () => {
    const value = readValue<string>({ get: () => ' https://a.example.com ' } as never)
    expect(value.trim()).toBe('https://a.example.com')
  })
})

describe('Config schema — 跨版本可构建', () => {
  it('在当前 schemastery 上正常构建并保留默认值', () => {
    expect(Config).toBeDefined()
    expect(Config.meta).toBeDefined()
    const dict = Config.dict ?? {}
    expect(Object.keys(dict).sort()).toEqual([
      'apiToken', 'baseUrl', 'cacheTtlMs', 'localSaveDir',
      'searchLimit', 'synonyms', 'timeoutMs', 'writablePaths',
    ])
  })

  it('未设置 volatile 时不破坏常规解析', () => {
    const parsed = Config({ baseUrl: 'https://outline.example.com', timeoutMs: 15000 })
    expect(parsed.baseUrl).toBe('https://outline.example.com')
    expect(parsed.timeoutMs).toBe(15000)
  })
})
