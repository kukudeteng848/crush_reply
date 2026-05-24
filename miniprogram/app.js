const PRIVACY_KEY = 'privacy_agreed_v1';

App({
  globalData: {
    cloudReady: false,
    cloudEnv: 'cloud1-d3gly6cak286c2a5a',
    user: null,
    loginError: null,
    loginPromise: null,
    privacyAgreed: false
  },

  // 兜底：微信 3.x 运行时有时会把内部 reject 上报成控制台 Error，吞掉即可
  onUnhandledRejection({ reason }) {
    console.warn('[unhandledRejection]', reason && (reason.errMsg || reason.message || reason));
  },

  onError(err) {
    console.warn('[app onError]', err);
  },

  onLaunch() {
    if (!wx.cloud) {
      console.error('wx.cloud 不可用，请把"详情→本地设置→调试基础库"升到 2.2.3 以上');
      return;
    }
    try {
      wx.cloud.init({
        env: this.globalData.cloudEnv,
        traceUser: true
      });
      this.globalData.cloudReady = true;
    } catch (err) {
      console.error('[cloud] init failed:', err);
      this.globalData.loginError = '云开发初始化失败';
    }
    // 登录不依赖隐私弹窗（隐私弹窗在首页 onShow 里弹），直接启动
    this.globalData.loginPromise = this.login();
  },

  // 供首页调用：确认用户已同意隐私协议
  // 必须在页面 onShow 里调用，不能在 onLaunch 调，否则页面栈未建立会 timeout
  ensurePrivacyAgreed() {
    const saved = wx.getStorageSync(PRIVACY_KEY);
    if (saved && saved.agreed) {
      this.globalData.privacyAgreed = true;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let showing = false;
      const showPrivacyModal = async () => {
        if (showing) return;
        showing = true;
        try {
          const res = await wx.showModal({
            title: '用户协议与隐私政策',
            content: '欢迎使用 crush 说。\n\n开始前请阅读并同意《用户协议》和《隐私政策》：\n\n• 我们仅收集必要信息（微信 ID、你输入的内容、上传的头像）用于提供服务\n• 你输入的内容会发送给 AI（DeepSeek）处理\n• 你可随时删除聊天记录\n\n完整内容可在"我的资料 → 隐私政策/用户协议"查看。',
            confirmText: '同意',
            cancelText: '不同意'
          });
          showing = false;
          if (res.confirm) {
            wx.setStorageSync(PRIVACY_KEY, { agreed: true, time: Date.now() });
            this.globalData.privacyAgreed = true;
            resolve();
          } else if (wx.exitMiniProgram) {
            wx.exitMiniProgram({ fail: () => setTimeout(showPrivacyModal, 800) });
          } else {
            setTimeout(showPrivacyModal, 800);
          }
        } catch (err) {
          showing = false;
          console.error('[privacy] showModal failed:', err);
          setTimeout(showPrivacyModal, 800);
        }
      };
      setTimeout(showPrivacyModal, 100);
    });
  },

  async login() {
    try {
      const res = await wx.cloud.callFunction({ name: 'login' });
      if (res.result && res.result.success) {
        this.globalData.user = res.result.user;
      } else {
        this.globalData.loginError = '登录失败';
        console.error('[login] failed:', res);
      }
    } catch (err) {
      this.globalData.loginError = (err && err.errMsg) || String(err);
      console.error('[login] callFunction error:', err);
    }
  }
});
