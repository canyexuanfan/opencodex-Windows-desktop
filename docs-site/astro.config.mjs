// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// Project GitHub Pages site: https://lidge-jun.github.io/opencodex
// `site` + `base` make Starlight emit correct absolute URLs and asset paths under the repo subpath.
export default defineConfig({
  site: "https://lidge-jun.github.io",
  base: "/opencodex",
  trailingSlash: "ignore",
  integrations: [
    starlight({
      title: "opencodex",
      description:
        "Universal provider proxy for OpenAI Codex — use any LLM with Codex CLI, App, and SDK.",
      tagline: "Use any LLM with OpenAI Codex.",
      logo: {
        light: "./src/assets/logo-light.png",
        dark: "./src/assets/logo-dark.png",
        replacesTitle: false,
      },
      favicon: "/favicon.png",
      head: [
        { tag: "meta", attrs: { property: "og:image", content: "https://lidge-jun.github.io/opencodex/og.png" } },
        { tag: "meta", attrs: { property: "og:image:width", content: "1200" } },
        { tag: "meta", attrs: { property: "og:image:height", content: "630" } },
        { tag: "meta", attrs: { name: "twitter:card", content: "summary_large_image" } },
        { tag: "meta", attrs: { name: "twitter:image", content: "https://lidge-jun.github.io/opencodex/og.png" } },
      ],
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/lidge-jun/opencodex" },
      ],
      editLink: {
        baseUrl: "https://github.com/lidge-jun/opencodex/edit/main/docs-site/",
      },
      lastUpdated: true,
      // English at the site root; Korean under /ko, Simplified Chinese under /zh-cn.
      defaultLocale: "root",
      locales: {
        root: { label: "English", lang: "en" },
        ko: { label: "한국어", lang: "ko" },
        "zh-cn": { label: "简体中文", lang: "zh-CN" },
      },
      sidebar: [
        {
          label: "Getting Started",
          translations: { ko: "시작하기", "zh-CN": "开始使用" },
          items: [
            { label: "Installation", translations: { ko: "설치", "zh-CN": "安装" }, slug: "getting-started/installation" },
            { label: "Quickstart", translations: { ko: "빠른 시작", "zh-CN": "快速开始" }, slug: "getting-started/quickstart" },
            { label: "How It Works", translations: { ko: "동작 원리", "zh-CN": "工作原理" }, slug: "getting-started/how-it-works" },
          ],
        },
        {
          label: "Guides",
          translations: { ko: "가이드", "zh-CN": "指南" },
          items: [
            { label: "Providers", translations: { ko: "프로바이더", "zh-CN": "提供商" }, slug: "guides/providers" },
            { label: "Model Routing", translations: { ko: "모델 라우팅", "zh-CN": "模型路由" }, slug: "guides/model-routing" },
            { label: "Codex Integration", translations: { ko: "Codex 통합", "zh-CN": "Codex 集成" }, slug: "guides/codex-integration" },
            { label: "Codex App Model Picker", translations: { ko: "Codex App 모델 선택기", "zh-CN": "Codex App 模型选择器" }, slug: "guides/codex-app-models" },
            { label: "Sidecars: Web Search & Vision", translations: { ko: "사이드카: 웹 검색 & 비전", "zh-CN": "边车：网络搜索与视觉" }, slug: "guides/sidecars" },
            { label: "Web Dashboard", translations: { ko: "웹 대시보드", "zh-CN": "网页控制台" }, slug: "guides/web-dashboard" },
            { label: "Sub-agent Surface", translations: { ko: "서브에이전트 서피스", "zh-CN": "子代理界面" }, slug: "guides/sub-agent-surface" },
          ],
        },
        {
          label: "Reference",
          translations: { ko: "레퍼런스", "zh-CN": "参考" },
          items: [
            { label: "CLI", translations: { ko: "CLI", "zh-CN": "命令行" }, slug: "reference/cli" },
            { label: "Configuration", translations: { ko: "설정", "zh-CN": "配置" }, slug: "reference/configuration" },
            { label: "Adapters", translations: { ko: "어댑터", "zh-CN": "适配器" }, slug: "reference/adapters" },
            { label: "Architecture", translations: { ko: "아키텍처", "zh-CN": "架构" }, slug: "reference/architecture" },
          ],
        },
        { label: "Contributing", translations: { ko: "기여하기", "zh-CN": "贡献" }, slug: "contributing" },
      ],
    }),
  ],
});
