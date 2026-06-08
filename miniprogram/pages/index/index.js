function formatRelativeTime(d) {
  if (!d) return '';
  const date = new Date(d);
  if (isNaN(date.getTime())) return '';
  const now = new Date();
  const diffSec = Math.floor((now - date) / 1000);
  if (diffSec < 60) return '刚刚';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}分钟前`;
  const isSameDay = date.toDateString() === now.toDateString();
  if (isSameDay) return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const yesterday = new Date(now.getTime() - 86400000);
  if (date.toDateString() === yesterday.toDateString()) return '昨天';
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

Page({
  data: {
    loading: true,
    errorMsg: '',
    user: null,
    conversations: []
  },

  async onShow() {
    await this.init();
  },

  // 仅首页开放转发：朋友扫进来是干净的首页，不暴露任何具体聊天/隐私页。
  // 不带 query，避免把当前用户的数据上下文带给别人。
  onShareAppMessage() {
    return {
      title: '不知道怎么回 ta？让 Crush 说帮你想',
      path: '/pages/index/index'
    };
  },

  async init() {
    const app = getApp();
    if (!app || !app.globalData.cloudReady) {
      this.setData({ loading: false, errorMsg: '云开发未就绪，请稍后重试' });
      return;
    }
    try {
      // 隐私协议弹窗必须在页面里触发（不能在 app.onLaunch）
      await app.ensurePrivacyAgreed();
      if (app.globalData.loginPromise) {
        await app.globalData.loginPromise;
      }
      if (app.globalData.loginError) {
        this.setData({ loading: false, errorMsg: app.globalData.loginError });
        return;
      }
      // 每次 onShow 重新同步 user（从"我的资料"返回后能看到最新昵称/头像）
      this.setData({ user: app.globalData.user });
      await this.loadConversations();
    } catch (err) {
      this.setData({ loading: false, errorMsg: (err && err.errMsg) || String(err) });
    }
  },

  onTapMe() {
    wx.navigateTo({ url: '/pages/me/index' });
  },

  async loadConversations() {
    this.setData({ loading: true, errorMsg: '' });
    try {
      const db = wx.cloud.database();
      const res = await db.collection('conversations')
        .where({ deletedAt: null })
        .orderBy('lastMessageAt', 'desc')
        .orderBy('createdAt', 'desc')
        .get();
      const list = res.data.map(c => ({
        ...c,
        lastMessageAtText: formatRelativeTime(c.lastMessageAt || c.createdAt)
      }));
      this.setData({ loading: false, conversations: list });
    } catch (err) {
      this.setData({ loading: false, errorMsg: (err && err.errMsg) || String(err) });
    }
  },

  onTapAdd() {
    wx.navigateTo({ url: '/pages/crush-edit/index' });
  },

  onTapConversation(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: `/pages/chat/index?id=${id}` });
  },

  onLongPressConversation(e) {
    const id = e.currentTarget.dataset.id;
    const conv = this.data.conversations.find(c => c._id === id);
    if (!conv) return;
    wx.showActionSheet({
      itemList: ['编辑资料', '删除'],
      success: (res) => {
        if (res.tapIndex === 0) {
          wx.navigateTo({ url: `/pages/crush-edit/index?id=${id}` });
        } else if (res.tapIndex === 1) {
          this.confirmDeleteConversation(conv);
        }
      }
    });
  },

  confirmDeleteConversation(conv) {
    wx.showModal({
      title: `删除「${conv.crushNickname}」？`,
      content: '聊天记录将不再显示，且无法恢复',
      confirmText: '删除',
      confirmColor: '#fa5151',
      success: async (r) => {
        if (r.confirm) {
          await this.softDeleteConversation(conv._id);
        }
      }
    });
  },

  async softDeleteConversation(id) {
    wx.showLoading({ title: '删除中...', mask: true });
    try {
      const db = wx.cloud.database();
      await db.collection('conversations').doc(id).update({
        data: { deletedAt: new Date() }
      });
      wx.hideLoading();
      wx.showToast({ title: '已删除', icon: 'success' });
      this.setData({
        conversations: this.data.conversations.filter(c => c._id !== id)
      });
    } catch (err) {
      wx.hideLoading();
      wx.showModal({
        title: '删除失败',
        content: (err && err.errMsg) || String(err),
        showCancel: false
      });
    }
  }
});
