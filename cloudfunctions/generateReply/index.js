// 调用 DeepSeek 生成回复建议
// 支持两种模式：
//   type='reply'    被动回复 crush 的消息（默认）
//   type='initiate' 主动找 crush（破冰/邀约/关心/道歉/节日/其他）
//
// V2「灵魂共振」升级：
//   1. 三层 Prompt：总纲（聊天哲学）+ 人物画像（双方资料）+ 近期对话记忆 + 本轮任务
//   2. 近期记忆：自动取最近若干轮对话（含「我选中/兜底的回复」）拼进 prompt，让上下文连贯
//   3. 关系阶段：按用户标注或对话轮数推断亲密度档位，动态调整聊天策略
const cloud = require('wx-server-sdk');
const axios = require('axios');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-chat';

// 近期记忆：最多回看多少轮、拼进 prompt 的最多行数
const HISTORY_FETCH_LIMIT = 12; // 多查几条，给被排除/失败的空轮留缓冲
const HISTORY_MAX_LINES = 20;   // 约等于最近 10 轮对话

// 内容安全检测：调用微信 msgSecCheck
// 返回 { safe: bool, label?: string }
async function checkMsgSec(content, openid) {
  if (!content || !content.trim()) return { safe: true };
  try {
    const res = await cloud.openapi.security.msgSecCheck({
      version: 2,
      openid,
      scene: 4, // 1 资料；2 评论；3 论坛；4 社交日志
      content: content.trim()
    });
    if (res && res.result && res.result.suggest === 'risky') {
      return { safe: false, label: res.result.label };
    }
    return { safe: true };
  } catch (err) {
    // 网络/API 异常时，fail-open（demo 阶段），但记日志
    console.warn('[msgSecCheck] error, fail-open:', err.errMsg || err.message);
    return { safe: true, warning: true };
  }
}

const SCENARIOS = {
  icebreak: {
    label: '破冰',
    emoji: '💬',
    description: '刚加微信不久，想自然地开启第一句话或找个轻松话题',
    directive: '生成自然的破冰话术。避免太突兀或像查户口，建议从轻松话题切入，留下让对方有话可接的余地'
  },
  invite: {
    label: '邀约',
    emoji: '📅',
    description: '想约 ta 一起做点什么（吃饭/看电影/出去玩等）',
    directive: '生成自然的邀约话术。既要表达想见面的意思，又给对方拒绝的余地，不要显得迫切或绑架对方'
  },
  care: {
    label: '关心',
    emoji: '🤗',
    description: 'ta 最近有特殊事（考试/出差/生病等），想表达关心',
    directive: '生成体现关心的开场。要真诚不矫情、不说教、点到即止；可以问候但不要追问'
  },
  apology: {
    label: '道歉',
    emoji: '🙏',
    description: '吵架或做错事后想主动开口和解',
    directive: '生成诚恳的道歉/和好话术。承认问题但不卑微，给彼此台阶下，避免冷冰冰的"对不起"'
  },
  festival: {
    label: '节日',
    emoji: '🎉',
    description: '生日/七夕/圣诞等特殊日子想送祝福',
    directive: '根据今天日期判断当前或最近的节日（如七夕、圣诞、元旦、春节、中秋、生日等）。生成有心意的祝福话术，避免群发模板感，体现对 ta 的个人化关注'
  },
  other: {
    label: '其他',
    emoji: '💡',
    description: '其他主动想表达的事',
    directive: '根据用户描述的具体意图生成自然的开场话术'
  }
};

// ============ 关系阶段：档位 + 对应策略 ============
const STAGE_STRATEGY = {
  初识期: '以安全区(日程)和舒适区(兴趣)为主（约 80%），只轻度试探三观；保持礼貌和分寸，多给对方表达和接话的空间，不要过快拉近距离。',
  熟悉期: '安全区+舒适区 与 深水区(观点)+进阶区(情感) 各占一半；可以开始交换一些看法、开适度的玩笑，逐步加深了解。',
  暧昧期: '偏重灵魂共振与情感连接（约 70%），生活渗透为辅；可以有适度的暧昧张力和心动感，但仍要尊重对方的节奏，不越界。'
};

// 用户在资料里标注的关系阶段 → 档位映射
const RELATION_STAGE_MAP = {
  初识: '初识期',
  朋友: '熟悉期',
  暧昧中: '暧昧期',
  在追: '暧昧期'
};

function deriveStage(conv, roundCount) {
  if (conv && conv.relationStage && RELATION_STAGE_MAP[conv.relationStage]) {
    return RELATION_STAGE_MAP[conv.relationStage];
  }
  if (roundCount < 20) return '初识期';
  if (roundCount <= 50) return '熟悉期';
  return '暧昧期';
}

// 把一个数组字段安全转成「、」连接的字符串，空则返回 ''
function joinTags(v) {
  if (!Array.isArray(v)) return '';
  const arr = v.filter(x => x && String(x).trim());
  return arr.join('、');
}

// 仅当有值时才往 lines 推一行，避免把空字段写成「未知」污染 prompt
function pushIf(lines, label, value) {
  const v = value && String(value).trim();
  if (v) lines.push(`- ${label}：${v}`);
}

// 由「认识日期」实时算出「认识多久」的人话描述。
// 兼容老数据：没有 knownSince 时回退到旧的 knownDuration 文本标签。
function describeKnownDuration(conv) {
  const since = conv.knownSince;
  if (since) {
    const d = new Date(since);
    if (!isNaN(d.getTime())) {
      const days = Math.floor((Date.now() - d.getTime()) / 86400000);
      if (days < 0) return conv.knownDuration || '';
      if (days <= 7) return `刚认识（约 ${days} 天）`;
      if (days < 30) return `认识 ${Math.floor(days / 7)} 周`;
      if (days < 365) return `认识约 ${Math.floor(days / 30)} 个月`;
      const years = Math.floor(days / 365);
      const months = Math.floor((days % 365) / 30);
      return months > 0 ? `认识约 ${years} 年 ${months} 个月` : `认识约 ${years} 年`;
    }
  }
  return conv.knownDuration || '';
}

// ============ 第一层：总纲 Prompt（统领所有对话）============
function buildCorePrompt(stage) {
  const lines = [];
  lines.push('你不是在扮演 AI 助手，你就是「我」本人在微信上跟 crush（我喜欢/暗恋的人）聊天。');
  lines.push('请基于下面的资料和聊天记录，用「我」的第一人称口吻生成回复，目标是自然地加深彼此的了解和信赖。');
  lines.push('');
  lines.push('【底层聊天哲学】');
  lines.push('一段舒适的长期关系里，每天聊的内容大致分四块：');
  lines.push('- 日程（约20%）·安全区：用碎片拼出对方的生活画像。别问「吃了吗/下班了吗」这类机械寒暄，而是先分享自己的状态、留出让对方接话的口子。');
  lines.push('- 兴趣爱好（约20%）·舒适区：发掘对方一聊就停不下来的爱好，为以后见面/送礼埋伏笔。');
  lines.push('- 观点三观（约30%）·深水区：借热点或别人的故事，自然地交换看法、价值观、感情观，制造灵魂共振。');
  lines.push('- 情感需求（约30%）·进阶区：接住对方的情绪比抛新话题更重要。先识别 ta 此刻要的是安慰、是陪伴、还是认可，再回应。');
  lines.push('整体配比约等于「60% 灵魂共振 + 40% 生活渗透」。');
  lines.push('');
  lines.push(`【当前关系阶段】${stage}`);
  lines.push(STAGE_STRATEGY[stage] || STAGE_STRATEGY.初识期);
  lines.push('');
  lines.push('【铁律——让回复像真人，而不是 AI】');
  lines.push('1. 口语化：像微信里随手打字，可以有口头语、语气词，但不要堆「哈哈哈」、不滥用感叹号、不用书面腔。');
  lines.push('2. 留钩子：尽量给对方留个能接的话头，但不要连环追问，别像查户口/审讯。');
  lines.push('3. 看阶段：按上面的关系阶段控制亲密度和话题深度，循序渐进，不要一上来就过火。');
  lines.push('4. 用上资料：自然地呼应对方的爱好、性格、最近聊过的事，但别生硬地报菜名式罗列。');
  lines.push('5. 不要输出任何解释、不要加引号、不要写「作为AI」之类的话。');
  return lines.join('\n');
}

// ============ 第二层：人物画像（双方资料，只拼有值的）============
function buildProfileBlock(conv, user) {
  const lines = [];
  lines.push('【Ta（我的 crush）的资料】');
  pushIf(lines, '昵称', conv.crushNickname || 'crush');
  pushIf(lines, '性别', conv.crushGender);
  pushIf(lines, '年龄段', conv.crushAge);
  pushIf(lines, 'MBTI', conv.crushMbti);
  pushIf(lines, '星座', conv.crushZodiac);
  pushIf(lines, '兴趣爱好', joinTags(conv.crushHobbies));
  pushIf(lines, 'Ta 最近提过', conv.crushRecentMentions);
  pushIf(lines, '性格印象', joinTags(conv.crushPersonality));
  pushIf(lines, '聊天风格', joinTags(conv.crushChatStyle));
  pushIf(lines, '认识多久', describeKnownDuration(conv));
  pushIf(lines, '关系阶段', conv.relationStage);
  pushIf(lines, '见面情况', conv.metInPerson);

  // AI 沉淀出来的 crush 特征（三级记忆 / Phase 2 写入，有就用）
  const insights = conv.crushInsights || '';
  if (insights && String(insights).trim()) {
    lines.push('');
    lines.push('【从过往对话中观察到的 Ta】');
    lines.push(String(insights).trim());
  }

  // 历史话题累积摘要（二级记忆 / Phase 2 写入，只取最新一条）
  const summaries = Array.isArray(conv.memorySummaries) ? conv.memorySummaries : [];
  const latestSummary = summaries.length ? (summaries[summaries.length - 1].text || '') : '';
  if (latestSummary && String(latestSummary).trim()) {
    lines.push('');
    lines.push('【之前聊过的重点（更早的对话摘要，仅供背景，别直接复述）】');
    lines.push(String(latestSummary).trim());
  }

  // 「我」的资料：帮助 AI 用我的口吻、呼应共同点（按隐私约定不传我的昵称）
  const meLines = [];
  pushIf(meLines, '性别', user && user.gender);
  pushIf(meLines, '年龄段', user && user.age);
  pushIf(meLines, 'MBTI', user && user.mbti);
  pushIf(meLines, '星座', user && user.zodiac);
  pushIf(meLines, '兴趣爱好', user && joinTags(user.hobbies));
  pushIf(meLines, '我最近在追', user && user.recentInto);
  pushIf(meLines, '职业方向', user && user.occupation);
  pushIf(meLines, '所在城市', user && user.city);
  pushIf(meLines, '我的聊天习惯', user && joinTags(user.chatHabits));
  if (meLines.length) {
    lines.push('');
    lines.push('【我自己的资料（用来模仿我的口吻、找共同点）】');
    lines.push(...meLines);
  }

  return lines.join('\n');
}

// ============ 第三层：近期对话记忆 ============
// 取最近若干轮，拼成「Ta：xxx / 我：xxx」。
// 「我」那句优先用选中的回复(selectedText)，没选则兜底用第一条建议(suggestions[0])，
// 整轮没有任何内容（失败空轮）则跳过，保证记忆不断档也不塞脏数据。
async function fetchHistory(conversationId, excludeId) {
  let rows;
  try {
    const res = await db.collection('messages')
      .where({ conversationId, deletedAt: null })
      .orderBy('createdAt', 'desc')
      .limit(HISTORY_FETCH_LIMIT)
      .get();
    rows = res.data || [];
  } catch (err) {
    console.warn('[fetchHistory] failed:', err.errMsg || err.message);
    return [];
  }

  rows = rows.filter(m => m._id !== excludeId).reverse(); // 回到时间正序

  const turns = [];
  for (const m of rows) {
    const myReply =
      (m.selectedText && String(m.selectedText).trim()) ||
      (Array.isArray(m.suggestions) && m.suggestions[0]) ||
      '';
    if (m.type === 'initiate') {
      if (myReply) turns.push(`我（主动）：${myReply}`);
    } else {
      if (m.crushMessage) turns.push(`Ta：${m.crushMessage}`);
      if (myReply) turns.push(`我：${myReply}`);
    }
  }
  return turns.slice(-HISTORY_MAX_LINES);
}

function buildHistoryBlock(historyLines) {
  if (!historyLines || !historyLines.length) return '';
  const lines = [];
  lines.push('【最近的聊天记录（越往下越新，「我」那几句是你之前的口吻，请保持一致）】');
  lines.push(...historyLines);
  return lines.join('\n');
}

exports.main = async (event) => {
  const { conversationId, crushMessage, styleId } = event;
  const type = event.type === 'initiate' ? 'initiate' : 'reply';
  const intent = event.intent || null;
  const count = Math.min(Math.max(Number(event.count) || 1, 1), 3);
  // 「再来 N 条」会带上已有那条消息的 id：表示追加建议，而不是新建一轮对话
  const appendToMessageId = event.appendToMessageId || null;

  if (!conversationId || !styleId) {
    return { success: false, error: 'missing_params' };
  }
  if (type === 'reply' && !crushMessage) {
    return { success: false, error: 'missing_crush_message' };
  }
  if (type === 'initiate' && (!intent || !intent.scenario)) {
    return { success: false, error: 'missing_intent' };
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return {
      success: false,
      error: 'no_api_key',
      hint: '请在云开发后台「云函数 → generateReply → 配置 → 环境变量」里设置 DEEPSEEK_API_KEY'
    };
  }

  const wxContextEarly = cloud.getWXContext();
  const openid = wxContextEarly.OPENID;

  // ============ 输入内容安全检测 ============
  const userInputs = [];
  if (type === 'reply' && crushMessage) userInputs.push(crushMessage);
  if (type === 'initiate' && intent && intent.context) userInputs.push(intent.context);
  for (const input of userInputs) {
    const check = await checkMsgSec(input, openid);
    if (!check.safe) {
      return {
        success: false,
        error: 'content_unsafe_input',
        hint: '输入内容包含敏感词，请修改后重试',
        label: check.label
      };
    }
  }

  let conv;
  try {
    const res = await db.collection('conversations').doc(conversationId).get();
    conv = res.data;
  } catch (err) {
    return { success: false, error: 'conversation_not_found', detail: err.errMsg };
  }

  const styleRes = await db.collection('styles').where({ id: styleId }).limit(1).get();
  if (!styleRes.data.length) {
    return { success: false, error: 'style_not_found' };
  }
  const style = styleRes.data[0];

  // 「我」的资料（用于模仿口吻 / 找共同点）
  let user = {};
  try {
    const uRes = await db.collection('users').where({ _openid: openid }).limit(1).get();
    if (uRes.data.length) user = uRes.data[0];
  } catch (err) {
    console.warn('[generateReply] load user failed:', err.errMsg || err.message);
  }

  // 关系阶段：按对话轮数 + 用户标注推断
  let roundCount = 0;
  try {
    const cntRes = await db.collection('messages')
      .where({ conversationId, deletedAt: null })
      .count();
    roundCount = cntRes.total || 0;
  } catch (err) {
    // 取不到就当 0，走初识期
  }
  const stage = deriveStage(conv, roundCount);

  // 近期对话记忆
  const historyLines = await fetchHistory(conversationId, appendToMessageId);

  const prompt = type === 'initiate'
    ? buildInitiatePrompt(conv, user, style, intent, count, historyLines, stage)
    : buildReplyPrompt(conv, user, style, crushMessage, count, historyLines, stage);

  let suggestions;
  try {
    const apiRes = await axios.post(DEEPSEEK_URL, {
      model: DEEPSEEK_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.9,
      max_tokens: 400
    }, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    const text = apiRes.data.choices[0].message.content || '';
    suggestions = text
      .split('\n')
      .map(s => s.replace(/^\s*[\d一二三四五]+[.、)）]\s*/, '').replace(/^["「『]|["」』]$/g, '').trim())
      .filter(s => s.length > 0)
      .slice(0, count);

    if (suggestions.length === 0) {
      return { success: false, error: 'empty_reply', raw: text };
    }

    // ============ AI 输出内容安全检测 ============
    const safeSuggestions = [];
    for (const s of suggestions) {
      const check = await checkMsgSec(s, openid);
      if (check.safe) safeSuggestions.push(s);
    }
    if (safeSuggestions.length === 0) {
      return {
        success: false,
        error: 'content_unsafe_output',
        hint: 'AI 生成的内容触发了安全检测，请换个说法或换个风格重试'
      };
    }
    suggestions = safeSuggestions;
  } catch (err) {
    return {
      success: false,
      error: 'deepseek_call_failed',
      detail: (err.response && err.response.data) || err.message
    };
  }

  const now = new Date();

  // ============ 追加模式：「再来 N 条」 ============
  // 把新建议合并进已有那条消息，不新建记录（否则重进聊天页会出现重复的一轮对话）
  if (appendToMessageId) {
    const _ = db.command;
    try {
      await db.collection('messages').doc(appendToMessageId).update({
        data: { suggestions: _.push(suggestions) }
      });
    } catch (err) {
      return { success: false, error: 'append_failed', detail: err.errMsg };
    }
    return {
      success: true,
      messageId: appendToMessageId,
      suggestions, // 只返回这次新生成的几条，前端自行合并到原卡片
      styleId,
      type,
      intent,
      appended: true
    };
  }

  // ============ 正常模式：新建一轮对话 ============
  const msgAdd = await db.collection('messages').add({
    data: {
      _openid: openid,
      conversationId,
      type,
      intent: type === 'initiate' ? intent : null,
      crushMessage: type === 'reply' ? crushMessage : '',
      styleId,
      suggestions,
      selectedIndex: null,
      selectedText: '',
      createdAt: now,
      deletedAt: null
    }
  });

  // 更新会话最近活动
  const preview = type === 'initiate'
    ? `💡 主动·${(SCENARIOS[intent.scenario] || SCENARIOS.other).label}`
    : crushMessage.slice(0, 30);
  try {
    await db.collection('conversations').doc(conversationId).update({
      data: { lastMessageAt: now, lastMessagePreview: preview }
    });
  } catch (err) {
    console.warn('update conv lastMessage failed:', err.errMsg);
  }

  return {
    success: true,
    messageId: msgAdd._id,
    suggestions,
    styleId,
    type,
    intent,
    createdAt: now
  };
};

function buildReplyPrompt(conv, user, style, crushMessage, count, historyLines, stage) {
  const lines = [];
  lines.push(buildCorePrompt(stage));
  lines.push('');
  lines.push(buildProfileBlock(conv, user));

  const historyBlock = buildHistoryBlock(historyLines);
  if (historyBlock) {
    lines.push('');
    lines.push(historyBlock);
  }

  lines.push('');
  lines.push('【本轮回复风格】');
  lines.push(style.promptInstruction);
  lines.push('');
  lines.push('【Ta 刚才发的消息】');
  lines.push(crushMessage);
  lines.push('');
  lines.push(`请生成 ${count} 条回复建议，要求：`);
  lines.push('1. 用「我」的第一人称口吻，承接上面的聊天记录，别和前文矛盾');
  lines.push('2. 像微信聊天那样自然简洁，每条不超过 30 个字');
  if (count > 1) {
    lines.push('3. 多条之间要有差异感（角度或语气不同）');
    lines.push('4. 直接输出回复内容，不要编号、不要解释、不要加引号');
    lines.push(`5. 每条占一行，共 ${count} 行`);
  } else {
    lines.push('3. 直接输出回复内容，不要解释、不要加引号');
  }
  lines.push('');
  lines.push('直接开始输出：');
  return lines.join('\n');
}

function buildInitiatePrompt(conv, user, style, intent, count, historyLines, stage) {
  const scenario = SCENARIOS[intent.scenario] || SCENARIOS.other;
  const today = new Date();
  const todayStr = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;

  const lines = [];
  lines.push(buildCorePrompt(stage));
  lines.push('');
  lines.push(buildProfileBlock(conv, user));

  const historyBlock = buildHistoryBlock(historyLines);
  if (historyBlock) {
    lines.push('');
    lines.push(historyBlock);
  }

  lines.push('');
  lines.push(`【今天日期】${todayStr}`);
  lines.push('');
  lines.push(`【主动场景】${scenario.emoji} ${scenario.label}`);
  lines.push(scenario.description);
  lines.push(scenario.directive);
  if (intent.context) {
    lines.push('');
    lines.push('【具体想说什么】');
    lines.push(intent.context);
  }
  lines.push('');
  lines.push('【语气风格】');
  lines.push(style.promptInstruction);
  lines.push('');
  lines.push(`请生成 ${count} 条不同的开场白，要求：`);
  lines.push('1. 用「我」的第一人称口吻，是我主动找 ta；如果上面有聊天记录，要自然衔接，别重复说过的话');
  lines.push('2. 像微信主动找人聊天那样自然，每条不超过 30 字');
  lines.push('3. 这是我主动发的开场白，不要假设 ta 刚说过什么');
  if (count > 1) {
    lines.push('4. 多条之间要有差异感');
    lines.push('5. 直接输出内容，不要编号、不要解释、不要加引号');
    lines.push(`6. 每条占一行，共 ${count} 行`);
  } else {
    lines.push('4. 直接输出内容，不要解释、不要加引号');
  }
  lines.push('');
  lines.push('直接开始输出：');
  return lines.join('\n');
}
