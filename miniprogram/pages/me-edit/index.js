// 「我的恋爱档案」编辑（AI 用来模仿我的口吻、找共同点）
// 只有性别必填，其余全部选填。昵称不在这里（昵称仅 UI 用，不传给 AI）。

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

const HOBBIES_PRESETS = ['看剧', '电影', '游戏', '运动', '音乐', '摄影', '旅行', '美食', '读书', '手作', '宠物', '二次元'];
const CHATHABITS_PRESETS = ['秒回', '慢热', '爱发表情包', '爱发语音', '话多', '话少', '喜欢深聊', '爱开玩笑'];

function arrToSel(arr) {
  const sel = {};
  (Array.isArray(arr) ? arr : []).forEach(v => { if (v) sel[v] = true; });
  return sel;
}
function selToArr(sel) {
  return Object.keys(sel || {}).filter(k => sel[k]);
}
function mergePresets(presets, arr) {
  const merged = presets.slice();
  (Array.isArray(arr) ? arr : []).forEach(v => {
    if (v && merged.indexOf(v) === -1) merged.push(v);
  });
  return merged;
}

Page({
  data: {
    userId: '',
    saving: false,

    gender: '',
    age: '',
    mbti: '',
    mbtiIndex: 0,
    zodiac: '',
    zodiacIndex: 0,

    hobbies: [],
    hobbiesSel: {},
    hobbiesPresets: HOBBIES_PRESETS,
    chatHabits: [],
    chatHabitsSel: {},
    chatHabitsPresets: CHATHABITS_PRESETS,

    recentInto: '',
    occupation: '',
    city: '',

    genderList: GENDER_LIST,
    ageList: AGE_LIST,
    mbtiList: MBTI_LIST,
    zodiacList: ZODIAC_LIST
  },

  onLoad() {
    wx.setNavigationBarTitle({ title: '我的恋爱档案' });
    const app = getApp();
    const u = (app && app.globalData && app.globalData.user) || null;
    if (!u || !u._id) {
      wx.showModal({
        title: '提示',
        content: '还没登录好，请退出重进',
        showCancel: false,
        success: () => wx.navigateBack()
      });
      return;
    }
    const mbtiIdx = MBTI_LIST.indexOf(u.mbti);
    const zodiacIdx = ZODIAC_LIST.indexOf(u.zodiac);
    this.setData({
      userId: u._id,
      gender: u.gender || '',
      age: u.age || '',
      mbti: u.mbti || '',
      zodiac: u.zodiac || '',
      mbtiIndex: mbtiIdx >= 0 ? mbtiIdx : 0,
      zodiacIndex: zodiacIdx >= 0 ? zodiacIdx : 0,
      hobbies: u.hobbies || [],
      hobbiesSel: arrToSel(u.hobbies),
      hobbiesPresets: mergePresets(HOBBIES_PRESETS, u.hobbies),
      chatHabits: u.chatHabits || [],
      chatHabitsSel: arrToSel(u.chatHabits),
      chatHabitsPresets: mergePresets(CHATHABITS_PRESETS, u.chatHabits),
      recentInto: u.recentInto || '',
      occupation: u.occupation || '',
      city: u.city || ''
    });
  },

  onRecentIntoInput(e) { this.setData({ recentInto: e.detail.value }); },
  onOccupationInput(e) { this.setData({ occupation: e.detail.value }); },
  onCityInput(e) { this.setData({ city: e.detail.value }); },

  onToggleSingle(e) {
    const { field, value } = e.currentTarget.dataset;
    const cur = this.data[field];
    this.setData({ [field]: cur === value ? '' : value });
  },

  onToggleMulti(e) {
    const { field, value } = e.currentTarget.dataset;
    const cur = this.data[`${field}Sel`][value];
    this.setData({ [`${field}Sel.${value}`]: !cur });
  },

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
    if (!this.data.gender) {
      wx.showToast({ title: '请选择性别', icon: 'none' });
      return;
    }

    const data = {
      gender: this.data.gender,
      age: this.data.age,
      mbti: this.data.mbti,
      zodiac: this.data.zodiac,
      hobbies: selToArr(this.data.hobbiesSel),
      chatHabits: selToArr(this.data.chatHabitsSel),
      recentInto: (this.data.recentInto || '').trim(),
      occupation: (this.data.occupation || '').trim(),
      city: (this.data.city || '').trim(),
      updatedAt: new Date()
    };

    this.setData({ saving: true });
    wx.showLoading({ title: '保存中...', mask: true });
    try {
      const db = wx.cloud.database();
      await db.collection('users').doc(this.data.userId).update({ data });

      // 同步内存里的 user，避免返回后还是旧值
      const app = getApp();
      if (app && app.globalData && app.globalData.user) {
        app.globalData.user = { ...app.globalData.user, ...data };
      }

      wx.hideLoading();
      wx.showToast({ title: '已保存', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 600);
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
