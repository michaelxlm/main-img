'use strict';
/* ==========================================================================
   site-shell-registry.js · 十站展示层唯一注册表（Site Shell Spec v1.0）
   --------------------------------------------------------------------------
   单一事实源。改站点名 / 域名 / 定位 / 品牌色 / 广告配额只改本文件，然后：
     node packages/static-build-kit/sync-shell.js
     node packages/static-build-kit/sync-build.js
     node packages/check-all.js && node packages/check-site-shell.js
   本文件同时被构建期注入器（apply-site-shell.js）与门禁（check-site-shell.js）引用。

   注意：SISTER_SITES 的 label 必须与 main-api/shared/partials/index.js 的
   SISTER_SITES 逐条一致（check-site-shell.js 会比对），否则 sync-more-sites
   漂移门禁会红。品牌展示名用 name 字段（canonical），两者允许不同。
   ========================================================================== */

const SHELL_VERSION = '1.0.0';

/** 顺序与 main-api/shared/partials/index.js 的 SISTER_SITES 保持一致 */
const SITES = [
  {
    key: 'aiWeb', domain: 'xuliming.com', name: '明先生日常', label: '明先生日常',
    tagline: 'AI 建站教程与日常实操笔记', group: 'content', type: 'content',
    brand: '#4f8cff', icp: '京ICP备18062653号-16', adQuota: 2,
    about: '/about.html', privacy: '/about.html#privacy', sitemap: '/sitemap.xml',
    source: '内容由本站整理发布，教程与示例来自作者实操记录。',
    update: '按主题不定期更新，页面底部标注最近校验时间。',
  },
  {
    key: 'color-tool', domain: '2002cs.com', name: 'cs调色盘', label: 'cs调色盘',
    tagline: '免费在线配色、取色与色彩工具', group: 'tool', type: 'tool',
    brand: '#2457d6', icp: '京ICP备18062653号-22', adQuota: 1,
    about: '/about.html', privacy: '/about.html#privacy', sitemap: '/sitemap.xml',
    source: '色值数据来自公开色彩标准与本站整理的传统色名表。',
    update: '色库与工具随使用反馈迭代，不保留历史版本。',
  },
  {
    key: 'visitor', domain: 'fangkelianmeng.com', name: '访客小站', label: '访客小站',
    tagline: '纯静态、免登录的在线小工具集合', group: 'tool', type: 'tool',
    brand: '#2f6bff', icp: '京ICP备18062653号-23', adQuota: 1,
    about: '/about.html', privacy: '/about.html#privacy', sitemap: '/sitemap.xml',
    source: '工具在浏览器本地运算，除统计外不上传输入内容。',
    update: '工具按需增补，修复后直接发布新版本。',
  },
  {
    key: 'main-img', domain: 'img.fangkelianmeng.com', name: '小满美图', label: '小满美图',
    tagline: '图片素材浏览与分类画廊', group: 'gallery', type: 'gallery',
    brand: '#6366f1', icp: '京ICP备18062653号-23', adQuota: 1,
    about: '/about.html', privacy: '/about.html#privacy', sitemap: '/sitemap.xml',
    source: '图片索引来自本站内容接口，版权归原作者所有。',
    update: '分类与索引随上游内容同步刷新。',
  },
  {
    key: 'zangeng', domain: 'zangeng.com', name: '小满手记', label: '小满手记',
    tagline: '散文、读书摘录与日常短札', group: 'content', type: 'content',
    brand: '#3b6cff', icp: '京ICP备18062653号-26', adQuota: 2,
    about: '/about.html', privacy: '/about.html#privacy', sitemap: '/sitemap.xml',
    source: '全部文字为作者原创或注明出处的摘录。',
    update: '随写随发，不设固定更新周期。',
  },
  {
    key: 'notes', domain: '585.ink', name: '实测手记', label: '实测手记',
    tagline: '一个人把实测过程完整记下来', group: 'content', type: 'content',
    brand: '#1f7a5c', icp: '京ICP备18062653号-25', adQuota: 2,
    about: '/about.html', privacy: '/about.html#privacy', sitemap: '/sitemap.xml',
    source: '数据来自作者实机测试与公开资料，结论均标注测试环境。',
    update: '按实测项目推进，旧结论失效时会补注说明。',
  },
  {
    key: 'history', domain: '20101115.com', name: '年表拾遗', label: '年表拾遗',
    tagline: '只做年表，不做评论', group: 'content', type: 'content',
    brand: '#8c5a3c', icp: '京ICP备18062653号-24', adQuota: 2,
    about: '/about.html', privacy: '/about.html#privacy', sitemap: '/sitemap.xml',
    source: '年表以公开史料与中台结构化事件表为准。',
    update: '事件按考据结果增补，修订会在条目内标注。',
  },
  {
    key: 'coupon', domain: 'coupon.zangeng.com', name: '小满券仓', label: '小满券仓',
    tagline: '优惠券聚合、比价与领券指引', group: 'commerce', type: 'commerce',
    brand: '#2b52d8', icp: '京ICP备18062653号-26', adQuota: 3,
    about: '/about.html', privacy: '/about.html#privacy', sitemap: '/sitemap.xml',
    source: '券信息来自第三方联盟接口，价格与库存以商家页面为准。',
    update: '券数据按小时同步，过期券自动下架。',
  },
  {
    key: 'xuyiheng-tools', domain: 'xuyiheng.com', name: '一珩成长笔记', label: '一成长笔记',
    tagline: '生活计算、成长记录与实用工具', group: 'tool', type: 'tool',
    brand: '#4f46e5', icp: '京ICP备18062653号-13', adQuota: 1,
    about: '/about.html', privacy: '/privacy.html', sitemap: '/sitemap.xml',
    source: '工具算法与文案由本站整理，结果仅供日常参考。',
    update: '按使用反馈迭代，重大算法变更会在关于页说明。',
  },
  {
    key: 'store-web', domain: 'store.fangkelianmeng.com', name: '东北电动车汇', label: '东北电动车汇',
    tagline: '电动车选车看车与本地商家信息', group: 'commerce', type: 'commerce',
    brand: '#4B5BF0', icp: '京ICP备18062653号-23', adQuota: 3,
    about: '/about/wx.html', privacy: '/about/privacy.html', sitemap: '/sitemap.xml',
    source: '车型与商家信息来自中台内容库，购买前请以门店为准。',
    update: '车型与活动随中台内容同步更新。',
  },
];

const CONTACT_EMAIL = 'xlm8826@gmail.com';
const ICP_URL = 'https://beian.miit.gov.cn/';
// WO-194 公安备案号链接前缀（拼 recordcode 数字部分）；未申请到号码时页脚不输出链接
const GONGAN_URL = 'https://www.beian.gov.cn/portal/registerSystemInfo?recordcode=';
const HUB_PATH = '/sites.html';
const HUB_CANONICAL = 'https://xuliming.com/sites.html';

/** 与 main-api/shared/partials/index.js 的 SISTER_SITES 逐条一致 */
const SISTER_SITES = SITES.map(s => ({
  label: s.label + ' · ' + s.domain,
  url: 'https://' + s.domain + '/?src=hub',
}));

const SITE_KEYS = SITES.map(s => s.key);

function get(key) {
  return SITES.filter(s => s.key === key || s.domain === key)[0] || null;
}

/** 排除本站的 9 条跨站链接（顺序 = 注册表顺序） */
function sisterFor(key) {
  const self = get(key);
  const selfDomain = self ? self.domain : String(key || '');
  return SISTER_SITES.filter(s => s.url.indexOf('//' + selfDomain + '/') === -1);
}

/** 同类型的 3 个相关站点（不足则用其它类型补齐），用于页脚「相关站点」卡 */
function relatedFor(key, n) {
  const self = get(key);
  if (!self) return [];
  const others = SITES.filter(s => s.key !== self.key);
  const same = others.filter(s => s.group === self.group);
  const rest = others.filter(s => s.group !== self.group);
  return same.concat(rest).slice(0, n || 3).map(s => ({
    name: s.name, domain: s.domain, tagline: s.tagline,
    url: 'https://' + s.domain + '/?src=hub', group: s.group,
  }));
}

/** 广告硬配额（Site Shell Spec §5） */
function quotaFor(key) {
  const s = get(key);
  return { total: s ? s.adQuota : 2, aboveFold: 1, aux: 1, next: 1 };
}

/** 注入到每个 HTML 的浏览器侧配置（必须可 JSON 序列化） */
function configFor(key) {
  const s = get(key);
  if (!s) return null;
  return {
    version: SHELL_VERSION, key: s.key, domain: s.domain, name: s.name,
    tagline: s.tagline, brand: s.brand, type: s.type, quota: quotaFor(s.key),
    about: s.about, privacy: s.privacy, hub: HUB_PATH,
    sister: sisterFor(s.key), related: relatedFor(s.key, 3), siteCount: SITES.length,
  };
}

module.exports = {
  SHELL_VERSION, SITES, SITE_KEYS, SISTER_SITES,
  CONTACT_EMAIL, ICP_URL, GONGAN_URL, HUB_PATH, HUB_CANONICAL,
  get, sisterFor, relatedFor, quotaFor, configFor,
};
