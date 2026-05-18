// 一键初始化数据库：创建 4 张集合 + 灌入初始风格
// 在云开发后台手动触发一次即可，重复运行也安全（已存在的集合/数据会跳过）

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const COLLECTIONS = ['users', 'conversations', 'messages', 'styles'];

const INITIAL_STYLES = [
  {
    id: 'humor',
    displayName: '幽默',
    emoji: '😄',
    description: '轻松搞笑，化解尴尬',
    promptInstruction: '用轻松幽默的语气回复，可以适度玩梗、自嘲，让对方会心一笑。避免油腻和过度浮夸。',
    enabled: true,
    sortOrder: 1
  },
  {
    id: 'warm',
    displayName: '暖心',
    emoji: '🤗',
    description: '真诚温暖，让对方安心',
    promptInstruction: '用真诚温暖的语气，体现关心和共情，让对方感到被理解、被在意。不要说教。',
    enabled: true,
    sortOrder: 2
  },
  {
    id: 'cool',
    displayName: '高冷',
    emoji: '😎',
    description: '留白克制，引发好奇',
    promptInstruction: '保持适度的疏离感，回复简短克制，但留有想象空间，引发对方好奇心。不要冷漠到不礼貌。',
    enabled: true,
    sortOrder: 3
  },
  {
    id: 'flirt',
    displayName: '撩拨',
    emoji: '😏',
    description: '暧昧拉扯，制造心动',
    promptInstruction: '带一点暧昧和撩人意味，制造心动感和情绪张力。要俏皮自信，但保持分寸不要油腻或越界。',
    enabled: true,
    sortOrder: 4
  },
  {
    id: 'sincere',
    displayName: '正经',
    emoji: '🙂',
    description: '认真平实，传递真心',
    promptInstruction: '认真平实地回应对方的话题，不刻意逗趣或撩拨，传递真诚的对话欲望。',
    enabled: true,
    sortOrder: 5
  }
];

exports.main = async () => {
  const report = {
    collections: {},
    styles: { inserted: 0, skipped: 0 }
  };

  // 1. 创建 4 张集合（已存在则跳过）
  for (const name of COLLECTIONS) {
    try {
      await db.createCollection(name);
      report.collections[name] = 'created';
    } catch (err) {
      // 错误码 -502002 表示集合已存在
      if (err.errCode === -502002) {
        report.collections[name] = 'already_exists';
      } else {
        report.collections[name] = `error: ${err.errMsg || err.message}`;
      }
    }
  }

  // 2. 灌入初始风格（按 id 判断是否已存在，避免重复）
  const stylesCol = db.collection('styles');
  const now = new Date();
  for (const style of INITIAL_STYLES) {
    const existing = await stylesCol.where({ id: style.id }).count();
    if (existing.total > 0) {
      report.styles.skipped += 1;
      continue;
    }
    await stylesCol.add({
      data: {
        ...style,
        createdAt: now,
        updatedAt: now
      }
    });
    report.styles.inserted += 1;
  }

  return {
    success: true,
    report,
    message: `初始化完成。集合: ${JSON.stringify(report.collections)}; 风格新增 ${report.styles.inserted} 条，跳过 ${report.styles.skipped} 条。`
  };
};
