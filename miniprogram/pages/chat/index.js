// 跟云函数保持一致的场景配置（仅用于 UI 展示）
const SCENARIOS = [
  { key: 'icebreak', label: '破冰', emoji: '💬', hint: '刚加微信不知道说什么' },
  { key: 'invite', label: '邀约', emoji: '📅', hint: '想约 ta 出来玩' },
  { key: 'care', label: '关心', emoji: '🤗', hint: 'ta 今天考试/出差/生病' },
  { key: 'apology', label: '道歉', emoji: '🙏', hint: '吵架后想和好' },
  { key: 'festival', label: '节日', emoji: '🎉', hint: '生日/七夕/圣诞等' },
  { key: 'other', label: '其他', emoji: '💡', hint: '自由描述你的意图' }
];

const SCENARIO_MAP = SCENARIOS.reduce((m, s) => { m[s.key] = s; return m; }, {});

// 计算一条消息在首页列表里显示的预览文案（跟云函数 generateReply 里的逻辑保持一致）
function computePreview(m) {
  if (!m) return '';
  if (m.type === 'initiate') {
    const s = SCENARIO_MAP[(m.intent && m.intent.scenario)] || SCENARIO_MAP.other;
    return `💡 主动·${s.label}`;
  }
  return (m.crushMessage || '').slice(0, 30);
}

function formatTimeMark(date) {
  if (!date) return '';
  const d = new Date(date);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const yesterday = new Date(now.getTime() - 86400000);
  const isYesterday = d.toDateString() === yesterday.toDateString();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (isToday) return `今天 ${hh}:${mm}`;
  if (isYesterday) return `昨天 ${hh}:${mm}`;
  if (d.getFullYear() === now.getFullYear()) {
    return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
  }
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
}

const FIVE_MIN = 5 * 60 * 1000;

function decorateMessage(m, styleMap) {
  let typeLabel = 'AI 建议';
  if (m.type === 'initiate' && m.intent && m.intent.scenario) {
    const s = SCENARIO_MAP[m.intent.scenario] || SCENARIO_MAP.other;
    typeLabel = `${s.emoji} 主动·${s.label}`;
  }
  const s = styleMap && styleMap[m.styleId];
  // 风格被云后台禁用/删除后，老消息也要有体面的回退文案（避免裸露英文 id 如 humor）
  const styleDisplay = s ? `${s.emoji} ${s.displayName}` : '🎨 已下架风格';
  // 防御：旧数据或异常情况下 suggestions 可能缺失，兜底成数组避免渲染出空白卡片
  const suggestions = Array.isArray(m.suggestions) ? m.suggestions : [];
  return { ...m, suggestions, typeLabel, styleDisplay };
}

function withTimeMarks(messages, styleMap) {
  let lastT = 0;
  return messages.map((m, i) => {
    const t = m.createdAt ? new Date(m.createdAt).getTime() : Date.now();
    const showTime = i === 0 || (t - lastT) > FIVE_MIN;
    lastT = t;
    return { ...decorateMessage(m, styleMap), timeMark: showTime ? formatTimeMark(m.createdAt) : '' };
  });
}

Page({
  data: {
    conversationId: '',
    conversation: null,
    me: null,
    crushAvatarUrl: '',
    meAvatarUrl: '',
    styles: [],
    styleMap: {},
    selectedStyleId: '',
    selectedStyleDisplay: '',
    messages: [],
    inputText: '',
    loading: true,
    sending: false,
    scrollToView: '',
    errorMsg: '',
    // 分页：默认进入聊天页只拉最近 50 条，往上滑到顶触发拉更早
    earliestCreatedAt: null,
    hasMoreEarlier: false,
    loadingEarlier: false,
    // 主动模式弹窗
    initiateModalVisible: false,
    scenarios: SCENARIOS,
    selectedScenario: 'icebreak',
    intentContext: ''
  },

  async onShow() {
    const app = getApp();
    if (app && app.globalData && app.globalData.user) {
      this.setData({ me: app.globalData.user });
    }
    if (!this.data.loading && this.data.conversationId) {
      try {
        const db = wx.cloud.database();
        const res = await db.collection('conversations').doc(this.data.conversationId).get();
        this.setData({ conversation: res.data });
        wx.setNavigationBarTitle({ title: res.data.crushNickname || 'crush' });
      } catch (err) {
        // silent
      }
    }
    // 不管走没走上面的分支，都刷新一次头像临时链接（从「我的资料」改完头像返回也能更新）
    this.resolveAvatars();
  },

  // 把 crush 和「我」的头像 fileID(cloud://) 一次性换成 https 临时链接。
  // 聊天页每轮都渲染一对头像，长会话会有几十个 <image>；若直接用 cloud:// 逐个换链
  // 会触发限流导致头像批量空白。这里集中换一次、全列表复用同一个 https，规避该问题。
  async resolveAvatars() {
    const conv = this.data.conversation;
    const me = this.data.me;
    const ids = [];
    const crushId = conv && conv.crushAvatar;
    const meId = me && me.avatar;
    if (crushId && crushId.indexOf('cloud://') === 0) ids.push(crushId);
    if (meId && meId.indexOf('cloud://') === 0) ids.push(meId);
    if (!ids.length) return;
    try {
      const res = await wx.cloud.getTempFileURL({ fileList: ids });
      const map = {};
      (res.fileList || []).forEach(f => {
        if (f.fileID && f.tempFileURL) map[f.fileID] = f.tempFileURL;
      });
      const patch = {};
      if (crushId && map[crushId]) patch.crushAvatarUrl = map[crushId];
      if (meId && map[meId]) patch.meAvatarUrl = map[meId];
      if (Object.keys(patch).length) this.setData(patch);
    } catch (err) {
      // 换链失败就保持用 fileID 兜底渲染，不影响聊天
    }
  },

  async onLoad(options) {
    const conversationId = options.id;
    if (!conversationId) {
      this.setData({ loading: false, errorMsg: '缺少 conversation id' });
      return;
    }
    this.setData({ conversationId });
    await this.init();
  },

  async init() {
    try {
      const db = wx.cloud.database();
      const PAGE_SIZE = 50;
      const [convRes, stylesRes, msgsRes] = await Promise.all([
        db.collection('conversations').doc(this.data.conversationId).get(),
        db.collection('styles').where({ enabled: true }).orderBy('sortOrder', 'asc').get(),
        // 用 desc + limit(50) 拉「最近一页」，本地 reverse 回正序
        db.collection('messages')
          .where({ conversationId: this.data.conversationId, deletedAt: null })
          .orderBy('createdAt', 'desc')
          .limit(PAGE_SIZE)
          .get()
      ]);

      const conv = convRes.data;
      const styles = stylesRes.data;
      const styleMap = styles.reduce((m, s) => { m[s.id] = s; return m; }, {});
      const rawMessages = (msgsRes.data || []).reverse();
      const messages = withTimeMarks(rawMessages, styleMap);

      wx.setNavigationBarTitle({ title: conv.crushNickname || 'crush' });

      let selectedStyleId = conv.defaultStyleId;
      if (!selectedStyleId || !styles.find(s => s.id === selectedStyleId)) {
        selectedStyleId = styles[0] ? styles[0].id : '';
      }
      const selStyle = styleMap[selectedStyleId];
      const selectedStyleDisplay = selStyle ? `${selStyle.emoji} ${selStyle.displayName}` : selectedStyleId;

      this.setData({
        loading: false,
        conversation: conv,
        styles,
        styleMap,
        selectedStyleId,
        selectedStyleDisplay,
        messages,
        // 拉满一页就认为还有更早的；不足一页直接判定到顶
        earliestCreatedAt: rawMessages[0] ? rawMessages[0].createdAt : null,
        hasMoreEarlier: rawMessages.length === PAGE_SIZE
      });

      this.scrollToBottom();
      this.resolveAvatars();
    } catch (err) {
      this.setData({ loading: false, errorMsg: (err && err.errMsg) || String(err) });
    }
  },

  // 用户在聊天页向上滑到顶时触发，拉前面一页更早的消息接上去
  async onScrollToUpper() {
    if (this.data.loadingEarlier || !this.data.hasMoreEarlier) return;
    if (!this.data.earliestCreatedAt) return;
    this.setData({ loadingEarlier: true });
    try {
      const db = wx.cloud.database();
      const _ = db.command;
      const PAGE_SIZE = 50;
      const res = await db.collection('messages')
        .where({
          conversationId: this.data.conversationId,
          deletedAt: null,
          createdAt: _.lt(this.data.earliestCreatedAt)
        })
        .orderBy('createdAt', 'desc')
        .limit(PAGE_SIZE)
        .get();
      const rawEarlier = (res.data || []).reverse();
      if (rawEarlier.length === 0) {
        this.setData({ hasMoreEarlier: false, loadingEarlier: false });
        return;
      }
      // 锁定原本第一条 id，让 scroll-into-view 在新内容接上后保持视觉位置不跳
      const oldFirstId = this.data.messages[0] && this.data.messages[0]._id;
      const combined = withTimeMarks([...rawEarlier, ...this.data.messages], this.data.styleMap);
      this.setData({
        messages: combined,
        earliestCreatedAt: rawEarlier[0].createdAt,
        hasMoreEarlier: rawEarlier.length === PAGE_SIZE,
        loadingEarlier: false,
        scrollToView: oldFirstId ? 'msg-' + oldFirstId : this.data.scrollToView
      });
    } catch (err) {
      this.setData({ loadingEarlier: false });
    }
  },

  scrollToBottom() {
    const last = this.data.messages[this.data.messages.length - 1];
    if (last) {
      this.setData({ scrollToView: 'msg-' + last._id });
    }
  },

  onInputChange(e) {
    this.setData({ inputText: e.detail.value });
  },

  async onSelectStyle(e) {
    const styleId = e.currentTarget.dataset.id;
    if (styleId === this.data.selectedStyleId) return;
    const selStyle = this.data.styleMap[styleId];
    const selectedStyleDisplay = selStyle ? `${selStyle.emoji} ${selStyle.displayName}` : styleId;
    this.setData({ selectedStyleId: styleId, selectedStyleDisplay });
    try {
      const db = wx.cloud.database();
      await db.collection('conversations').doc(this.data.conversationId).update({
        data: { defaultStyleId: styleId }
      });
    } catch (err) {
      // 忽略
    }
  },

  onTapCrushAvatar() {
    if (!this.data.conversationId) return;
    wx.navigateTo({ url: `/pages/crush-edit/index?id=${this.data.conversationId}` });
  },

  onTapMyAvatar() {
    wx.navigateTo({ url: '/pages/me/index' });
  },

  // ============ 主动模式 ============
  openInitiateModal() {
    if (!this.data.selectedStyleId) {
      wx.showToast({ title: '请先选个风格', icon: 'none' });
      return;
    }
    this.setData({
      initiateModalVisible: true,
      selectedScenario: 'icebreak',
      intentContext: ''
    });
  },

  closeInitiateModal() {
    this.setData({ initiateModalVisible: false });
  },

  onSelectScenario(e) {
    const key = e.currentTarget.dataset.key;
    this.setData({ selectedScenario: key });
  },

  onIntentContextInput(e) {
    this.setData({ intentContext: e.detail.value });
  },

  noop() {
    // 阻止弹窗内容区点击穿透到 mask
  },

  async onConfirmInitiate() {
    const scenario = this.data.selectedScenario;
    const context = (this.data.intentContext || '').trim();
    if (!scenario) {
      wx.showToast({ title: '请选一个场景', icon: 'none' });
      return;
    }
    if (scenario === 'other' && !context) {
      wx.showToast({ title: '"其他"场景请描述意图', icon: 'none' });
      return;
    }
    this.closeInitiateModal();
    await this.callGenerate({
      type: 'initiate',
      intent: { scenario, context },
      styleId: this.data.selectedStyleId,
      count: 1
    });
  },

  // ============ 被动回复（原逻辑） ============
  async onTapSend() {
    if (this.data.sending) return;
    const text = (this.data.inputText || '').trim();
    if (!text) {
      wx.showToast({ title: '请输入 crush 发的话', icon: 'none' });
      return;
    }
    if (!this.data.selectedStyleId) {
      wx.showToast({ title: '请选择回复风格', icon: 'none' });
      return;
    }
    await this.callGenerate({
      type: 'reply',
      crushMessage: text,
      styleId: this.data.selectedStyleId,
      count: 1
    });
    this.setData({ inputText: '' });
  },

  async onTapMore(e) {
    if (this.data.sending) return;
    const messageId = e.currentTarget.dataset.id;
    const msg = this.data.messages.find(m => m._id === messageId);
    if (!msg) return;
    const remaining = 3 - (msg.suggestions ? msg.suggestions.length : 0);
    if (remaining <= 0) return;
    await this.callGenerate({
      type: msg.type || 'reply',
      crushMessage: msg.crushMessage,
      intent: msg.intent,
      styleId: msg.styleId,
      count: remaining,
      appendToMessageId: messageId
    });
  },

  onRetry(e) {
    const id = e.currentTarget.dataset.id;
    const msg = this.data.messages.find(m => m._id === id);
    if (!msg) return;
    const newMsgs = this.data.messages.filter(m => m._id !== id);
    this.setData({ messages: withTimeMarks(newMsgs, this.data.styleMap) });
    this.callGenerate({
      type: msg.type || 'reply',
      crushMessage: msg.crushMessage,
      intent: msg.intent,
      styleId: msg.styleId,
      count: 1
    });
  },

  async callGenerate(opts) {
    const { type, crushMessage = '', intent = null, styleId, count, appendToMessageId } = opts;
    const appendToLast = !!appendToMessageId;

    this.setData({ sending: true });

    let tempId;
    if (!appendToLast) {
      tempId = 'temp-' + Date.now();
      const tempMsg = {
        _id: tempId,
        conversationId: this.data.conversationId,
        type,
        intent,
        crushMessage,
        styleId,
        suggestions: [],
        loading: true,
        createdAt: new Date()
      };
      const newMsgs = withTimeMarks([...this.data.messages, tempMsg], this.data.styleMap);
      this.setData({ messages: newMsgs, scrollToView: 'msg-' + tempId });
    } else {
      const idx = this.data.messages.findIndex(m => m._id === appendToMessageId);
      if (idx >= 0) {
        const updated = [...this.data.messages];
        updated[idx] = { ...updated[idx], loadingMore: true };
        this.setData({ messages: updated });
      }
    }

    try {
      const res = await wx.cloud.callFunction({
        name: 'generateReply',
        data: {
          conversationId: this.data.conversationId,
          crushMessage,
          styleId,
          count,
          type,
          intent,
          // 传给云函数：有值表示「追加到这条消息」，云函数就 update 而不是新建记录
          appendToMessageId: appendToMessageId || null
        }
      });

      const result = res.result || {};
      if (!result.success) {
        const errMsg = result.hint || result.error || '生成失败';
        if (!appendToLast && tempId) {
          const newMsgs = this.data.messages.map(m =>
            m._id === tempId ? { ...m, loading: false, error: errMsg } : m
          );
          this.setData({ messages: newMsgs });
        } else if (appendToLast) {
          const idx = this.data.messages.findIndex(m => m._id === appendToMessageId);
          if (idx >= 0) {
            const updated = [...this.data.messages];
            updated[idx] = { ...updated[idx], loadingMore: false, moreError: errMsg };
            this.setData({ messages: updated });
          }
        }
        return;
      }

      const newSuggestions = result.suggestions || [];

      if (!appendToLast) {
        const realMsg = decorateMessage({
          _id: result.messageId,
          conversationId: this.data.conversationId,
          type: result.type || type,
          intent: result.intent || intent,
          crushMessage,
          styleId,
          suggestions: newSuggestions,
          createdAt: result.createdAt || new Date(),
          loading: false
        }, this.data.styleMap);
        const newMsgs = this.data.messages.map(m => m._id === tempId ? realMsg : m);
        this.setData({ messages: withTimeMarks(newMsgs, this.data.styleMap), scrollToView: 'msg-' + realMsg._id });
        // 新增了一轮真实对话 → 静默推进长期记忆（攒够 20 轮云端才真总结，不阻塞 UI）
        this.maybeSummarizeMemory();
      } else {
        const idx = this.data.messages.findIndex(m => m._id === appendToMessageId);
        if (idx >= 0) {
          const merged = [...(this.data.messages[idx].suggestions || []), ...newSuggestions];
          const updated = [...this.data.messages];
          updated[idx] = { ...updated[idx], suggestions: merged, loadingMore: false, moreError: '' };
          this.setData({ messages: updated });
        }
      }
    } catch (err) {
      const errMsg = (err && err.errMsg) || String(err);
      if (!appendToLast && tempId) {
        const newMsgs = this.data.messages.map(m =>
          m._id === tempId ? { ...m, loading: false, error: errMsg } : m
        );
        this.setData({ messages: newMsgs });
      } else if (appendToLast) {
        const idx = this.data.messages.findIndex(m => m._id === appendToMessageId);
        if (idx >= 0) {
          const updated = [...this.data.messages];
          updated[idx] = { ...updated[idx], loadingMore: false, moreError: errMsg };
          this.setData({ messages: updated });
        }
      }
    } finally {
      this.setData({ sending: false });
    }
  },

  // 静默触发长期记忆维护（Phase 2）。
  // 不 await、不提示、失败不打扰用户；云函数内部用 lastSummarizedCount 做幂等节流，
  // 没攒够 20 轮会直接 skip，所以这里每轮都可以放心调。
  maybeSummarizeMemory() {
    if (!this.data.conversationId) return;
    try {
      wx.cloud.callFunction({
        name: 'summarizeMemory',
        data: { conversationId: this.data.conversationId }
      }).catch(() => {});
    } catch (e) {
      // 记忆维护是后台增强，失败完全忽略
    }
  },

  onTapCopy(e) {
    const { text, msgid, index } = e.currentTarget.dataset;
    if (!text) return;
    wx.setClipboardData({
      data: text,
      success: () => {
        wx.showToast({ title: '已复制', icon: 'success' });
        // 复制 = 视为「我要发这条」，记录为选中，供下一轮上下文记忆使用
        this.recordSelection(msgid, index, text);
      }
    });
  },

  // 把用户选中的回复记录到这条消息（本地 + 数据库）。
  // 记忆系统据此续上下文；用户没点复制的轮次，云函数会兜底用第一条建议。
  recordSelection(msgid, index, text) {
    if (!msgid || String(msgid).startsWith('temp-')) return;
    const sIdx = Number(index);
    const newMsgs = this.data.messages.map(m =>
      m._id === msgid ? { ...m, selectedIndex: sIdx, selectedText: text } : m
    );
    this.setData({ messages: newMsgs });
    try {
      const db = wx.cloud.database();
      db.collection('messages').doc(msgid).update({
        data: { selectedIndex: sIdx, selectedText: text }
      });
    } catch (err) {
      // 选中记录失败不影响复制，仅记日志
      console.warn('[chat] record selection failed:', err && err.errMsg);
    }
  },

  onLongPressMessage(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    // 临时消息（temp-，比如生成失败/卡住留下的卡片）也允许删，否则会残留一个删不掉的空框
    wx.showActionSheet({
      itemList: ['删除这一轮对话'],
      success: (res) => {
        if (res.tapIndex === 0) {
          this.confirmDeleteMessage(id);
        }
      }
    });
  },

  confirmDeleteMessage(id) {
    wx.showModal({
      title: '删除这一轮对话？',
      content: '将一起删掉 crush 的消息和 AI 建议',
      confirmText: '删除',
      confirmColor: '#fa5151',
      success: async (r) => {
        if (r.confirm) {
          await this.softDeleteMessage(id);
        }
      }
    });
  },

  async softDeleteMessage(id) {
    const isTemp = String(id).startsWith('temp-');
    try {
      // 临时消息不在数据库里，只需从本地列表移除；真实消息才软删
      if (!isTemp) {
        const db = wx.cloud.database();
        await db.collection('messages').doc(id).update({
          data: { deletedAt: new Date() }
        });
      }
      const remaining = this.data.messages.filter(m => m._id !== id);
      this.setData({ messages: withTimeMarks(remaining, this.data.styleMap) });
      wx.showToast({ title: '已删除', icon: 'success' });
      // 同步首页列表的"最新消息"预览
      await this.syncConversationPreview(remaining);
    } catch (err) {
      wx.showModal({
        title: '删除失败',
        content: (err && err.errMsg) || String(err),
        showCancel: false
      });
    }
  },

  // 根据当前剩余消息，回写 conversations 表的 lastMessagePreview / lastMessageAt
  // 这样返回首页时列表能显示正确的最新消息（删空时回到"还没有聊天"状态）
  async syncConversationPreview(messages) {
    const real = (messages || []).filter(m => !String(m._id).startsWith('temp-'));
    const last = real[real.length - 1];
    const data = last
      ? { lastMessagePreview: computePreview(last), lastMessageAt: last.createdAt || null }
      : { lastMessagePreview: '', lastMessageAt: null };
    try {
      const db = wx.cloud.database();
      await db.collection('conversations').doc(this.data.conversationId).update({ data });
    } catch (err) {
      // 预览同步失败不影响删除本身，仅记日志
      console.warn('[chat] sync conv preview failed:', err && err.errMsg);
    }
  }
});
