// 长期记忆维护（Phase 2 + 特征回填）
// 每攒够 N 轮对话，就把「上一条累积摘要 + 最近这批新对话」融合成一条更新后的摘要（二级记忆），
// 并把对 crush 的观察【分流】回填：
//   - 能归类到已有资料栏的（爱好 / 性格）→ 用 addToSet 追加进 crushHobbies / crushPersonality（只增不覆盖、自动去重）
//   - 归不了类的零散特征（在意的点、生活细节、聊天雷区）→ 写进 crushInsights（编辑页「AI 观察到」区块，可编辑）
//
// 设计要点：
//   - 幂等节流：用 conversations.lastSummarizedCount 记录「已总结到第几条」，
//     只有 当前消息数 - 已总结数 >= SUMMARIZE_EVERY 才真正跑，否则直接 skip。
//   - 分流回填：爱好/性格走 addToSet（不动用户手填的，只补新的）；其余进 crushInsights。
//   - 失败安全：总结失败不影响主聊天流程，返回错误即可，下次到点再补。
const cloud = require('wx-server-sdk');
const axios = require('axios');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-chat';

const SUMMARIZE_EVERY = 20;   // 每多少轮总结一次
const FETCH_RECENT = 26;      // 取最近多少条新对话喂给 AI（略大于 SUMMARIZE_EVERY 留缓冲）

// 把一段 messages 拼成「Ta：xxx / 我：xxx」对话文本（与 generateReply 的记忆口径一致）
function buildDialogText(rows) {
  const lines = [];
  for (const m of rows) {
    const myReply =
      (m.selectedText && String(m.selectedText).trim()) ||
      (Array.isArray(m.suggestions) && m.suggestions[0]) ||
      '';
    if (m.type === 'initiate') {
      if (myReply) lines.push(`我（主动）：${myReply}`);
    } else {
      if (m.crushMessage) lines.push(`Ta：${m.crushMessage}`);
      if (myReply) lines.push(`我：${myReply}`);
    }
  }
  return lines.join('\n');
}

function joinTags(v) {
  if (!Array.isArray(v)) return '';
  return v.filter(x => x && String(x).trim()).join('、');
}

function buildSummaryPrompt(ctx) {
  const { prevSummary, prevObservations, knownHobbies, knownPersonality, dialogText, name } = ctx;
  const lines = [];
  lines.push(`你在帮我维护和 ${name}（我喜欢的人）的聊天「长期记忆」。`);
  lines.push('请阅读【已有记忆】和【最近新增的对话】，更新记忆，并从对话里提炼出对 ta 的新观察。');
  lines.push('');
  lines.push('【已有的记忆摘要】（可能为空）');
  lines.push(prevSummary || '（暂无）');
  lines.push('');
  lines.push('【已记录的爱好】');
  lines.push(knownHobbies || '（暂无）');
  lines.push('【已记录的性格】');
  lines.push(knownPersonality || '（暂无）');
  lines.push('【其他已知观察】');
  lines.push(prevObservations || '（暂无）');
  lines.push('');
  lines.push('【最近新增的对话】');
  lines.push(dialogText || '（无）');
  lines.push('');
  lines.push('请只输出一个 JSON 对象，格式如下：');
  lines.push('{');
  lines.push('  "summary": "把过去到现在聊过的重点融合成一段累积摘要，150字以内，客观记录聊过哪些话题、对方透露的关键信息和态度变化",');
  lines.push('  "hobbies": ["从对话里明确体现的 ta 的兴趣爱好，每个2-6字的短词，只列【已记录的爱好】里没有的新爱好，没有就空数组"],');
  lines.push('  "personality": ["从对话里明确体现的 ta 的性格特点，每个2-6字短词，只列已记录里没有的，没有就空数组"],');
  lines.push('  "observations": "归不进爱好/性格的零散但稳定的观察：ta 在意的点、生活细节、聊天雷区、情感偏好等，用顿号或短句罗列，100字以内，和【其他已知观察】去重合并"');
  lines.push('}');
  lines.push('要求：hobbies / personality 必须是对话里有据可查的，宁缺毋滥不要编造；只输出 JSON 本身，不要加解释或代码块标记。信息不足就给空数组/沿用已有。');
  return lines.join('\n');
}

// 宽松解析 AI 返回的 JSON
function parseResult(text) {
  if (!text) return null;
  let t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  try {
    const obj = JSON.parse(t);
    const cleanArr = (a) => Array.isArray(a)
      ? a.map(x => String(x || '').trim()).filter(x => x && x.length <= 12).slice(0, 6)
      : [];
    return {
      summary: (obj.summary || '').toString().trim(),
      hobbies: cleanArr(obj.hobbies),
      personality: cleanArr(obj.personality),
      observations: (obj.observations || '').toString().trim()
    };
  } catch (e) {
    return null;
  }
}

exports.main = async (event) => {
  const { conversationId } = event;
  if (!conversationId) {
    return { success: false, error: 'missing_params' };
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return { success: false, error: 'no_api_key' };
  }

  const { OPENID } = cloud.getWXContext();

  // 读会话 + 越权校验
  let conv;
  try {
    const res = await db.collection('conversations').doc(conversationId).get();
    conv = res.data;
  } catch (err) {
    return { success: false, error: 'conversation_not_found' };
  }
  if (conv._openid && OPENID && conv._openid !== OPENID) {
    return { success: false, error: 'forbidden' };
  }

  // 当前消息总数
  let count = 0;
  try {
    const c = await db.collection('messages')
      .where({ conversationId, deletedAt: null })
      .count();
    count = c.total || 0;
  } catch (err) {
    return { success: false, error: 'count_failed' };
  }

  const lastSummarized = conv.lastSummarizedCount || 0;

  // 防御：用户删除过消息会让 count 落后于已记录的 lastSummarizedCount，
  // 不校正会让条件 count - lastSummarized < SUMMARIZE_EVERY 永远成立，再也不总结。
  // 这里直接把进度回拉到当前 count，下一轮重新蓄水即可。
  if (count < lastSummarized) {
    try {
      await db.collection('conversations').doc(conversationId).update({
        data: { lastSummarizedCount: count }
      });
    } catch (err) {
      // 校正失败不影响后续流程，下次进来还有机会再试
    }
    return { success: true, skipped: true, reason: 'realigned', count };
  }

  // 幂等节流：没攒够一个周期就不总结
  if (count - lastSummarized < SUMMARIZE_EVERY) {
    return { success: true, skipped: true, count, lastSummarized };
  }

  // 取最近一批对话
  let rows;
  try {
    const res = await db.collection('messages')
      .where({ conversationId, deletedAt: null })
      .orderBy('createdAt', 'desc')
      .limit(FETCH_RECENT)
      .get();
    rows = (res.data || []).reverse();
  } catch (err) {
    return { success: false, error: 'fetch_failed' };
  }

  const dialogText = buildDialogText(rows);
  if (!dialogText) {
    // 没有可用对话，直接把进度推进，避免反复触发
    await db.collection('conversations').doc(conversationId).update({
      data: { lastSummarizedCount: count }
    });
    return { success: true, skipped: true, reason: 'empty_dialog', count };
  }

  const prevSummaries = Array.isArray(conv.memorySummaries) ? conv.memorySummaries : [];
  const prevSummary = prevSummaries.length ? (prevSummaries[prevSummaries.length - 1].text || '') : '';

  const prompt = buildSummaryPrompt({
    name: conv.crushNickname || 'Ta',
    prevSummary,
    prevObservations: conv.crushInsights || '',
    knownHobbies: joinTags(conv.crushHobbies),
    knownPersonality: joinTags(conv.crushPersonality),
    dialogText
  });

  let parsed;
  try {
    const apiRes = await axios.post(DEEPSEEK_URL, {
      model: DEEPSEEK_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 700,
      response_format: { type: 'json_object' }
    }, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 40000
    });
    const text = apiRes.data.choices[0].message.content || '';
    parsed = parseResult(text);
    if (!parsed) {
      return { success: false, error: 'parse_failed', raw: text };
    }
  } catch (err) {
    return {
      success: false,
      error: 'deepseek_call_failed',
      detail: (err.response && err.response.data) || err.message
    };
  }

  // 写回：① 摘要留档 + 进度  ② 爱好/性格 addToSet 追加（不覆盖手填）③ 零散观察进 crushInsights
  const now = new Date();
  const updateData = { lastSummarizedCount: count };
  if (parsed.summary) {
    updateData.memorySummaries = _.push([{ text: parsed.summary, atCount: count, createdAt: now }]);
  }
  if (parsed.hobbies.length) {
    updateData.crushHobbies = _.addToSet({ $each: parsed.hobbies });
  }
  if (parsed.personality.length) {
    updateData.crushPersonality = _.addToSet({ $each: parsed.personality });
  }
  if (parsed.observations) {
    updateData.crushInsights = parsed.observations;
  }

  try {
    await db.collection('conversations').doc(conversationId).update({ data: updateData });
  } catch (err) {
    return { success: false, error: 'update_failed', detail: err.errMsg };
  }

  return {
    success: true,
    summarized: true,
    count,
    summary: parsed.summary,
    addedHobbies: parsed.hobbies,
    addedPersonality: parsed.personality,
    observations: parsed.observations
  };
};
