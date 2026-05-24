// 调用 DeepSeek 生成回复建议
// 支持两种模式：
//   type='reply'    被动回复 crush 的消息（默认）
//   type='initiate' 主动找 crush（破冰/邀约/关心/道歉/节日/其他）
const cloud = require('wx-server-sdk');
const axios = require('axios');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-chat';

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

exports.main = async (event) => {
  const { conversationId, crushMessage, styleId } = event;
  const type = event.type === 'initiate' ? 'initiate' : 'reply';
  const intent = event.intent || null;
  const count = Math.min(Math.max(Number(event.count) || 1, 1), 3);

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

  const prompt = type === 'initiate'
    ? buildInitiatePrompt(conv, style, intent, count)
    : buildReplyPrompt(conv, style, crushMessage, count);

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
      .map(s => s.replace(/^\s*[\d一二三四五]+[.、)]\s*/, '').replace(/^["「『]|["」』]$/g, '').trim())
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

function buildReplyPrompt(conv, style, crushMessage, count) {
  const lines = [];
  lines.push('你是一个微信聊天小助手，帮我回复 crush（暗恋对象）的消息。请假装是我本人，按要求生成回复。');
  lines.push('');
  lines.push('【我的 crush 资料】');
  lines.push(`- 昵称：${conv.crushNickname || 'crush'}`);
  lines.push(`- 性别：${conv.crushGender || '未知'}`);
  if (conv.crushMbti) lines.push(`- MBTI：${conv.crushMbti}`);
  if (conv.crushZodiac) lines.push(`- 星座：${conv.crushZodiac}`);
  lines.push('');
  lines.push('【回复风格】');
  lines.push(style.promptInstruction);
  lines.push('');
  lines.push('【Ta 刚才发的消息】');
  lines.push(crushMessage);
  lines.push('');
  lines.push(`请生成 ${count} 条回复建议，要求：`);
  lines.push('1. 假装是我（第一人称口吻）');
  lines.push('2. 像微信聊天那样自然简洁，每条不超过 30 个字');
  if (count > 1) {
    lines.push('3. 多条之间要有差异感');
    lines.push('4. 直接输出回复内容，不要编号、不要解释、不要加引号');
    lines.push(`5. 每条占一行，共 ${count} 行`);
  } else {
    lines.push('3. 直接输出回复内容，不要解释、不要加引号');
  }
  lines.push('');
  lines.push('直接开始输出：');
  return lines.join('\n');
}

function buildInitiatePrompt(conv, style, intent, count) {
  const scenario = SCENARIOS[intent.scenario] || SCENARIOS.other;
  const today = new Date();
  const todayStr = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;

  const lines = [];
  lines.push('你是一个微信聊天小助手，帮我主动给 crush（暗恋对象）发开场消息。请假装是我本人。');
  lines.push('');
  lines.push('【我的 crush 资料】');
  lines.push(`- 昵称：${conv.crushNickname || 'crush'}`);
  lines.push(`- 性别：${conv.crushGender || '未知'}`);
  if (conv.crushMbti) lines.push(`- MBTI：${conv.crushMbti}`);
  if (conv.crushZodiac) lines.push(`- 星座：${conv.crushZodiac}`);
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
  lines.push('1. 假装是我（第一人称口吻），是我主动找 ta');
  lines.push('2. 像微信主动找人聊天那样自然，每条不超过 30 字');
  lines.push('3. 这是开场白，ta 还没回话，不要假设 ta 说过什么');
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
