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

function withTimeMarks(messages) {
  let lastT = 0;
  return messages.map((m, i) => {
    const t = m.createdAt ? new Date(m.createdAt).getTime() : Date.now();
    const showTime = i === 0 || (t - lastT) > FIVE_MIN;
    lastT = t;
    return { ...m, timeMark: showTime ? formatTimeMark(m.createdAt) : '' };
  });
}

Page({
  data: {
    conversationId: '',
    conversation: null,
    me: null,
    styles: [],
    selectedStyleId: '',
    messages: [],
    inputText: '',
    loading: true,
    sending: false,
    scrollToView: '',
    errorMsg: ''
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
      const messages = withTimeMarks(msgsRes.data);

      wx.setNavigationBarTitle({ title: conv.crushNickname || 'crush' });

      let selectedStyleId = conv.defaultStyleId;
      if (!selectedStyleId || !styles.find(s => s.id === selectedStyleId)) {
        selectedStyleId = styles[0] ? styles[0].id : '';
      }

      this.setData({
        loading: false,
        conversation: conv,
        styles,
        selectedStyleId,
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
    this.setData({ selectedStyleId: styleId });
    // 静默保存为该 crush 的默认风格，下次进来自动选中
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
    await this.callGenerate(text, this.data.selectedStyleId, 1, false);
    this.setData({ inputText: '' });
  },

  async onTapMore(e) {
    if (this.data.sending) return;
    const messageId = e.currentTarget.dataset.id;
    const msg = this.data.messages.find(m => m._id === messageId);
    if (!msg) return;
    const remaining = 3 - (msg.suggestions ? msg.suggestions.length : 0);
    if (remaining <= 0) return;
    await this.callGenerate(msg.crushMessage, msg.styleId, remaining, true, messageId);
  },

  onRetry(e) {
    const id = e.currentTarget.dataset.id;
    const msg = this.data.messages.find(m => m._id === id);
    if (!msg) return;
    // 移除失败记录，再重新生成
    const newMsgs = this.data.messages.filter(m => m._id !== id);
    this.setData({ messages: withTimeMarks(newMsgs) });
    this.callGenerate(msg.crushMessage, msg.styleId, 1, false);
  },

  async callGenerate(crushMessage, styleId, count, appendToLast, sourceMessageId) {
    this.setData({ sending: true });

    let tempId;
    if (!appendToLast) {
      tempId = 'temp-' + Date.now();
      const tempMsg = {
        _id: tempId,
        conversationId: this.data.conversationId,
        crushMessage,
        styleId,
        suggestions: [],
        loading: true,
        createdAt: new Date()
      };
      const newMsgs = withTimeMarks([...this.data.messages, tempMsg]);
      this.setData({ messages: newMsgs, scrollToView: 'msg-' + tempId });
    } else {
      const idx = this.data.messages.findIndex(m => m._id === sourceMessageId);
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
          count
        }
      });

      const result = res.result || {};
      if (!result.success) {
        const errMsg = result.hint || result.error || '生成失败';
        // 不再弹 modal，把错误标在卡片上
        if (!appendToLast && tempId) {
          const newMsgs = this.data.messages.map(m =>
            m._id === tempId ? { ...m, loading: false, error: errMsg } : m
          );
          this.setData({ messages: newMsgs });
        } else if (appendToLast) {
          const idx = this.data.messages.findIndex(m => m._id === sourceMessageId);
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
        const realMsg = {
          _id: result.messageId,
          conversationId: this.data.conversationId,
          crushMessage,
          styleId,
          suggestions: newSuggestions,
          createdAt: result.createdAt || new Date(),
          loading: false
        };
        const newMsgs = this.data.messages.map(m => m._id === tempId ? realMsg : m);
        this.setData({ messages: withTimeMarks(newMsgs), scrollToView: 'msg-' + realMsg._id });
      } else {
        const idx = this.data.messages.findIndex(m => m._id === sourceMessageId);
        if (idx >= 0) {
          const merged = [...(this.data.messages[idx].suggestions || []), ...newSuggestions];
          const updated = [...this.data.messages];
          updated[idx] = {
            ...updated[idx],
            suggestions: merged,
            loadingMore: false,
            moreError: ''
          };
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
        const idx = this.data.messages.findIndex(m => m._id === sourceMessageId);
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
      this.setData({ messages: withTimeMarks(newMsgs) });
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
