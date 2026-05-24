Page({
  data: {
    user: null,
    uploading: false
  },

  onShow() {
    const app = getApp();
    if (app && app.globalData && app.globalData.user) {
      this.setData({ user: app.globalData.user });
    }
  },

  async onTapAvatar() {
    if (this.data.uploading) return;
    try {
      const chooseRes = await wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sourceType: ['album', 'camera'],
        sizeType: ['compressed']
      });
      const tempFilePath = chooseRes.tempFiles[0].tempFilePath;
      await this.uploadAndSaveAvatar(tempFilePath);
    } catch (err) {
      if (err && err.errMsg && err.errMsg.includes('cancel')) return;
      wx.showModal({
        title: '操作失败',
        content: (err && err.errMsg) || String(err),
        showCancel: false
      });
    }
  },

  async uploadAndSaveAvatar(tempFilePath) {
    this.setData({ uploading: true });
    wx.showLoading({ title: '上传中...', mask: true });
    try {
      const ext = (tempFilePath.split('.').pop() || 'jpg').toLowerCase();
      const cloudPath = `avatars/me-${this.data.user._id}-${Date.now()}.${ext}`;

      const upload = await wx.cloud.uploadFile({
        cloudPath,
        filePath: tempFilePath
      });
      const fileID = upload.fileID;

      const db = wx.cloud.database();
      await db.collection('users').doc(this.data.user._id).update({
        data: { avatar: fileID, updatedAt: new Date() }
      });

      const app = getApp();
      if (app && app.globalData && app.globalData.user) {
        app.globalData.user.avatar = fileID;
      }
      this.setData({ 'user.avatar': fileID, uploading: false });
      wx.hideLoading();
      wx.showToast({ title: '已更新', icon: 'success' });
    } catch (err) {
      wx.hideLoading();
      this.setData({ uploading: false });
      wx.showModal({
        title: '上传失败',
        content: (err && err.errMsg) || String(err),
        showCancel: false
      });
    }
  },

  onTapNickname() {
    const current = (this.data.user && this.data.user.nickname) || '我';
    wx.showModal({
      title: '修改昵称',
      editable: true,
      placeholderText: '请输入昵称',
      content: current,
      success: async (r) => {
        if (!r.confirm) return;
        const newNick = (r.content || '').trim();
        if (!newNick) {
          wx.showToast({ title: '昵称不能为空', icon: 'none' });
          return;
        }
        if (newNick === current) return;
        await this.updateNickname(newNick);
      }
    });
  },

  onTapPrivacy() {
    wx.navigateTo({ url: '/pages/privacy/index' });
  },

  onTapTerms() {
    wx.navigateTo({ url: '/pages/terms/index' });
  },

  async updateNickname(nickname) {
    wx.showLoading({ title: '保存中...', mask: true });
    try {
      const db = wx.cloud.database();
      await db.collection('users').doc(this.data.user._id).update({
        data: { nickname, updatedAt: new Date() }
      });
      const app = getApp();
      if (app && app.globalData && app.globalData.user) {
        app.globalData.user.nickname = nickname;
      }
      this.setData({ 'user.nickname': nickname });
      wx.hideLoading();
      wx.showToast({ title: '已更新', icon: 'success' });
    } catch (err) {
      wx.hideLoading();
      wx.showModal({
        title: '保存失败',
        content: (err && err.errMsg) || String(err),
        showCancel: false
      });
    }
  }
});
