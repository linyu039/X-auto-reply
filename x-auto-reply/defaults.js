// 共享默认配置。以全局对象挂载，background(importScripts) / popup(<script>) / content(content_scripts 前置) 三处通用。
;(function (root) {
  root.XAR_DEFAULTS = {
    // 运行
    enabled: false,
    autoSend: true,        // false = 只把回复填进输入框，等人工点发送
    dryRun: false,         // true = 只生成不填不点，纯预演
    autoScroll: true,      // 评论区到底自动下滑加载更多
    speed: 'fast',         // turbo | fast | normal | safe —— 整体快慢，越小越快
    followOnReply: true,   // 你手动点开某条回复框时，自动代写这一条
    followAutoSend: false, // 跟随模式填完是否自动发送。false = 停在输入框等你按「回复」
    loopMode: true,        // true = 点一次连着回「本次上限」条；false = 只回一条
    maxPerHour: 40,
    maxPerRun: 15,
    minDelay: 30,          // 两条回复之间的最小间隔（秒），会再乘速度系数
    maxDelay: 75,

    // 高级：覆盖内置选择器。X 改版时不用改代码，在这里填就行
    // 例：{"sendBtn": "button[data-testid=\"tweetButton\"]"}
    customSelectors: {},

    // 模型
    apiBase: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    temperature: 0.95,
    maxTokens: 300,
    // 识图时自动切到这个模型。DeepSeek 的多模态模型名就是 deepseek-flash（V4.1 Flash），
    // 和 deepseek-chat 同一个 base_url、同一个 key，只需换模型名。
    visionModel: 'deepseek-flash',
    visionEnabled: false,  // 识别推文配图。留空 visionModel 则用上面的 model 硬顶

    // 点赞
    autoLike: false,       // 回复的同时给这条评论点个赞
    likeMain: false,       // 顺便把主推文也赞了
    maxLikes: 40,          // 每次运行最多点多少个，防止一口气赞太多

    // 回关
    autoFollow: false,          // 评论发出去后关注这条评论的作者
    maxFollows: 50,             // 本次最多关注多少个
    followCooldownMin: 15,      // 撞到 X 的关注限制后，等多少分钟再接着关注（回复不受影响）

    // 人设与规则
    persona: '你是一个真实的中文互联网用户，正在 X（Twitter）上刷推文、参与评论区的讨论。你说话直接、有观点、不装。',
    rules: [
      '回复控制在 1-2 句，像真人随口接话，不要开场白、不要总结、不要客套。',
      '必须针对这条评论里的具体内容回应：接一个观点、补一个小例子、或者反问一个具体的问题。',
      '不要复述对方说过的话，不要写"说得对""深有同感"这种空话。',
      '不要去揣测对方是不是复制粘贴、是不是搬运、是不是 AI 写的、内容从哪来，只针对内容本身说话。',
      '禁止营销腔、禁止话题标签、禁止堆 emoji、禁止自称 AI 或提及自己是程序。',
      '评论是英文就用英文回，是中文就用中文回，语言跟随对方。',
      '不要输出引号、不要输出解释说明，只输出回复正文本身。'
    ].join('\n'),

    // 安全
    skipOwn: true,
    myHandle: '',
    skipVerified: false,   // 跳过蓝V账号的评论
    skipPromoted: true,    // 跳过推广/广告
    maxLen: 120
  };
})(typeof self !== 'undefined' ? self : this);
