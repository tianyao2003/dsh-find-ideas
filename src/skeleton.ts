/**
 * 文件头局部声明证据扫描器（design.md §2.4, R5 / AC5）。
 *
 * 输入是调用方**已经取到**的那一小段文件头文本（src/index.ts:463 `file.text.slice(0, 1200)`），
 * 不是整个文件。本模块不读盘、不联网、不发起任何请求，INSPECT_BUDGET 不变。
 *
 * ## 返回形状（调用方必须知道的唯一约定）
 *
 * `scanSignatures` **永不返回空数组**，且 `hits[0]` **永远是文件级事实记录**
 * （`name === ''`、`startLine === 0`），后面才是按源码顺序排列的声明命中。
 *
 * 这条约定是硬需求逼出来的：契约里 `SignatureHit` 固定 9 个字段、没有文件级汇总字段，
 * 所以"零命中的文件头"若返回 `[]`，`supported` / `truncated` / `excerptChars` 就全丢了——
 * 而那三个字段正是本模块存在的理由。统一放一条事实记录后，渲染器可以无条件地
 * `hits[0]` 取事实、`hits.slice(1)` 取声明，只有一条代码路径。
 * 判定声明用导出的 `isDeclarationHit`，不要用 `hits.length` 数声明。
 *
 * ## 三条不可退让的诚实约束（design.md §2.4）
 *
 * 1. 这是**文件头局部声明证据**，不是"架构骨架"。窗口只覆盖文件头，版权头和 import
 *    很容易把它填满，而类体/函数体通常在窗口之外。调用方渲染时不得把它说成完整架构。
 * 2. **零命中不等于该仓库没有类/函数**。零命中只说明"这段文件头里没扫到声明"。
 *    `supported === false` 时更是完全未测——那种扩展名根本不在语言覆盖内。
 * 3. `supported` / `truncated` / `excerptChars` 三个字段存在的唯一理由，是让调用方
 *    能把上面两句话说出口。丢弃它们等于把启发式扫描的代价藏起来。
 *
 * 为什么是启发式而不是真解析器（design.md §4.2，用户裁定 m00612 A）：TypeScript
 * 编译器 API 约 22.5 MB 且只覆盖两种语言，tree-sitter 是原生模块 + 构建链（Windows
 * 上有风险）。代价是可能漏掉声明、处理不了宏/装饰器/条件编译；买到的是零依赖、
 * 零构建链、六种语言覆盖。诚实的标注就是这笔交易的补偿——读者知道这是启发式，
 * 就不会把"没列出来"读成"不存在"。
 */

/**
 * 摘录窗口长度。与 src/index.ts:463 的 `slice(0, 1200)` 是同一个数：本模块不重复
 * 那个切片，只是用这个常量判断"窗口是否被填满"，从而给出 `truncated`。
 * 两边不一致会让 `truncated` 静默失真，改动时必须同步。
 */
export const EXCERPT_WINDOW_CHARS = 1200

/**
 * 单文件返回条目上限（含 `hits[0]` 的事实记录，因此最多 39 条声明）。1200 字符的窗口里
 * 通常放不下 20 条声明，40 留了余量；同时它挡住最坏情况——压缩过/生成的一行式文件能在
 * 1200 字符里匹配出上百条，让一个文件吃光整个输出预算。
 *
 * 上限触发时多余命中被**丢弃**，而 `SignatureHit` 没有"被截断"字段（契约固定 9 个字段，
 * design.md §2.4），所以调用方这样判断：`hits.length === MAX_HITS_PER_FILE` 意味着
 * "可能还有更多，别当成完整清单"。这个信号偏向多报：恰好 39 条声明的文件也会被标成
 * 可能不完整。方向是故意的——声称不完整只是保守，声称完整却是撒谎。
 */
export const MAX_HITS_PER_FILE = 40

/** 单条 signature 的字符上限。渲染器会逐字引用它，而一行式文件的一行可能长 1200 字符。 */
export const SIGNATURE_MAX_CHARS = 200

export type SignatureKind =
  | 'class'
  | 'function'
  | 'method'
  | 'interface'
  | 'type'
  | 'struct'
  | 'trait'
  | 'impl'
  | 'enum'

export interface SignatureHit {
  /** 仓库内相对路径，原样回传调用方给的值。 */
  path: string
  /**
   * 声明种类。文件级事实记录（`name === ''`）里这个字段无意义，恒为 `'function'`——
   * 契约的 kind 枚举没有"文件"这一项，而字段必须有个值。
   */
  kind: SignatureKind
  /** 声明名；空串表示这是文件级事实记录，不是声明。 */
  name: string
  /** 声明所在行去掉首尾空白后的原文（截到 SIGNATURE_MAX_CHARS）；事实记录为空串。 */
  signature: string
  /**
   * 声明在**源文件**中的 1-based 行号。摘录是文件头窗口且从第 1 行开始，所以窗口内
   * 行号就是文件行号，可以直接写成 `#L{startLine}`。事实记录恒为 0（不是合法行号，
   * 因此不会被误当成声明位置）。
   */
  startLine: number
  /** 本次实际扫描的字符数，即 `excerpt.length`。 */
  excerptChars: number
  /** 摘录是否被窗口截断（推断值，见 scanSignatures 注释）。 */
  truncated: boolean
  /** 该扩展名是否在本扫描器的语言覆盖内。false 时零命中不携带任何信息。 */
  supported: boolean
}

/** 该条目是不是一条声明（而不是文件级事实记录）。渲染器按此过滤，不要用 hits.length。 */
export function isDeclarationHit(hit: SignatureHit): boolean {
  return hit.name !== ''
}

type Family = 'ts' | 'py' | 'go' | 'rs' | 'java'

/**
 * 扩展名 → 语言族。**这是语言覆盖的唯一真源**：SCANNED_EXTENSIONS 由它派生，
 * 加语言只改这里，不会出现"表说支持、模式不存在"的错位。
 */
const FAMILY_BY_EXT: Readonly<Record<string, Family>> = {
  ts: 'ts',
  tsx: 'ts',
  js: 'ts',
  jsx: 'ts',
  mjs: 'ts',
  cjs: 'ts',
  py: 'py',
  go: 'go',
  rs: 'rs',
  java: 'java',
  cs: 'java',
}

/**
 * 扫描器实际有声明模式的扩展名，由 FAMILY_BY_EXT 派生（不手工维护，避免"表说支持、
 * 模式不存在"的错位）。
 *
 * 这是**扫描器的语言覆盖**，不是"什么算源码"，两者故意不同：src/select.ts:138 的
 * `SOURCE_EXT_RE` 是源码文件闸门，覆盖 35 个扩展名，其中 .rb/.php/.kt/.swift/.c/.cpp/
 * .ex/.erl/.hs/.ml/.scala/.clj/.vue/.svelte/.dart/.lua/.sh/.ps1/.sql 本模块**没有任何
 * 声明模式**。把它们报成 `supported: true` 会造出最坏的那种谎——"扫过了，没找到"。
 * 所以本表是 SOURCE_EXT_RE 的子集（test/skeleton.test.mjs 直接读 src/select.ts 钉住
 * 这个关系），反过来不成立。
 *
 * `SOURCE_EXT_RE` 在 select.ts:138 没有 `export`，本模块无法 import 它，select.ts 也不在
 * 本模块的写入范围内；因此这里维护一份更窄的表，用测试锁住子集关系，而不是去改它。
 * 表里不含 .mts/.cts：扫描器对它们本有 TS 模式，但源码闸门不认这两种扩展名，声明
 * "支持"一个永远送不进来的扩展名没有意义，还会让上面的子集关系失真。
 */
export const SCANNED_EXTENSIONS: readonly string[] = Object.keys(FAMILY_BY_EXT).sort()

/**
 * 扫描器契约版本。**任何会改变命中集合的改动都必须 +1**：加/删语言、改模式、
 * 改 `MAX_HITS_PER_FILE`、改 `SIGNATURE_MAX_CHARS`、改 `truncated` 的推断规则。
 *
 * 为什么要有这个数：`src/index.ts` 把它写进 inspect 的缓存 key。缓存回答的是
 * "用当时的规则扫出来的结果"，而不是"这个仓库里有什么"。改了模式却沿用旧 key，
 * 旧扫描器的沉默就会被当成本次扫描器的结论回放给调用方——那是把一次未执行的扫描
 * 报成"扫过了，没有声明"。加这个数就是让旧条目自己失效。
 *
 * 与 `src/select.ts` 的 `SELECTOR_VERSION`、`src/types.ts` 的 `SEARCH_PLAN_VERSION`
 * 是同一类东西：**契约变了，缓存必须失效，而不是靠人记得去清缓存**。
 */
export const SCANNER_VERSION = 1

type Pattern = {
  re: RegExp
  kind: SignatureKind
  /** 捕获组下标，指向声明名。 */
  nameGroup: number
  /** 缩进即方法（Python 的 def / Rust 的 fn：顶层是函数，缩进在 impl/trait 里是方法）。 */
  methodWhenIndented?: boolean
  /**
   * 需要额外证据才认，用来压掉"函数调用长得像方法声明"这一类误报。
   * 返回 false 则该行不算命中。
   */
  verify?: (m: RegExpExecArray) => boolean
}

const TS_JS_PATTERNS: readonly Pattern[] = [
  {
    re: /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
    kind: 'class',
    nameGroup: 1,
  },
  {
    re: /^\s*(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/,
    kind: 'interface',
    nameGroup: 1,
  },
  {
    re: /^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/,
    kind: 'enum',
    nameGroup: 1,
  },
  {
    // `[=<]` 是必需的：没有它 `type X = ...` 和 `type X<T> = ...` 都会漏，而
    // `type Foo` 这种残缺行会被误认。`export type { X } from ...` 是再导出不是声明，
    // 因为 `{` 不匹配 `[A-Za-z_$]`，天然被挡掉。
    re: /^\s*(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/,
    kind: 'type',
    nameGroup: 1,
  },
  {
    re: /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
    kind: 'function',
    nameGroup: 1,
  },
  {
    // `const f = (...) => ...` / `const f = async (x) => ...` / `const f = x => ...`。
    // 只认箭头函数：`const x = 1` 这类赋值不是声明，不能算。
    re: /^\s*(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
    kind: 'function',
    nameGroup: 1,
  },
  {
    // 方法：缩进 + `名字(...)`，且必须以花括号结尾或带访问/行为修饰符。两个条件缺一不可，
    // 否则 `  doThing(x)` 这种函数调用会被认成方法声明。`constructor` 也走这条
    // （`  constructor(x: number) {` 命中，name 就是 'constructor'）。
    // 结尾允许 `{}`：一行式方法体 `  m() {}` 很常见，只认 `{` 会把它整类漏掉。
    // 无修饰符时必须以花括号结尾（`;` 只对 abstract/interface 成员合法），所以
    // `  foo(bar);` 这种语句不会因为分号被误收。
    re: /^\s{2,}((?:(?:public|private|protected|static|readonly|abstract|async|override|declare|get|set)\s+)*)([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*(?::\s*[^{;]+)?(\{\}|[;{])\s*$/,
    kind: 'method',
    nameGroup: 2,
    verify: (m) => Boolean(m[1]) || m[4] !== ';',
  },
]

const PY_PATTERNS: readonly Pattern[] = [
  { re: /^\s*class\s+(\w+)/, kind: 'class', nameGroup: 1 },
  // 缩进的 def 记为 method：Python 的嵌套函数因此会被算成方法，这是启发式的已知代价，
  // 比漏掉所有真实方法划算。
  { re: /^(\s*)(?:async\s+)?def\s+(\w+)/, kind: 'function', nameGroup: 2, methodWhenIndented: true },
]

// Go 的声明只在顶层（方法靠接收者而不是缩进），所以这里全部锚在第 0 列，
// 结构体字段和接口方法因此天然不会误报。
const GO_PATTERNS: readonly Pattern[] = [
  // 带接收者的 func 是方法，接收者形状 `(r *T)` 是 Go 独有的，几乎不会误报。
  { re: /^func\s+\([^)]*\)\s*(\w+)/, kind: 'method', nameGroup: 1 },
  { re: /^func\s+(\w+)/, kind: 'function', nameGroup: 1 },
  { re: /^type\s+(\w+)\s+struct\b/, kind: 'struct', nameGroup: 1 },
  { re: /^type\s+(\w+)\s+interface\b/, kind: 'interface', nameGroup: 1 },
]

const RS_PATTERNS: readonly Pattern[] = [
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+(\w+)/, kind: 'struct', nameGroup: 1 },
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?trait\s+(\w+)/, kind: 'trait', nameGroup: 1 },
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+(\w+)/, kind: 'enum', nameGroup: 1 },
  // `impl Trait for Type` 记的是被实现的类型；`impl Type` 记 Type。泛型参数要跳过，
  // 否则 `impl<T> Foo<T>` 会把 `T` 当成名字。
  {
    re: /^\s*impl(?:<[^>]*>)?\s+(?:\w+\s+for\s+)?(\w+)/,
    kind: 'impl',
    nameGroup: 1,
  },
  {
    re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+(\w+)/,
    kind: 'function',
    nameGroup: 1,
    methodWhenIndented: true,
  },
]

/**
 * Java/C# 的修饰符前缀。两者共用一条表，因为 `public static final` 这类前缀写法一致；
 * 差异（`internal`/`sealed` vs `synchronized`）放进同一张表无害——多认一个别的语言的
 * 关键字，只会让它落到"没匹配"而不是"误报"。
 */
const ACCESS_MODIFIERS = '(?:(?:public|private|protected|internal)\\s+)*'
const JAVA_MODIFIERS =
  '(?:(?:public|private|protected|internal|static|final|abstract|sealed|partial)\\s+)*'

const JAVA_PATTERNS: readonly Pattern[] = [
  {
    // `record`（Java 16+ / C# 9+）与 `struct`（C#）都不是 class，但契约的 kind 枚举里
    // 没有 record，且声明形状与 class 一致，所以归入 class 而不新造 kind。
    re: new RegExp(`^\\s*${JAVA_MODIFIERS}(?:class|record|struct)\\s+(\\w+)`),
    kind: 'class',
    nameGroup: 1,
  },
  { re: new RegExp(`^\\s*${JAVA_MODIFIERS}interface\\s+(\\w+)`), kind: 'interface', nameGroup: 1 },
  { re: new RegExp(`^\\s*${JAVA_MODIFIERS}enum\\s+(\\w+)`), kind: 'enum', nameGroup: 1 },
  {
    // 构造器：只有访问修饰符 + 大写开头的名字 + `(`。必须排在方法模式**前面**，否则
    // `public UserService(Repo repo)` 会被方法模式当成"返回类型 UserService、方法名 Repo"。
    // 只允许访问修饰符（构造器不能 static/final），这同时挡掉 `new Foo(x)`：`new` 不是
    // 访问修饰符，而 `Foo` 又不以小写开头，两边都不成立。
    re: new RegExp(`^\\s*${ACCESS_MODIFIERS}([A-Z]\\w*)\\s*\\(`),
    kind: 'method',
    nameGroup: 1,
  },
  {
    // 方法必须有至少一个修饰符，否则 `foo(x)` 这样的调用会命中。这里不要求缩进：
    // 有些 Java 风格把类成员写在第 0 列，而修饰符要求本身已经足够挡掉调用。
    re: /^\s*(?:(?:public|private|protected|internal|static|final|abstract|sealed|virtual|override|async|synchronized|native|extern|unsafe|new)\s+)+[\w<>[\],.?]+\s+(\w+)\s*\(/,
    kind: 'method',
    nameGroup: 1,
  },
]

const PATTERNS_BY_FAMILY: Readonly<Record<Family, readonly Pattern[]>> = {
  ts: TS_JS_PATTERNS,
  py: PY_PATTERNS,
  go: GO_PATTERNS,
  rs: RS_PATTERNS,
  java: JAVA_PATTERNS,
}

/**
 * 会误撞成声明名的控制流关键字——**只列这五个**，因为只有它们会写成
 * `关键字(条件) {` 的形状，而那正好命中宽松的方法模式（`  if (ready) {` 会被读成
 * 名为 `if` 的方法）。`do`/`else`/`try`/`finally` 后面不接 `(`，正则本身就挡住了。
 *
 * 刻意**不**放 `new`/`default`/`delete`/`void`：它们在多种语言里是合法且常见的声明名
 * （Rust 每个结构体几乎都有 `pub fn new`，`fn default` 来自 Default trait），
 * 过滤掉它们等于系统性漏掉 Rust 最常见的构造函数。JS/TS 里 `delete()`/`new()` 也是
 * 合法方法名。少过滤不会造成误报——`  new Foo(x) {` 这种行过不了正则。
 */
const NOT_A_NAME = new Set(['if', 'for', 'while', 'switch', 'catch'])

/**
 * 从路径取小写扩展名。只看 basename 的最后一个点：`a/b/foo.d.ts` → `ts`，
 * `README` → `''`，`.eslintrc` → `eslintrc`（首点不算分隔，因此不会命中覆盖表）。
 * 大小写不敏感：Windows 检出的仓库里 `.TS` 和 `.ts` 是同一件事。
 */
function extensionOf(path: string): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const base = slash === -1 ? path : path.slice(slash + 1)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return ''
  return base.slice(dot + 1).toLowerCase()
}

/**
 * 文件级事实记录：没有声明内容，只有"这次扫描到底发生了什么"。
 * `name` 空串 + `startLine` 0 是它与真实声明的唯一区分方式（见 isDeclarationHit）。
 */
function buildFact(
  path: string,
  excerptChars: number,
  truncated: boolean,
  supported: boolean,
): SignatureHit {
  return {
    path,
    kind: 'function',
    name: '',
    signature: '',
    startLine: 0,
    excerptChars,
    truncated,
    supported,
  }
}

function buildHit(
  path: string,
  raw: string,
  kind: SignatureKind,
  name: string,
  startLine: number,
  excerptChars: number,
  truncated: boolean,
): SignatureHit {
  const signature = raw.trim()
  return {
    path,
    kind,
    name,
    signature:
      signature.length > SIGNATURE_MAX_CHARS ? signature.slice(0, SIGNATURE_MAX_CHARS) : signature,
    startLine,
    excerptChars,
    truncated,
    supported: true,
  }
}

/**
 * 扫描一段文件头摘录，返回文件级事实记录 + 按源码顺序排列的声明证据。纯函数：不读盘、
 * 不联网、不碰全局状态，同一输入必得同一输出。
 *
 * `truncated` 是**推断值**：纯函数只拿到摘录，看不到文件真实长度，无法证明它被截断过。
 * 唯一可用的信号是"摘录把 1200 字符窗口填满了"（`excerpt.length >= EXCERPT_WINDOW_CHARS`），
 * 恰好 1200 字符的文件因此会被多报一次截断。方向是故意的：多标一次"可能不完整"只是保守，
 * 漏标一次就是把局部证据冒充成全部。调用方若知道真实文件长度，应当用自己的事实覆盖它。
 *
 * 覆盖外的扩展名返回**只有事实记录**的一条数组（`supported: false`），不是空数组：
 * 空数组读起来是"扫过了，没有声明"，那正好是 design.md §2.4 禁止的那种误读。
 */
export function scanSignatures(path: string, excerpt: string): SignatureHit[] {
  const excerptChars = excerpt.length
  const truncated = excerptChars >= EXCERPT_WINDOW_CHARS
  const family = FAMILY_BY_EXT[extensionOf(path)]
  const hits: SignatureHit[] = [buildFact(path, excerptChars, truncated, family !== undefined)]

  if (family === undefined) return hits

  const patterns = PATTERNS_BY_FAMILY[family]
  const lines = excerpt.split('\n')

  for (let i = 0; i < lines.length; i++) {
    if (hits.length >= MAX_HITS_PER_FILE) break

    // CRLF：`\r` 会在 signature 里留痕，先剥掉；正则里的 `\s*$` 本来就吃 `\r`。
    const raw = (lines[i] ?? '').replace(/\r$/, '')
    if (raw.trim() === '') continue

    for (const pattern of patterns) {
      const m = pattern.re.exec(raw)
      if (m === null) continue
      const name = m[pattern.nameGroup]
      if (name === undefined || name === '' || NOT_A_NAME.has(name)) continue
      if (pattern.verify !== undefined && !pattern.verify(m)) continue

      const kind =
        pattern.methodWhenIndented === true
          ? /^\s/.test(raw)
            ? 'method'
            : 'function'
          : pattern.kind

      hits.push(buildHit(path, raw, kind, name, i + 1, excerptChars, truncated))
      // 一行只出一条：先命中的模式赢，输出顺序因此严格等于源码顺序。
      break
    }
  }

  return hits
}
