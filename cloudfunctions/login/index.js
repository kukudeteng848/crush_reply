// 静默登录：拿 openid，没有用户就创建一条
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async () => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) {
    return { success: false, error: 'no_openid' };
  }

  const usersCol = db.collection('users');
  const existing = await usersCol.where({ _openid: OPENID }).limit(1).get();

  if (existing.data.length > 0) {
    return { success: true, user: existing.data[0], isNew: false };
  }

  const now = new Date();
  const newUser = {
    _openid: OPENID,
    nickname: '我',
    avatar: '',
    createdAt: now,
    updatedAt: now
  };
  const added = await usersCol.add({ data: newUser });

  return {
    success: true,
    user: { _id: added._id, ...newUser },
    isNew: true
  };
};
