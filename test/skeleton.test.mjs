// 骨架扫描器契约测试（design.md §2.4 / implement.md §4.4）。
//
// 这个文件存在的理由不是"跑一遍看看有没有崩"，而是把设计里那几条**诚实约束**钉死：
// 覆盖外扩展名必须报 supported:false 而不是空数组；零命中的窗口必须仍然带着
// supported/truncated/excerptChars 三个事实；命中上限必须真的生效。这些约束一旦回退，
// 渲染器就会把"没扫到"说成"不存在"——那正是 design.md §2.4 禁止的误读。
//
// 运行：node test/skeleton.test.mjs（不要用 node --test，本仓库测试自带 PASS/FAIL 输出）

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const load = (rel) => import(pathToFileURL(join(pkgRoot, 'lib', rel)).href)

const {
  scanSignatures,
  isDeclarationHit,
  SCANNED_EXTENSIONS,
  MAX_HITS_PER_FILE,
  EXCERPT_WINDOW_CHARS,
  SIGNATURE_MAX_CHARS,
} = await load('skeleton.js')

let pass = 0
let fail = 0
function check(label, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`  PASS  ${label}`)
  } else {
    fail++
    console.log(`  FAIL  ${label}${detail ? `  -> ${detail}` : ''}`)
  }
}

/** 把命中压成 `kind:name@line` 便于整段比较——顺序也在比较范围内（必须是源码顺序）。 */
const shape = (hits) => hits.filter(isDeclarationHit).map((h) => `${h.kind}:${h.name}@${h.startLine}`)
const names = (hits) => hits.filter(isDeclarationHit).map((h) => h.name)
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ---------------------------------------------------------------------------
console.log('\n=== 1. 事实记录：hits[0] 永远是文件级事实，不是声明 ===')
// ---------------------------------------------------------------------------

const FACT_SAMPLE = 'const x = 1\nexport class A {}\n'
const tsFact = scanSignatures('src/a.ts', FACT_SAMPLE)
check('hits[0] 是事实记录（name 为空串）', tsFact[0]?.name === '', `name=${JSON.stringify(tsFact[0]?.name)}`)
check('事实记录 startLine 为 0（不是合法行号，不会被当成声明位置）', tsFact[0]?.startLine === 0, `startLine=${tsFact[0]?.startLine}`)
check('isDeclarationHit 把事实记录判为非声明', isDeclarationHit(tsFact[0]) === false)
check('isDeclarationHit 把真实声明判为声明', tsFact[1] !== undefined && isDeclarationHit(tsFact[1]) === true)
check('事实记录排在声明之前（调用方无需自己挑）', shape(tsFact)[0] === 'class:A@2', shape(tsFact).join(', '))
check('excerptChars 等于摘录实际长度', tsFact[0]?.excerptChars === FACT_SAMPLE.length, `excerptChars=${tsFact[0]?.excerptChars} len=${FACT_SAMPLE.length}`)
check('短摘录不算被截断', tsFact[0]?.truncated === false)
check('受支持扩展名 supported:true', tsFact[0]?.supported === true)

// 永不返回空数组：空数组会把三个事实字段一起丢掉。
check('永不返回空数组（零命中时至少有一条事实记录）', scanSignatures('src/a.ts', '').length === 1)

// ---------------------------------------------------------------------------
console.log('\n=== 2. 多语言声明识别（TS/JS、Python、Go、Rust、Java、C#）===')
// ---------------------------------------------------------------------------

const TS_SAMPLE = `import { readFile } from 'node:fs/promises'

export interface Config {
  root: string
}

export type Level = 'low' | 'high'

export enum Mode {
  Fast,
}

export class Scanner {
  private hits: string[] = []

  constructor(private readonly root: string) {
    this.hits = []
  }

  async scan(target: string): Promise<number> {
    return this.hits.length
  }

  reset() {}
}

export async function scanAll(root: string): Promise<string[]> {
  return []
}

export const makeScanner = (root: string) => new Scanner(root)
`
check(
  'TS：类/接口/类型/枚举/函数/箭头函数/方法/构造器全部命中，行号与顺序正确',
  eq(shape(scanSignatures('src/scanner.ts', TS_SAMPLE)), [
    'interface:Config@3',
    'type:Level@7',
    'enum:Mode@9',
    'class:Scanner@13',
    'method:constructor@16',
    'method:scan@20',
    'method:reset@24',
    'function:scanAll@27',
    'function:makeScanner@31',
  ]),
  shape(scanSignatures('src/scanner.ts', TS_SAMPLE)).join(', '),
)
// 字段声明和 `return ...` 不是声明，不能被算进来。
check('TS：类字段与 return 语句未产生幻影命中', !names(scanSignatures('src/scanner.ts', TS_SAMPLE)).includes('hits'))
check('TS：`if (ready) {` 不被当成名为 if 的方法', !names(scanSignatures('src/a.ts', 'class A {\n  run() {\n    if (ready) {\n      go()\n    }\n  }\n}\n')).includes('if'))
// .js/.jsx/.mjs/.cjs 与 .ts 同族。
check('.js 走同一套模式', names(scanSignatures('a.js', 'export function boot() {}\n')).includes('boot'))
check('.mjs 走同一套模式', names(scanSignatures('a.mjs', 'export const boot = () => 1\n')).includes('boot'))
check('.tsx 走同一套模式', names(scanSignatures('a.tsx', 'export function Widget() {}\n')).includes('Widget'))

const PY_SAMPLE = `import os

class Parser:
    def __init__(self, root):
        self.root = root

    def parse(self, text):
        return []

def main():
    pass
`
check(
  'Python：class / def，缩进的 def 记为 method，顶层 def 记为 function',
  eq(shape(scanSignatures('pkg/parser.py', PY_SAMPLE)), [
    'class:Parser@3',
    'method:__init__@4',
    'method:parse@7',
    'function:main@10',
  ]),
  shape(scanSignatures('pkg/parser.py', PY_SAMPLE)).join(', '),
)

const GO_SAMPLE = `package main

import "fmt"

type Config struct {
	Name string
}

type Runner interface {
	Run() error
}

func (c *Config) Label() string {
	return c.Name
}

func Build(cfg Config) (*Runner, error) {
	return nil, nil
}
`
check(
  'Go：struct / interface / 带接收者的方法 / 顶层函数',
  eq(shape(scanSignatures('main.go', GO_SAMPLE)), [
    'struct:Config@5',
    'interface:Runner@9',
    'method:Label@13',
    'function:Build@17',
  ]),
  shape(scanSignatures('main.go', GO_SAMPLE)).join(', '),
)
// Go 的接口方法和结构体字段是缩进的，第 0 列锚定必须把它们排除掉。
check('Go：接口方法 Run 与字段 Name 未被误报', !names(scanSignatures('main.go', GO_SAMPLE)).some((n) => n === 'Run' || n === 'Name'))

const RS_SAMPLE = `use std::collections::HashMap;

pub struct Engine {
    cache: HashMap<String, u32>,
}

pub trait Runnable {
    fn run(&self) -> u32;
}

pub enum State {
    Idle,
}

impl Engine {
    pub fn new() -> Self {
        Engine { cache: HashMap::new() }
    }

    fn tick(&mut self) -> u32 {
        0
    }
}

impl Runnable for Engine {
    fn run(&self) -> u32 {
        0
    }
}
`
check(
  'Rust：struct / trait / enum / impl / fn（缩进的 fn 记为 method）',
  eq(shape(scanSignatures('src/engine.rs', RS_SAMPLE)), [
    'struct:Engine@3',
    'trait:Runnable@7',
    'method:run@8',
    'enum:State@11',
    'impl:Engine@15',
    'method:new@16',
    'method:tick@20',
    'impl:Engine@25',
    'method:run@26',
  ]),
  shape(scanSignatures('src/engine.rs', RS_SAMPLE)).join(', '),
)
// `pub fn new` 是 Rust 最常见的构造函数，绝不能被关键字过滤掉。
check('Rust：`pub fn new` 保留（new 不是被过滤的关键字）', names(scanSignatures('src/engine.rs', RS_SAMPLE)).includes('new'))
// `impl Runnable for Engine` 记的是被实现的类型，不是 trait 名。
check('Rust：`impl Trait for Type` 记录 Type', shape(scanSignatures('src/x.rs', 'impl Runnable for Engine {\n}\n'))[0] === 'impl:Engine@1')

const JAVA_SAMPLE = `package com.example;

public class Service {
    private final Repo repo;

    public Service(Repo repo) {
        this.repo = repo;
    }

    public int count() {
        return 0;
    }

    static void reset() {
    }
}
`
check(
  'Java：class / 构造器 / 方法；字段与 return 不误报',
  eq(shape(scanSignatures('src/Service.java', JAVA_SAMPLE)), [
    'class:Service@3',
    'method:Service@6',
    'method:count@10',
    'method:reset@14',
  ]),
  shape(scanSignatures('src/Service.java', JAVA_SAMPLE)).join(', '),
)

const CS_SAMPLE = `namespace Example;

public interface IStore
{
    int Count();
}

public enum Level
{
    Low,
}

public record Point(int X, int Y);

public sealed class Store : IStore
{
    public int Count()
    {
        return 0;
    }
}
`
check(
  'C#：interface / enum / record / class / 方法',
  eq(shape(scanSignatures('src/Store.cs', CS_SAMPLE)), [
    'interface:IStore@3',
    'enum:Level@8',
    'class:Point@13',
    'class:Store@15',
    'method:Count@17',
  ]),
  shape(scanSignatures('src/Store.cs', CS_SAMPLE)).join(', '),
)

// 行号必须是文件真实行号，不能是"第几条命中"。
check('行号是文件行号（第 3 行的声明报 3，不是 1）', scanSignatures('a.ts', 'const a = 1\nconst b = 2\nexport class C {}\n')[1]?.startLine === 3)

// ---------------------------------------------------------------------------
console.log('\n=== 3. 覆盖外扩展名必须报 supported:false（不是空数组）===')
// ---------------------------------------------------------------------------

// 这些摘录里带着货真价实的 Ruby 声明形状：如果扫描器"顺手"用 TS 模式去扫，就会
// 产出命中。supported:false 的要点正是它**不去猜**。
const UNSUPPORTED_SAMPLE = 'class Foo\n  def bar\n  end\nend\n'
for (const [path, label] of [
  ['src/app.rb', 'Ruby'],
  ['src/legacy.php', 'PHP'],
  ['README', '无扩展名'],
  ['docs/notes.txt', '纯文本'],
  ['src/main.kt', 'Kotlin'],
]) {
  const hits = scanSignatures(path, UNSUPPORTED_SAMPLE)
  check(`${label}（${path}）报 supported:false`, hits[0]?.supported === false, `supported=${hits[0]?.supported}`)
  check(`${label}（${path}）不返回空数组（事实记录仍在）`, hits.length === 1, `len=${hits.length}`)
  check(`${label}（${path}）不产出任何声明命中`, hits.filter(isDeclarationHit).length === 0)
  check(`${label}（${path}）仍带 excerptChars/truncated 事实`, hits[0]?.excerptChars === UNSUPPORTED_SAMPLE.length && hits[0]?.truncated === false, `excerptChars=${hits[0]?.excerptChars}`)
}

// 关键区分：'没扫到' 与 '没扫' 必须是两种可分辨的结果。
const scannedNothing = scanSignatures('src/empty.ts', '')
const notScanned = scanSignatures('src/empty.rb', '')
check(
  '可分辨：受支持的零命中(supported:true) vs 覆盖外(supported:false)',
  scannedNothing[0]?.supported === true && notScanned[0]?.supported === false,
  `ts=${scannedNothing[0]?.supported} rb=${notScanned[0]?.supported}`,
)

// 语言覆盖表本身：必须是 SOURCE_EXT_RE 的真子集（更窄），不能凭空多出扩展名。
const selectSrc = readFileSync(join(pkgRoot, 'src', 'select.ts'), 'utf8')
const gateMatch = selectSrc.match(/SOURCE_EXT_RE\s*=\s*\/([^/]+)\/([gimsuy]*)/)
const gateExts = gateMatch ? (gateMatch[1].match(/\(([^)]*)\)/)?.[1] ?? '').split('|') : []
check('能从 src/select.ts 解析出 SOURCE_EXT_RE 的扩展名表', gateExts.length > 20, `exts=${gateExts.length}`)
check(
  'SCANNED_EXTENSIONS ⊆ SOURCE_EXT_RE（扫描器不声明闸门之外的扩展名）',
  gateExts.length > 0 && SCANNED_EXTENSIONS.every((e) => gateExts.includes(e)),
  `scanned=[${SCANNED_EXTENSIONS.join(',')}] 不在闸门内=[${SCANNED_EXTENSIONS.filter((e) => !gateExts.includes(e)).join(',')}]`,
)
check(
  '覆盖表严格窄于闸门（.rb/.php 在闸门内但不在覆盖内）',
  gateExts.includes('rb') && gateExts.includes('php') && !SCANNED_EXTENSIONS.includes('rb') && !SCANNED_EXTENSIONS.includes('php'),
)
check('覆盖表包含六种语言族的代表扩展名', ['ts', 'js', 'py', 'go', 'rs', 'java', 'cs'].every((e) => SCANNED_EXTENSIONS.includes(e)), SCANNED_EXTENSIONS.join(','))

// ---------------------------------------------------------------------------
console.log('\n=== 4. 空摘录与畸形摘录：不抛异常、不产生幻影命中 ===')
// ---------------------------------------------------------------------------

let threw = null
let emptyHits = null
try {
  emptyHits = scanSignatures('src/a.ts', '')
} catch (err) {
  threw = err
}
check('空摘录不抛异常', threw === null, String(threw))
check('空摘录零声明命中', emptyHits !== null && emptyHits.filter(isDeclarationHit).length === 0)
check('空摘录 excerptChars 为 0 且 supported 仍为 true', emptyHits?.[0]?.excerptChars === 0 && emptyHits?.[0]?.supported === true)

const GARBAGE = '\u0000\u0001 <<<>>> !!! ??? \n)(}{][ \n  ) ( } { ] [\n\u00ff\u00fe\n'
let garbageHits = null
let garbageThrew = null
try {
  garbageHits = scanSignatures('src/garbage.ts', GARBAGE)
} catch (err) {
  garbageThrew = err
}
check('畸形摘录不抛异常', garbageThrew === null, String(garbageThrew))
check('畸形摘录零幻影命中', garbageHits !== null && garbageHits.filter(isDeclarationHit).length === 0, shape(garbageHits ?? []).join(', '))
check('畸形摘录仍返回事实记录', garbageHits?.[0]?.name === '' && garbageHits?.[0]?.supported === true)

// 畸形但"看起来像声明"的片段：残缺的 class/def/func 不能被当成声明。
const BROKEN = 'export class\nexport function\nfunc \ndef \nclass \nimpl\n'
const brokenHits = scanSignatures('src/broken.ts', BROKEN)
check('残缺关键字（缺名字）不产生命中', brokenHits.filter(isDeclarationHit).length === 0, shape(brokenHits).join(', '))
check('残缺 Python 关键字同样不命中', scanSignatures('a.py', 'def \nclass \n').filter(isDeclarationHit).length === 0)
check('残缺 Go/Rust 关键字同样不命中', scanSignatures('a.go', 'func \ntype \n').filter(isDeclarationHit).length === 0 && scanSignatures('a.rs', 'fn \nimpl\n').filter(isDeclarationHit).length === 0)

// CRLF：Windows 检出常见，`\r` 不能污染 signature，也不能吃掉命中。
const crlf = scanSignatures('src/win.ts', 'export class Win {\r\n  run() {\r\n  }\r\n}\r\n')
check('CRLF 摘录仍命中 class 与方法', eq(shape(crlf), ['class:Win@1', 'method:run@2']), shape(crlf).join(', '))
check('CRLF 摘录的 signature 不含 \\r', crlf.every((h) => !h.signature.includes('\r')))

// 边界：非字符串输入不该被静默吞掉——这里只要求不崩，调用方负责类型。
let nullThrew = false
try {
  scanSignatures('src/a.ts', undefined)
} catch {
  nullThrew = true
}
check('undefined 摘录抛出（而非静默产出幻影命中）', nullThrew === true)

// ---------------------------------------------------------------------------
console.log('\n=== 5. 只有版权头和 import 的文件头：零命中但事实齐全 ===')
// ---------------------------------------------------------------------------

const HEADER_ONLY = `// Copyright (c) 2026 Example Corp. All rights reserved.
// Licensed under the Apache License, Version 2.0.
// See LICENSE in the repository root for the full text.

import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Stats } from 'node:fs'

const LICENSE = 'Apache-2.0'
const ROOT = resolve('.')
`
const headerHits = scanSignatures('src/header-only.ts', HEADER_ONLY)
check('版权头 + import：零声明命中', headerHits.filter(isDeclarationHit).length === 0, shape(headerHits).join(', '))
check('版权头 + import：仍有事实记录可读', headerHits.length === 1 && headerHits[0]?.name === '')
check('版权头 + import：supported 为 true（扫过了，只是这段没有声明）', headerHits[0]?.supported === true)
check('版权头 + import：excerptChars 反映真实窗口', headerHits[0]?.excerptChars === HEADER_ONLY.length, `${headerHits[0]?.excerptChars} vs ${HEADER_ONLY.length}`)
check('版权头 + import：truncated 为 false（窗口没被填满）', headerHits[0]?.truncated === false)

// 被窗口填满 → 推断为截断。这是纯函数能给出的唯一截断信号（见 scanSignatures 注释）。
const FILLED = `${'// filler line to fill the window\n'.repeat(40)}`
const filledHits = scanSignatures('src/filled.ts', FILLED)
check('摘录填满窗口（≥1200 字符）时报 truncated:true', FILLED.length >= EXCERPT_WINDOW_CHARS && filledHits[0]?.truncated === true, `len=${FILLED.length} truncated=${filledHits[0]?.truncated}`)
check('恰好 EXCERPT_WINDOW_CHARS 字符即视为填满', scanSignatures('a.ts', 'x'.repeat(EXCERPT_WINDOW_CHARS))[0]?.truncated === true)
check('少一字符即不算填满', scanSignatures('a.ts', 'x'.repeat(EXCERPT_WINDOW_CHARS - 1))[0]?.truncated === false)

// 关键：类体在窗口之外时，零命中不能被读成"没有类"——事实字段就是给渲染器说这句话的。
// 这里**照着真实调用方建模**：src/index.ts:463 先 slice(0, 1200) 才把摘录交进来，
// 所以测试也必须先切片，否则扫的就是整份文件，"窗口之外"这个前提根本不成立。
const FULL_FILE = `${'// padding line to push declarations past the window\n'.repeat(40)}export class BeyondWindow {\n}\n`
check('模型正确：声明确实落在 1200 字符窗口之外（否则下面两例是空转）', FULL_FILE.length > EXCERPT_WINDOW_CHARS && FULL_FILE.slice(EXCERPT_WINDOW_CHARS).includes('BeyondWindow'), `len=${FULL_FILE.length}`)
const beyondHits = scanSignatures('src/beyond.ts', FULL_FILE.slice(0, EXCERPT_WINDOW_CHARS))
check('声明落在窗口之外时：零命中 + truncated:true + supported:true（三者同时成立）', beyondHits.filter(isDeclarationHit).length === 0 && beyondHits[0]?.truncated === true && beyondHits[0]?.supported === true, `decls=${beyondHits.filter(isDeclarationHit).length} truncated=${beyondHits[0]?.truncated} supported=${beyondHits[0]?.supported}`)
check('窗口之外的情形可被渲染器识别为"可能还有"而非"没有"', beyondHits[0]?.excerptChars === EXCERPT_WINDOW_CHARS && beyondHits[0]?.supported === true)

// ---------------------------------------------------------------------------
console.log('\n=== 6. 单文件命中上限 ===')
// ---------------------------------------------------------------------------

const MANY = Array.from({ length: 80 }, (_, i) => `export function f${i}() {}`).join('\n')
const manyHits = scanSignatures('src/many.ts', MANY)
check('返回条目数被 MAX_HITS_PER_FILE 截断', manyHits.length === MAX_HITS_PER_FILE, `len=${manyHits.length} cap=${MAX_HITS_PER_FILE}`)
check('上限含事实记录，声明数为其减一', manyHits.filter(isDeclarationHit).length === MAX_HITS_PER_FILE - 1, `decls=${manyHits.filter(isDeclarationHit).length}`)
check('截断保留的是最前面的声明（源码顺序）', names(manyHits)[0] === 'f0' && names(manyHits)[MAX_HITS_PER_FILE - 2] === `f${MAX_HITS_PER_FILE - 2}`, names(manyHits).join(','))
check('未达上限时不被截断', scanSignatures('src/few.ts', 'export function a() {}\nexport function b() {}\n').length === 3)

// 上限是给渲染器的信号：hits.length === MAX_HITS_PER_FILE 意味着"可能还有更多"。
check('MAX_HITS_PER_FILE 是一个导出的正整数常量', Number.isInteger(MAX_HITS_PER_FILE) && MAX_HITS_PER_FILE > 0, String(MAX_HITS_PER_FILE))

// 超长单行：signature 必须被 SIGNATURE_MAX_CHARS 截断，否则渲染器会引用上千字符。
const LONG_LINE = `export function ${'veryLongName'.repeat(30)}(a, b) {}`
const longHit = scanSignatures('a.ts', LONG_LINE).filter(isDeclarationHit)[0]
check('超长声明行被截到 SIGNATURE_MAX_CHARS', longHit !== undefined && longHit.signature.length === SIGNATURE_MAX_CHARS, `len=${longHit?.signature.length} cap=${SIGNATURE_MAX_CHARS}`)

// ---------------------------------------------------------------------------
console.log('\n=== 7. 确定性：同一输入必得同一输出 ===')
// ---------------------------------------------------------------------------

const DET_INPUT = [['src/scanner.ts', TS_SAMPLE], ['main.go', GO_SAMPLE], ['src/engine.rs', RS_SAMPLE], ['src/app.rb', 'x\n'], ['src/empty.ts', '']]
for (const [path, text] of DET_INPUT) {
  const a = scanSignatures(path, text)
  const b = scanSignatures(path, text)
  check(`${path}：两次调用结果完全一致`, JSON.stringify(a) === JSON.stringify(b))
}
// 纯函数：不共享可变状态，交错调用也不串味。
const first = scanSignatures('src/scanner.ts', TS_SAMPLE)
scanSignatures('main.go', GO_SAMPLE)
const second = scanSignatures('src/scanner.ts', TS_SAMPLE)
check('交错调用其他文件不影响结果（无跨调用状态）', JSON.stringify(first) === JSON.stringify(second))
check('结果按源码顺序排列（startLine 单调不减）', shape(scanSignatures('src/engine.rs', RS_SAMPLE)).map((s) => Number(s.split('@')[1])).every((v, i, arr) => i === 0 || arr[i - 1] <= v))
check('path 原样回传（不做归一化，调用方拿到的就是它给的）', scanSignatures('./src/./a.ts', 'class A {}\n').every((h) => h.path === './src/./a.ts'))

// ---------------------------------------------------------------------------
console.log('\n=== 8. 覆盖表逐扩展名核对：六族齐全，.mts/.cts 是刻意排除 ===')
// ---------------------------------------------------------------------------

// 覆盖表里写了扩展名却没有对应模式，等价于谎报覆盖——所以每一项都要能被真实触发。
const TS_FAMILY_SAMPLE = 'export class Foo {\n  bar() {\n  }\n}\n'
for (const ext of ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs']) {
  const h = scanSignatures(`src/example.${ext}`, TS_FAMILY_SAMPLE)
  check(
    `.${ext} 在覆盖内且命中 class + method`,
    h[0]?.supported === true && eq(shape(h), ['class:Foo@1', 'method:bar@2']),
    `supported=${h[0]?.supported} shape=${shape(h).join(', ')}`,
  )
}
for (const ext of ['py', 'go', 'rs', 'java', 'cs']) {
  check(`.${ext} 在覆盖表内`, SCANNED_EXTENSIONS.includes(ext), SCANNED_EXTENSIONS.join(','))
}

// .mts/.cts 是设计上的刻意排除，不是漏配：扫描器有 TS 模式，但 SOURCE_EXT_RE 闸门
// 从不放行这两种扩展名，声明覆盖就会产生"永远无法被触发"的死覆盖。
for (const ext of ['mts', 'cts']) {
  const h = scanSignatures(`src/example.${ext}`, TS_FAMILY_SAMPLE)
  check(`.${ext} 不声明覆盖（supported:false）`, h[0]?.supported === false, `supported=${h[0]?.supported}`)
  check(`.${ext} 不在覆盖表内`, !SCANNED_EXTENSIONS.includes(ext))
  check(`.${ext} 也不在 SOURCE_EXT_RE 闸门内（排除是自洽的，不是单边漏配）`, !gateExts.includes(ext), gateExts.join(','))
  check(`.${ext} 摘录里的 TS 声明形状不被"顺手"匹配`, h.filter(isDeclarationHit).length === 0, shape(h).join(', '))
}

// ---------------------------------------------------------------------------
console.log('\n=== 9. 覆盖外路径的事实记录必须逐字段为空 ===')
// ---------------------------------------------------------------------------

// 只断言 supported:false 会漏掉最危险的一种回归：扫描器"顺手"用 TS 模式去扫一种它
// 并不理解的语言，于是既报 supported:false 又吐出一堆命中——两个信号互相矛盾。
const NOT_OURS_SAMPLE = 'export class Foo {\n  bar() {\n  }\n}\n'
// 非空转门：同一段文本在 .ts 下必须命中，否则下面的"零命中"断言可能只是样本没货。
const NOT_OURS_CONTROL = scanSignatures('src/same-text.ts', NOT_OURS_SAMPLE)
check(
  '模型正确：同一段摘录在 .ts 下确实命中（否则下面的零命中断言是空转）',
  NOT_OURS_CONTROL.filter(isDeclarationHit).length === 2,
  shape(NOT_OURS_CONTROL).join(', '),
)
for (const [path, why] of [
  ['src/engine.cpp', 'SOURCE_EXT_RE 认它是源码，扫描器不覆盖'],
  ['scripts/build.lua', '同上'],
  ['db/schema.sql', '同上'],
  ['README.md', '非源码路径'],
]) {
  const h = scanSignatures(path, NOT_OURS_SAMPLE)
  check(`${path}：恰好一条事实记录（不是空数组）`, h.length === 1, `len=${h.length}`)
  check(
    `${path}：name / signature / startLine 逐字段为空`,
    h[0]?.name === '' && h[0]?.signature === '' && h[0]?.startLine === 0,
    `name=${JSON.stringify(h[0]?.name)} sig=${JSON.stringify(h[0]?.signature)} line=${h[0]?.startLine}`,
  )
  check(
    `${path}：supported:false 且零声明命中（${why}）`,
    h[0]?.supported === false && h.filter(isDeclarationHit).length === 0,
    `supported=${h[0]?.supported} decls=${h.filter(isDeclarationHit).length}`,
  )
  check(`${path}：仍带 excerptChars 事实`, h[0]?.excerptChars === NOT_OURS_SAMPLE.length, `excerptChars=${h[0]?.excerptChars}`)
}

// ---------------------------------------------------------------------------
console.log('\n=== 10. excerptChars 在每一条命中上都等于摘录长度 ===')
// ---------------------------------------------------------------------------

// excerptChars 是调用方判断"到底扫了多少"的唯一依据，所以它必须在每一条命中上都成立，
// 而不只是事实记录那一条。
const EC_SAMPLE = '// comment\nexport class Foo {\n  bar() {\n  }\n}\n'
const ecHits = scanSignatures('src/ec.ts', EC_SAMPLE)
check(
  '短摘录：每一条命中（含事实记录与声明）都报真实长度',
  ecHits.length > 1 && ecHits.every((h) => h.excerptChars === EC_SAMPLE.length),
  `len=${EC_SAMPLE.length} got=${ecHits.map((h) => h.excerptChars).join(',')}`,
)

const EC_LONG = 'export class A {\n' + '// pad\n'.repeat(300)
const ecLongHits = scanSignatures('src/long.ts', EC_LONG)
check('长摘录：每一条命中的 excerptChars 仍是真实长度', ecLongHits.every((h) => h.excerptChars === EC_LONG.length), `len=${EC_LONG.length}`)
check('长摘录：每一条命中都带 truncated:true（截断是整次扫描的属性，不是某一行的）', ecLongHits.every((h) => h.truncated === true))

// 窗口边界用字面量再钉一遍：这两个数字是 src/index.ts 的 slice(0, 1200) 契约。
check('字面量边界：1199 字符不算填满', scanSignatures('a.ts', 'x'.repeat(1199))[0]?.truncated === false)
check('字面量边界：1200 字符算填满（边界是闭区间）', scanSignatures('a.ts', 'x'.repeat(1200))[0]?.truncated === true)

// ---------------------------------------------------------------------------
console.log('\n=== 11. signature 去首尾空白 ===')
// ---------------------------------------------------------------------------

const PADDED_LINE = '  export class Padded {   '
const paddedHit = scanSignatures('a.ts', `${PADDED_LINE}\n`).filter(isDeclarationHit)[0]
check('模型正确：样本行本身带着首尾空白（否则 trim 断言是空转）', PADDED_LINE !== PADDED_LINE.trim())
check('signature 被 trim 到声明的真实文本', paddedHit?.signature === 'export class Padded {', JSON.stringify(paddedHit?.signature))
check('trim 后的 signature 不含首尾空白', paddedHit !== undefined && paddedHit.signature === paddedHit.signature.trim())

// ---------------------------------------------------------------------------
console.log('\n=== 12. 单行至多产生一条命中 ===')
// ---------------------------------------------------------------------------

// Java 构造器行是"一行匹配两个模式"最可能发生的地方（构造器与方法的形状重叠），
// 表内顺序决定结果——这里钉死结果，不钉顺序。
const ctorHits = scanSignatures('A.java', '  public UserService(Repo repo) {\n').filter(isDeclarationHit)
check('Java 构造器行只产生一条命中', ctorHits.length === 1, `n=${ctorHits.length} names=${ctorHits.map((h) => h.name).join(',')}`)
check('Java 构造器行的命中就是构造器本身', ctorHits[0]?.name === 'UserService', String(ctorHits[0]?.name))

// 结构化断言：若任何两行共享命中，"行号严格递增"就不可能成立。
const DENSE_DECLS = Array.from({ length: 30 }, (_, i) => `export class C${i} {`).join('\n')
const denseHits = scanSignatures('src/dense.ts', DENSE_DECLS).filter(isDeclarationHit)
const denseLines = denseHits.map((h) => h.startLine)
check(
  '30 行密集声明 → 30 条命中落在 30 个互不相同的行号上',
  denseLines.length === 30 && new Set(denseLines).size === 30,
  `n=${denseLines.length} distinct=${new Set(denseLines).size}`,
)

// ---------------------------------------------------------------------------
console.log('\n=== 13. 误报防护：裸调用、方法调用与注释 ===')
// ---------------------------------------------------------------------------

// 函数调用被报成"方法"，读起来就是对仓库文档质量的断言——而且是假的。
const CALLS_SAMPLE = 'export function outer() {\n  doThing(x)\n  doThing(x);\n  obj.method(y)\n}\n'
const callsHits = scanSignatures('a.ts', CALLS_SAMPLE)
check('同一份样本里的真实声明仍被找到（防护不是空转）', names(callsHits).join(',') === 'outer', names(callsHits).join(','))
check('裸调用 doThing(x) 不被报成方法', !names(callsHits).includes('doThing'))
check('调用语句 doThing(x); 不被报成方法', !names(callsHits).includes('doThing'))
check('成员调用 obj.method(y) 不被报成方法', !names(callsHits).includes('method'))

// 注释里提到声明是文件头最常见的形态，而文件头正是被扫的那 1200 字符。
const COMMENT_SAMPLE = '// class Foo is created by the factory\n// export function helper() does the work\n/* class Bar is deprecated */\n'
const commentHits = scanSignatures('a.ts', COMMENT_SAMPLE)
check('注释行提到的 class/function 都不算声明', commentHits.filter(isDeclarationHit).length === 0, shape(commentHits).join(', '))
check('纯注释摘录仍返回事实记录（扫过了，只是没有声明）', commentHits.length === 1 && commentHits[0]?.name === '')
check('纯注释摘录的 supported 仍为 true', commentHits[0]?.supported === true)

// ---------------------------------------------------------------------------
console.log('\n=== 14. Rust：顶层 fn 是 function，impl 内缩进 fn 是 method ===')
// ---------------------------------------------------------------------------

const RS_TOP_SAMPLE = 'fn top_level() {}\npub fn public_top() {}\nimpl Foo {\n    fn m(&self) {}\n}\n'
const rsTopHits = scanSignatures('a.rs', RS_TOP_SAMPLE)
check(
  'Rust 顶层 fn / 带 pub 的顶层 fn / impl / 缩进 fn 四者分类正确',
  eq(shape(rsTopHits), ['function:top_level@1', 'function:public_top@2', 'impl:Foo@3', 'method:m@4']),
  shape(rsTopHits).join(', '),
)
check(
  'Rust 顶层 fn 记为 function 而非 method（缩进才是 method 的判据）',
  rsTopHits.filter((h) => h.startLine <= 2).every((h) => h.kind === 'function'),
  rsTopHits.filter((h) => h.startLine <= 2).map((h) => `${h.kind}:${h.name}`).join(', '),
)

console.log(`\n${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
