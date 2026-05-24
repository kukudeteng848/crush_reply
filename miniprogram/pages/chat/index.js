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
  const styleDisplay = s ? `${s.emoji} ${s.displayName}` : (m.styleId || '');
  return { ...m, typeLabel, styleDisplay };
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
      const [convRes, stylesRes, msgsRes] = await Promise.all([
        db.collection('conversations').doc(this.data.conversationId).get(),
        db.collection('styles').where({ enabled: true }).orderBy('sortOrder', 'asc').get(),
        db.collection('messages')
          .where({ conversationId: this.data.conversationId, deletedAt: null })
          .orderBy('createdAt', 'asc')
          .limit(100)
          .get()
      ]);

      const conv = convRes.data;
      const styles = stylesRes.data;
      const styleMap = styles.reduce((m, s) => { m[s.id] = s; return m; }, {});
      const messages = withTimeMarks(msgsRes.data, styleMap);

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
        messages
      });

      this.scrollToBottom();
    } catch (err) {
      this.setData({ loading: false, errorMsg: (err && err.errMsg) || String(err) });
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
          intent
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

  onTapCopy(e) {
    const text = e.currentTarget.dataset.text;
    if (!text) return;
    wx.setClipboardData({
      data: text,
      success: () => {
        wx.showToast({ title: '已复制', icon: 'success' });
      }
    });
  },

  onLongPressMessage(e) {
    const id = e.currentTarget.dataset.id;
    if (!id || String(id).startsWith('temp-')) return;
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
    try {
      const db = wx.cloud.database();
      await db.collection('messages').doc(id).update({
        data: { deletedAt: new Date() }
      });
      const newMsgs = this.data.messages.filter(m => m._id !== id);
      this.setData({ messages: withTimeMarks(newMsgs, this.data.styleMap) });
      wx.showToast({ title: '已删除', icon: 'success' });
    } catch (err) {
      wx.showModal({
        title: '删除失败',
        content: (err && err.errMsg) || String(err),
        showCancel: false
      });
    }
  }
});
