# Crush Reply 💌

微信小程序：当 crush（暗恋对象）给你发消息不知道怎么回时，AI 帮你想几条恰到好处的回复。

## 主要功能

- 🔐 微信一键登录（静默无授权弹窗）
- 👥 多 crush 管理（性别 / MBTI / 星座 / 自定义头像）
- 💬 仿微信聊天 UI（气泡 / 时间分割 / 长按操作）
- 🎭 5 种回复风格：幽默 / 暖心 / 高冷 / 撩拨 / 正经
  - 风格可在云开发后台 GUI 直接增删改 prompt，**无需改代码**
- 🤖 每次默认生成 1 条建议，可一键追加至 3 条
- 🧠 每个 crush 默认风格自动记忆
- 📎 一键复制 / 长按删除 / 失败重试
- 🖼️ 头像上传到云存储

## 技术栈

- 微信小程序（原生 WXML/WXSS/JS）
- 微信云开发（云函数 + 云数据库 + 云存储，免备案）
- DeepSeek-V3 提供 AI 能力

## 项目结构

```
miniprogram/        小程序前端
  ├─ pages/
  │   ├─ index/        crush 列表首页
  │   ├─ chat/         聊天界面
  │   ├─ crush-edit/   添加/编辑 crush
  │   └─ me/           我的资料
  ├─ app.js / app.json / app.wxss
cloudfunctions/    云函数（云端运行）
  ├─ init/             一键建表 + 灌入初始风格
  ├─ login/            静默登录
  └─ generateReply/    调 DeepSeek 生成回复
config/             本地配置（secrets.json 已 gitignore）
docs/               PM 视角说明书 + 各阶段部署指南
```

## 本地开发

1. 用「微信开发者工具」导入本项目
2. 复制 `config/secrets.example.json` 为 `config/secrets.json`，填入你的 DeepSeek API Key
3. 开通云开发，把 `miniprogram/app.js` 里的 `cloudEnv` 改成你的环境 ID
4. 在开发者工具里上传 `cloudfunctions/` 下的三个云函数
5. 在云开发后台「云函数 → generateReply → 环境变量」设 `DEEPSEEK_API_KEY`
6. 在云开发后台运行一次 `init` 云函数，建好 4 张表和 5 个风格
7. 数据库权限设置：
   - `users` / `conversations` / `messages` → 仅创建者可读写
   - `styles` → 所有用户可读，仅创建者可读写

详细步骤见 `docs/项目说明书.md`。

## License

MIT
