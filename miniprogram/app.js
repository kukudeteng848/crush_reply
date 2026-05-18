App({
  globalData: {
    cloudReady: false,
    cloudEnv: 'cloud1-d3gly6cak286c2a5a',
    user: null,
    loginError: null,
    loginPromise: null
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
      return;
    }
    this.globalData.loginPromise = this.login();
  },

  async login() {
    try {
      const res = await wx.cloud.callFunction({ name: 'login' });
      if (res.result && res.result.success) {
        this.globalData.user = res.result.user;
        console.log('[login] ok, user =', this.globalData.user);
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
