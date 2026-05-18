const GENDER_LIST = ['男', '女'];

const MBTI_LIST = [
  'INTJ', 'INTP', 'ENTJ', 'ENTP',
  'INFJ', 'INFP', 'ENFJ', 'ENFP',
  'ISTJ', 'ISFJ', 'ESTJ', 'ESFJ',
  'ISTP', 'ISFP', 'ESTP', 'ESFP'
];

const ZODIAC_LIST = [
  '白羊座', '金牛座', '双子座', '巨蟹座',
  '狮子座', '处女座', '天秤座', '天蝎座',
  '射手座', '摩羯座', '水瓶座', '双鱼座'
];

Page({
  data: {
    editingId: '',
    nickname: 'crush',
    avatar: '',
    gender: '',
    mbti: '',
    zodiac: '',
    genderIndex: 0,
    mbtiIndex: 0,
    zodiacIndex: 0,
    genderList: GENDER_LIST,
    mbtiList: MBTI_LIST,
    zodiacList: ZODIAC_LIST,
    saving: false,
    uploading: false,
    loadingDetail: false
  },

  async onLoad(options) {
    const id = options.id || '';
    if (id) {
      this.setData({ editingId: id });
      wx.setNavigationBarTitle({ title: '编辑 Crush' });
      await this.loadConversation(id);
    } else {
      wx.setNavigationBarTitle({ title: '添加 Crush' });
    }
  },

  async loadConversation(id) {
    this.setData({ loadingDetail: true });
    wx.showLoading({ title: '加载中...', mask: true });
    try {
      const db = wx.cloud.database();
      const res = await db.collection('conversations').doc(id).get();
      const c = res.data;
      const genderIdx = GENDER_LIST.indexOf(c.crushGender);
      const mbtiIdx = MBTI_LIST.indexOf(c.crushMbti);
      const zodiacIdx = ZODIAC_LIST.indexOf(c.crushZodiac);
      this.setData({
        nickname: c.crushNickname || 'crush',
        avatar: c.crushAvatar || '',
        gender: c.crushGender || '',
        mbti: c.crushMbti || '',
        zodiac: c.crushZodiac || '',
        genderIndex: genderIdx >= 0 ? genderIdx : 0,
        mbtiIndex: mbtiIdx >= 0 ? mbtiIdx : 0,
        zodiacIndex: zodiacIdx >= 0 ? zodiacIdx : 0,
        loadingDetail: false
      });
      wx.hideLoading();
    } catch (err) {
      wx.hideLoading();
      this.setData({ loadingDetail: false });
      wx.showModal({
        title: '加载失败',
        content: (err && err.errMsg) || String(err),
        showCancel: false,
        success: () => wx.navigateBack()
      });
    }
  },

  onNicknameInput(e) {
    this.setData({ nickname: e.detail.value });
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
      await this.uploadAvatar(tempFilePath);
    } catch (err) {
      if (err && err.errMsg && err.errMsg.includes('cancel')) return;
      wx.showModal({
        title: '操作失败',
        content: (err && err.errMsg) || String(err),
        showCancel: false
      });
    }
  },

  async uploadAvatar(tempFilePath) {
    this.setData({ uploading: true });
    wx.showLoading({ title: '上传中...', mask: true });
    try {
      const ext = (tempFilePath.split('.').pop() || 'jpg').toLowerCase();
      const tag = this.data.editingId || 'new';
      const cloudPath = `avatars/crush-${tag}-${Date.now()}.${ext}`;
      const upload = await wx.cloud.uploadFile({
        cloudPath,
        filePath: tempFilePath
      });
      this.setData({ avatar: upload.fileID, uploading: false });
      wx.hideLoading();
      wx.showToast({ title: '已上传，点保存生效', icon: 'none' });
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

  onGenderChange(e) {
    const idx = Number(e.detail.value);
    this.setData({ gender: GENDER_LIST[idx], genderIndex: idx });
  },

  onMbtiChange(e) {
    const idx = Number(e.detail.value);
    this.setData({ mbti: MBTI_LIST[idx], mbtiIndex: idx });
  },

  onZodiacChange(e) {
    const idx = Number(e.detail.value);
    this.setData({ zodiac: ZODIAC_LIST[idx], zodiacIndex: idx });
  },

  async onTapSave() {
    if (this.data.saving) return;

    const nickname = (this.data.nickname || '').trim() || 'crush';
    const gender = this.data.gender;

    if (!gender) {
      wx.showToast({ title: '请选择性别', icon: 'none' });
      return;
    }

    this.setData({ saving: true });
    wx.showLoading({ title: '保存中...', mask: true });

    try {
      const db = wx.cloud.database();
      const isEditing = !!this.data.editingId;

      if (isEditing) {
        await db.collection('conversations').doc(this.data.editingId).update({
          data: {
            crushNickname: nickname,
            crushAvatar: this.data.avatar,
            crushGender: gender,
            crushMbti: this.data.mbti,
            crushZodiac: this.data.zodiac
          }
        });
      } else {
        const now = new Date();
        await db.collection('conversations').add({
          data: {
            crushNickname: nickname,
            crushAvatar: this.data.avatar,
            crushGender: gender,
            crushMbti: this.data.mbti,
            crushZodiac: this.data.zodiac,
            defaultStyleId: '',
            lastMessageAt: null,
            lastMessagePreview: '',
            createdAt: now,
            deletedAt: null
          }
        });
      }

      wx.hideLoading();
      wx.showToast({ title: isEditing ? '已保存' : '已添加', icon: 'success' });
      setTimeout(() => {
        wx.navigateBack();
      }, 600);
    } catch (err) {
      wx.hideLoading();
      this.setData({ saving: false });
      wx.showModal({
        title: '保存失败',
        content: (err && err.errMsg) || String(err),
        showCancel: false
      });
    }
  },

  onTapCancel() {
    wx.navigateBack();
  }
});
