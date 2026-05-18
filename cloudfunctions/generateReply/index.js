// 调用 DeepSeek 生成回复建议
const cloud = require('wx-server-sdk');
const axios = require('axios');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-chat';

exports.main = async (event) => {
  const { conversationId, crushMessage, styleId } = event;
  const count = Math.min(Math.max(Number(event.count) || 1, 1), 3);

  if (!conversationId || !crushMessage || !styleId) {
    return { success: false, error: 'missing_params' };
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return {
      success: false,
      error: 'no_api_key',
      hint: '请在云开发后台「云函数 → generateReply → 配置 → 环境变量」里设置 DEEPSEEK_API_KEY'
    };
  }

  // 1. 取对话信息（crush 资料）
  let conv;
  try {
    const res = await db.collection('conversations').doc(conversationId).get();
    conv = res.data;
  } catch (err) {
    return { success: false, error: 'conversation_not_found', detail: err.errMsg };
  }

  // 2. 取风格指令
  const styleRes = await db.collection('styles').where({ id: styleId }).limit(1).get();
  if (!styleRes.data.length) {
    return { success: false, error: 'style_not_found' };
  }
  const style = styleRes.data[0];

  // 3. 拼 prompt
  const prompt = buildPrompt(conv, style, crushMessage, count);

  // 4. 调 DeepSeek
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
  } catch (err) {
    return {
      success: false,
      error: 'deepseek_call_failed',
      detail: (err.response && err.response.data) || err.message
    };
  }

  // 5. 写 message 记录
  const wxContext = cloud.getWXContext();
  const now = new Date();
  const msgAdd = await db.collection('messages').add({
    data: {
      _openid: wxContext.OPENID,
      conversationId,
      crushMessage,
      styleId,
      suggestions,
      selectedIndex: null,
      createdAt: now,
      deletedAt: null
    }
  });

  // 6. 更新 conversation 的最近消息
  try {
    await db.collection('conversations').doc(conversationId).update({
      data: {
        lastMessageAt: now,
        lastMessagePreview: crushMessage.slice(0, 30)
      }
    });
  } catch (err) {
    // 更新失败不影响主流程
    console.warn('update conv lastMessage failed:', err.errMsg);
  }

  return {
    success: true,
    messageId: msgAdd._id,
    suggestions,
    styleId,
    createdAt: now
  };
};

function buildPrompt(conv, style, crushMessage, count) {
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
    lines.push('3. 多条之间要有差异感，给我多种选择');
    lines.push('4. 直接输出回复内容，不要编号、不要解释、不要加引号');
    lines.push(`5. 每条占一行，共 ${count} 行`);
  } else {
    lines.push('3. 直接输出回复内容，不要解释、不要加引号');
  }
  lines.push('');
  lines.push('直接开始输出：');
  return lines.join('\n');
}
