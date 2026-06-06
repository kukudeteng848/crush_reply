// 长期记忆维护（Phase 2）
// 每攒够 N 轮对话，就把「上一条累积摘要 + 最近这批新对话」融合成一条更新后的摘要（二级记忆），
// 并顺带刷新对 crush 的稳定特征画像（三级记忆 crushInsights）。
//
// 设计要点：
//   - 幂等节流：用 conversations.lastSummarizedCount 记录「已总结到第几条」，
//     只有 当前消息数 - 已总结数 >= SUMMARIZE_EVERY 才真正跑，否则直接 skip。
//     这样前端即使漏触发或重复触发，也不会重复总结/丢账。
//   - 滚动摘要：memorySummaries 数组留档（便于回看/调试），但 prompt 里只用最新一条。
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

function buildSummaryPrompt(prevSummary, prevInsights, dialogText, crushNickname) {
  const name = crushNickname || 'Ta';
  const lines = [];
  lines.push(`你在帮我维护和 ${name}（我喜欢的人）的聊天「长期记忆」。`);
  lines.push('下面有【已有的记忆摘要】【已知的特征】和【最近新增的对话】，请把它们融合成更新后的记忆。');
  lines.push('');
  lines.push('【已有的记忆摘要】（可能为空）');
  lines.push(prevSummary || '（暂无）');
  lines.push('');
  lines.push(`【已知的 ${name} 的特征】（可能为空）`);
  lines.push(prevInsights || '（暂无）');
  lines.push('');
  lines.push('【最近新增的对话】');
  lines.push(dialogText || '（无）');
  lines.push('');
  lines.push('请只输出一个 JSON 对象，格式如下：');
  lines.push('{');
  lines.push('  "summary": "把过去到现在聊过的重点融合成一段累积摘要，150字以内，客观记录聊过哪些话题、对方透露的关键信息和态度变化",');
  lines.push(`  "insights": "关于 ${name} 的稳定特征要点：喜欢/讨厌什么、在意的事、性格、聊天雷区，用顿号或短句罗列，80字以内，和已有特征去重合并"`);
  lines.push('}');
  lines.push('注意：只输出 JSON 本身，不要加解释、不要加代码块标记。若最近对话信息不足，可沿用已有内容。');
  return lines.join('\n');
}

// 宽松解析 AI 返回的 JSON（容忍 ```json 包裹、前后多余文字）
function parseResult(text) {
  if (!text) return null;
  let t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  try {
    const obj = JSON.parse(t);
    return {
      summary: (obj.summary || '').toString().trim(),
      insights: (obj.insights || '').toString().trim()
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
  const prevInsights = conv.crushInsights || '';

  const prompt = buildSummaryPrompt(prevSummary, prevInsights, dialogText, conv.crushNickname);

  let parsed;
  try {
    const apiRes = await axios.post(DEEPSEEK_URL, {
      model: DEEPSEEK_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 600,
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
    if (!parsed || (!parsed.summary && !parsed.insights)) {
      return { success: false, error: 'parse_failed', raw: text };
    }
  } catch (err) {
    return {
      success: false,
      error: 'deepseek_call_failed',
      detail: (err.response && err.response.data) || err.message
    };
  }

  // 写回：push 摘要留档 + 更新滚动进度 + 刷新特征
  const now = new Date();
  const updateData = { lastSummarizedCount: count };
  if (parsed.summary) {
    updateData.memorySummaries = _.push([{
      text: parsed.summary,
      atCount: count,
      createdAt: now
    }]);
  }
  if (parsed.insights) {
    updateData.crushInsights = parsed.insights;
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
    insights: parsed.insights
  };
};
