// Labelled trigger corpus: user phrasings the shipped SCOUT_GUIDANCE must name.
// Data only. `expect` = what the agent should do; `promptSignal` = exact
// substrings of SCOUT_GUIDANCE (never the tool description) that must occur.

export const TRIGGER_CASES = [
  // --- idea-plus-advice: an idea plus a request for advice -----------------
  {
    id: 'pomodoro-advice',
    category: 'idea-plus-advice',
    text: '我想制作一个番茄钟你有什么建议嘛',
    expect: 'search',
    why: '已有明确产品想法并征求建议，是 0.5.0 之前被漏掉的原始报告句。',
    promptSignal: ['我想做个番茄钟，有什么建议？', 'A request for advice'],
  },
  {
    id: 'screenshot-notes-advice',
    category: 'idea-plus-advice',
    text: '我想做一个把手机截图自动整理成笔记的东西，你觉得可行吗？',
    expect: 'search',
    why: '想法加可行性咨询，属于寻求建议，不是技术问答。',
    promptSignal: ['A request for advice'],
  },
  {
    id: 'habit-tracker-advice',
    category: 'idea-plus-advice',
    text: '最近想做个小工具记录每天喝水和运动，有什么思路吗',
    expect: 'search',
    why: '想做一个小工具并问思路，建议类请求触发检索。',
    promptSignal: ['A request for advice', 'SEARCH WHEN the user has an idea for something to build'],
  },

  // --- vague-idea: a buildable idea that is still fuzzy ---------------------
  {
    id: 'vague-collect-tool',
    category: 'vague-idea',
    text: '想弄个东西，把我收藏的公众号文章自动归类，还没想好具体怎么做',
    expect: 'search',
    why: '想法模糊但指向一个可做的工具，模糊不是不检索的理由。',
    promptSignal: ['even before it is precise', '我想弄个能自动整理小红书收藏的工具'],
  },
  {
    id: 'vague-bill-app',
    category: 'vague-idea',
    text: '有个想法，做一个帮我管理家庭账单的小应用，大概就这样',
    expect: 'search',
    why: '只有大致方向，仍属于「有个想法要做点什么」的情形。',
    promptSignal: ['even before it is precise'],
  },
  {
    id: 'vague-wechat-script',
    category: 'vague-idea',
    text: '不知道能不能做个自动帮我回微信消息的脚本',
    expect: 'search',
    why: '以「不知道能不能」包装的建站意图，仍应搜一下现状。',
    promptSignal: ['even before it is precise', 'SEARCH WHEN the user has an idea for something to build'],
  },

  // --- wish-for-a-tool: "要是有一个……就好了" -------------------------------
  {
    id: 'wish-batch-rename',
    category: 'wish-for-a-tool',
    text: '要是有个能批量重命名照片的工具就好了',
    expect: 'search',
    why: '愿望句式等价于「我想做这个」，是典型触发形态。',
    promptSignal: ['要是有个……就好了', 'a wish for a tool'],
  },
  {
    id: 'wish-csv-cleaner',
    category: 'wish-for-a-tool',
    text: '唉，真希望有个东西能自动把 Excel 里的脏数据清干净',
    expect: 'search',
    why: '感叹式愿望，没有说要做，但意图同样是缺一个工具。',
    promptSignal: ['a wish for a tool'],
  },

  // --- how-to-start: "这个该怎么做？" ---------------------------------------
  {
    id: 'howto-voice-notes',
    category: 'how-to-start',
    text: '我想做一个语音转文字的笔记应用，这个该怎么做？',
    expect: 'search',
    why: '想法加如何起步的提问，正是指导里点名的触发句。',
    promptSignal: ['这个该怎么做？', 'a question about how to start'],
  },
  {
    id: 'howto-chrome-extension',
    category: 'how-to-start',
    text: '打算写个 Chrome 插件拦截广告，从哪开始比较好？',
    expect: 'search',
    why: '「从哪开始」是求起步路径，不是求实现细节。',
    promptSignal: ['a question about how to start'],
  },
  {
    id: 'howto-mini-program',
    category: 'how-to-start',
    text: '想做个微信小程序记账，第一步应该干什么',
    expect: 'search',
    why: '第一步问法意味着还没动手，属于检索时机。',
    promptSignal: ['a question about how to start', 'SEARCH WHEN the user has an idea for something to build'],
  },

  // --- explicit-github: the literal word, which used to be the only trigger -
  {
    id: 'github-literal-search',
    category: 'explicit-github',
    text: '你去 GitHub 上帮我搜一下有没有类似的番茄钟项目',
    expect: 'search',
    why: '点名 GitHub 的显式请求；指导必须承认这个词，但不再依赖它。',
    promptSignal: ['never say "GitHub"', 'SEARCH WHEN the user has an idea for something to build'],
  },
  {
    id: 'github-before-build',
    category: 'explicit-github',
    text: '动手之前先去 github 看看别人怎么做的吧',
    expect: 'search',
    why: '以调研前置为理由的 GitHub 请求，仍是一次先例检索。',
    promptSignal: ['never say "GitHub"'],
  },

  // --- explicit-search-request: 搜 / 查 without necessarily saying GitHub ---
  {
    id: 'search-verbatim',
    category: 'explicit-search-request',
    text: '你可以去帮我查下我该怎么做嘛',
    expect: 'search',
    why: '原始报告里的第二句：只说了「查」，没说 GitHub。',
    promptSignal: ['有没有现成的？', 'SEARCH WHEN the user has an idea for something to build'],
  },
  {
    id: 'search-without-github',
    category: 'explicit-search-request',
    text: '帮我搜一下有没有现成的开源项目能做这个的',
    expect: 'search',
    why: '有「搜」无「GitHub」，是这条激活面最需要覆盖的近邻。',
    promptSignal: ['有没有现成的？'],
  },
  {
    id: 'search-competitors',
    category: 'explicit-search-request',
    text: '先查查市面上有没有人做过类似的东西吧',
    expect: 'search',
    why: '「有没有人做过」就是先例检索，措辞里没有工具名。',
    promptSignal: ['有没有现成的？', 'SEARCH WHEN the user has an idea for something to build'],
  },

  // --- capability-question: no idea yet, so offer rather than search -------
  {
    id: 'capability-verbatim',
    category: 'capability-question',
    text: '你可以帮我做什么嘛',
    expect: 'no-search',
    why: '还没有任何想法，不能检索；指导要求把这项能力说出来供用户选择。',
    promptSignal: ['what you can do', 'research whether a similar open-source project already exists'],
  },
  {
    id: 'capability-english',
    category: 'capability-question',
    text: 'what can you actually do for me?',
    expect: 'no-search',
    why: '能力询问没有对象可搜，正确动作是介绍能力并邀请用户说出想法。',
    promptSignal: ['what you can do'],
  },

  // --- pure-technical-qa: no build intent at all ---------------------------
  {
    id: 'qa-crdt',
    category: 'pure-technical-qa',
    text: '什么是 CRDT？和 OT 有什么区别',
    expect: 'no-search',
    why: '概念解释题，没有要做的东西，指导里点名不检索。',
    promptSignal: ['pure technical Q&A', '什么是 CRDT？'],
  },
  {
    id: 'qa-library-near-miss',
    category: 'pure-technical-qa',
    text: 'Zustand 和 Redux 有什么区别，哪个更适合中大型项目？',
    expect: 'no-search',
    why: '提到库名但只是选型问答，不构成「要做某个东西」。',
    promptSignal: ['pure technical Q&A', 'a concept explanation'],
  },
  {
    id: 'qa-useeffect-double',
    category: 'pure-technical-qa',
    text: 'why does my useEffect run twice in React 18 strict mode?',
    expect: 'no-search',
    why: '纯排错问答，用户在写代码而不是提出产品想法。',
    promptSignal: ['pure technical Q&A'],
  },

  // --- already-building: the user is past the idea stage --------------------
  {
    id: 'building-still-says-want',
    category: 'already-building',
    text: '我想做那个记账工具，已经动手写了，现在卡在分类规则上',
    expect: 'no-search',
    why: '句子里还有「想做」，但已经动手，属于实现细节而不是先例调研。',
    promptSignal: ['already building', 'writing code, debugging'],
  },
  {
    id: 'building-debug-403',
    category: 'already-building',
    text: '我这个爬虫的请求头为什么一直 403，代码就在这里',
    expect: 'no-search',
    why: '在调试自己的代码，指导明确列为不检索。',
    promptSignal: ['writing code, debugging'],
  },
  {
    id: 'building-impl-detail',
    category: 'already-building',
    text: '我自己的项目里这个函数报 TypeError，帮我看看哪里写错了',
    expect: 'no-search',
    why: '求看自己代码的实现错误，不是求同类项目。',
    promptSignal: ['already building', 'asking about implementation details of code they have'],
  },

  // --- already-searched: same idea already searched this session ------------
  {
    id: 'searched-same-idea-more-detail',
    category: 'already-searched',
    text: '我再补充一下，我想做的其实是给团队用的番茄钟，不是个人版',
    expect: 'no-search',
    why: '同一想法补充细节；本会话已搜过，再搜是重复而非新信息。',
    promptSignal: ['already searched this same idea'],
  },
  {
    id: 'searched-english-restate',
    category: 'already-searched',
    text: "to be clear, it's the same idea I described earlier — a team pomodoro timer",
    expect: 'no-search',
    why: '用户自己点明是同一个想法，重复检索不会带来新结果。',
    promptSignal: ['already searched this same idea'],
  },

  // --- user-said-no: an explicit refusal -----------------------------------
  {
    id: 'no-search-just-talk',
    category: 'user-said-no',
    text: '不用帮我搜了，直接说说你的想法就行',
    expect: 'no-search',
    why: '用户明确拒绝检索，任何搜索都违背指令。',
    promptSignal: ['user said not to search'],
  },
  {
    id: 'no-search-privacy',
    category: 'user-said-no',
    text: '别去网上查，我不想让别人看到这个需求',
    expect: 'no-search',
    why: '以隐私为由拒绝外查，属于用户说不搜的边界。',
    promptSignal: ['user said not to search'],
  },
]
