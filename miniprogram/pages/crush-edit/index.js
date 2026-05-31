// Crush 档案编辑
// V2：从「昵称/性别/MBTI/星座」扩成完整画像，团购好评式标签输入。
// 只有性别必填，昵称留空默认 crush，其余全部选填。

const GENDER_LIST = ['男', '女'];
const AGE_LIST = ['00后', '95后', '90后', '85后', '80后', '其他'];

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

// 标签预设（用户可在每组末尾「+ 自定义」追加）
const HOBBIES_PRESETS = ['看剧', '电影', '游戏', '运动', '音乐', '摄影', '旅行', '美食', '读书', '手作', '宠物', '二次元'];
const PERSONALITY_PRESETS = ['开朗健谈', '安静内向', '幽默搞笑', '温柔体贴', '高冷', '毒舌不坏', '理性', '感性', '慢热'];
const CHATSTYLE_PRESETS = ['秒回', '经常忙', '爱发表情包', '爱发语音', '爱分享日常', '很少主动', '话痨', '惜字如金'];

// 单选标签
const KNOWN_DURATION_LIST = ['刚加微信', '认识1-3个月', '认识半年以上', '老朋友了'];
const RELATION_STAGE_LIST = ['初识', '朋友', '暧昧中', '在追'];
const MET_IN_PERSON_LIST = ['还没见过', '见过1-2次', '经常见'];

// 数组 → 选中 map
function arrToSel(arr) {
  const sel = {};
  (Array.isArray(arr) ? arr : []).forEach(v => { if (v) sel[v] = true; });
  return sel;
}
// 选中 map → 数组
function selToArr(sel) {
  return Object.keys(sel || {}).filter(k => sel[k]);
}
// 把已存的自定义标签并进预设列表，保证能渲染出来
function mergePresets(presets, arr) {
  const merged = presets.slice();
  (Array.isArray(arr) ? arr : []).forEach(v => {
    if (v && merged.indexOf(v) === -1) merged.push(v);
  });
  return merged;
}

Page({
  data: {
    editingId: '',
    nickname: '',
    avatar: '',
    saving: false,
    uploading: false,
    loadingDetail: false,

    // 基本信息
    gender: '',
    age: '',
    mbti: '',
    mbtiIndex: 0,
    zodiac: '',
    zodiacIndex: 0,

    // 标签（多选）：值用 *Sel map 记录是否选中，*Presets 是渲染列表
    hobbies: [],
    hobbiesSel: {},
    hobbiesPresets: HOBBIES_PRESETS,
    personality: [],
    personalitySel: {},
    personalityPresets: PERSONALITY_PRESETS,
    chatStyle: [],
    chatStyleSel: {},
    chatStylePresets: CHATSTYLE_PRESETS,

    // 文本
    recentMentions: '',

    // 单选标签
    knownDuration: '',
    relationStage: '',
    metInPerson: '',

    // 预设清单
    genderList: GENDER_LIST,
    ageList: AGE_LIST,
    mbtiList: MBTI_LIST,
    zodiacList: ZODIAC_LIST,
    knownDurationList: KNOWN_DURATION_LIST,
    relationStageList: RELATION_STAGE_LIST,
    metInPersonList: MET_IN_PERSON_LIST
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
      const mbtiIdx = MBTI_LIST.indexOf(c.crushMbti);
      const zodiacIdx = ZODIAC_LIST.indexOf(c.crushZodiac);
      this.setData({
        nickname: c.crushNickname && c.crushNickname !== 'crush' ? c.crushNickname : '',
        avatar: c.crushAvatar || '',
        gender: c.crushGender || '',
        age: c.crushAge || '',
        mbti: c.crushMbti || '',
        zodiac: c.crushZodiac || '',
        mbtiIndex: mbtiIdx >= 0 ? mbtiIdx : 0,
        zodiacIndex: zodiacIdx >= 0 ? zodiacIdx : 0,
        hobbies: c.crushHobbies || [],
        hobbiesSel: arrToSel(c.crushHobbies),
        hobbiesPresets: mergePresets(HOBBIES_PRESETS, c.crushHobbies),
        personality: c.crushPersonality || [],
        personalitySel: arrToSel(c.crushPersonality),
        personalityPresets: mergePresets(PERSONALITY_PRESETS, c.crushPersonality),
        chatStyle: c.crushChatStyle || [],
        chatStyleSel: arrToSel(c.crushChatStyle),
        chatStylePresets: mergePresets(CHATSTYLE_PRESETS, c.crushChatStyle),
        recentMentions: c.crushRecentMentions || '',
        knownDuration: c.knownDuration || '',
        relationStage: c.relationStage || '',
        metInPerson: c.metInPerson || '',
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

  onRecentMentionsInput(e) {
    this.setData({ recentMentions: e.detail.value });
  },

  // ============ 标签交互 ============
  // 单选：再点一次可取消（性别在保存时校验，可不取消）
  onToggleSingle(e) {
    const { field, value } = e.currentTarget.dataset;
    const cur = this.data[field];
    this.setData({ [field]: cur === value ? '' : value });
  },

  // 多选：切换选中
  onToggleMulti(e) {
    const { field, value } = e.currentTarget.dataset;
    const key = `${field}Sel.${value}`;
    const cur = this.data[`${field}Sel`][value];
    this.setData({ [key]: !cur });
  },

  // 自定义标签：弹输入框，加入预设并选中
  onAddCustom(e) {
    const { field } = e.currentTarget.dataset;
    wx.showModal({
      title: '自定义标签',
      editable: true,
      placeholderText: '输入后点确定',
      success: (r) => {
        if (!r.confirm) return;
        const v = (r.content || '').trim();
        if (!v) return;
        const presetsKey = `${field}Presets`;
        const presets = this.data[presetsKey];
        if (presets.indexOf(v) === -1) {
          this.setData({ [presetsKey]: presets.concat([v]) });
        }
        this.setData({ [`${field}Sel.${v}`]: true });
      }
    });
  },

  // ============ 选择器（MBTI / 星座，选项多用 picker）============
  onMbtiChange(e) {
    const idx = Number(e.detail.value);
    this.setData({ mbti: MBTI_LIST[idx], mbtiIndex: idx });
  },

  onZodiacChange(e) {
    const idx = Number(e.detail.value);
    this.setData({ zodiac: ZODIAC_LIST[idx], zodiacIndex: idx });
  },

  // ============ 头像 ============
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

  // ============ 保存 ============
  async onTapSave() {
    if (this.data.saving) return;

    const nickname = (this.data.nickname || '').trim() || 'crush';
    const gender = this.data.gender;

    if (!gender) {
      wx.showToast({ title: '请选择性别', icon: 'none' });
      return;
    }

    const data = {
      crushNickname: nickname,
      crushAvatar: this.data.avatar,
      crushGender: gender,
      crushAge: this.data.age,
      crushMbti: this.data.mbti,
      crushZodiac: this.data.zodiac,
      crushHobbies: selToArr(this.data.hobbiesSel),
      crushPersonality: selToArr(this.data.personalitySel),
      crushChatStyle: selToArr(this.data.chatStyleSel),
      crushRecentMentions: (this.data.recentMentions || '').trim(),
      knownDuration: this.data.knownDuration,
      relationStage: this.data.relationStage,
      metInPerson: this.data.metInPerson
    };

    this.setData({ saving: true });
    wx.showLoading({ title: '保存中...', mask: true });

    try {
      const db = wx.cloud.database();
      const isEditing = !!this.data.editingId;

      if (isEditing) {
        await db.collection('conversations').doc(this.data.editingId).update({ data });
      } else {
        const now = new Date();
        await db.collection('conversations').add({
          data: {
            ...data,
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
