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
const RELATION_STAGE_LIST = ['初识', '朋友', '暧昧中', '在追'];
const MET_IN_PERSON_LIST = ['还没见过', '见过1-2次', '经常见'];

// 由「认识日期」算出人话描述，给编辑页展示用
function describeKnownSince(since) {
  if (!since) return '';
  const d = new Date(since);
  if (isNaN(d.getTime())) return '';
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days < 0) return '';
  if (days <= 7) return `刚认识 ${days} 天`;
  if (days < 30) return `认识 ${Math.floor(days / 7)} 周`;
  if (days < 365) return `认识约 ${Math.floor(days / 30)} 个月`;
  const years = Math.floor(days / 365);
  const months = Math.floor((days % 365) / 30);
  return months > 0 ? `认识约 ${years} 年 ${months} 个月` : `认识约 ${years} 年`;
}

// 今天的 YYYY-MM-DD，给 date picker 的 end 上限用
function todayStr() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

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
// 两个数组求并集去重（保存时合并 AI 后台回填的标签，避免覆盖）
function unionArr(a, b) {
  const out = [];
  const seen = {};
  [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])].forEach(v => {
    const k = String(v || '').trim();
    if (k && !seen[k]) { seen[k] = true; out.push(k); }
  });
  return out;
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
    originalAvatar: '', // 进入时的旧头像，保存成功且换过新头像后会被静默删除，避免云存储孤儿
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

    // 认识日期（存 knownSince，展示算出来的「认识多久」）
    knownSince: '',
    knownSinceText: '',
    todayStr: todayStr(),

    // AI 从聊天中观察到的零散特征（crushInsights，可编辑）
    crushInsights: '',

    // 单选标签
    relationStage: '',
    metInPerson: '',

    // 预设清单
    genderList: GENDER_LIST,
    ageList: AGE_LIST,
    mbtiList: MBTI_LIST,
    zodiacList: ZODIAC_LIST,
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
        originalAvatar: c.crushAvatar || '',
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
        knownSince: c.knownSince || '',
        knownSinceText: describeKnownSince(c.knownSince),
        crushInsights: c.crushInsights || '',
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

  onInsightsInput(e) {
    this.setData({ crushInsights: e.detail.value });
  },

  // 选「认识日期」
  onKnownSinceChange(e) {
    const v = e.detail.value;
    this.setData({ knownSince: v, knownSinceText: describeKnownSince(v) });
  },

  onClearKnownSince() {
    this.setData({ knownSince: '', knownSinceText: '' });
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
      crushInsights: (this.data.crushInsights || '').trim(),
      knownSince: this.data.knownSince || '',
      relationStage: this.data.relationStage,
      metInPerson: this.data.metInPerson
    };

    this.setData({ saving: true });
    wx.showLoading({ title: '保存中...', mask: true });

    try {
      const db = wx.cloud.database();
      const isEditing = !!this.data.editingId;

      if (isEditing) {
        // 防丢：用户编辑这段时间里，AI 可能在后台往 crushHobbies/crushPersonality 回填了新标签。
        // 保存前重新拉一次库里的值，和当前选中取并集，避免把 AI 刚加的冲掉。
        try {
          const fresh = await db.collection('conversations').doc(this.data.editingId).get();
          const f = fresh.data || {};
          data.crushHobbies = unionArr(data.crushHobbies, f.crushHobbies);
          data.crushPersonality = unionArr(data.crushPersonality, f.crushPersonality);
        } catch (e) {
          // 拉取失败就按当前选中保存，不阻断
        }
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

      // 编辑模式下，如果保存的新头像和进来时的旧头像不一样，把旧头像静默删掉
      // 避免云存储孤儿文件累积；删失败不打扰用户
      const oldAvatar = this.data.originalAvatar;
      const newAvatar = data.crushAvatar;
      if (isEditing && oldAvatar && oldAvatar !== newAvatar && /^cloud:\/\//.test(oldAvatar)) {
        wx.cloud.deleteFile({ fileList: [oldAvatar] }).catch(() => {});
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
