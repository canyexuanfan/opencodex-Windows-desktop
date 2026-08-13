---
title: "OpenCode"
description: "OpenCode üzerinden yönlendirilen tüm modelleri kullanın — OpenCodex, çalışma zamanında bir sağlayıcı bloğu enjekte eder ve kendi OpenCode yapılandırmanıza dokunmaz."
---

OpenCode, sağlayıcılarını ortam değişkenleri yerine birleştirilmiş JSON yapılandırma katmanlarından okur. \`ocx opencode\`, proxy'nin çalıştığından emin olur, görünür katalogdan bir sağlayıcı bloğu oluşturur ve bunu OpenCode'un satır içi çalışma zamanı katmanı (\`OPENCODE_CONFIG_CONTENT\`) aracılığıyla enjekte eder.

## Hızlı Başlangıç

\`\`\`bash
ocx opencode
\`\`\`

Bu komut, proxy'nin çalıştığından emin olur ve yalnızca o süreç için oluşturulan \`provider.opencodex\` bloğu eklenmiş olarak OpenCode'u başlatır. Ek argümanlar doğrudan iletilir: \`ocx opencode run "merhaba"\`.

Yönlendirilen modeller seçicide \`opencodex\` sağlayıcısı altında görünür:

\`\`\`text
opencodex/kiro/glm-5
opencodex/gpt-5.6-sol      # yerel modeller ön ek almaz
\`\`\`

## Kendi Yapılandırmanız Asla Değiştirilmez

Başlatıcı, \`~/.config/opencode/opencode.json\`, proje \`opencode.json\` / \`opencode.jsonc\` veya diskteki başka bir yapılandırma katmanını kopyalamaz veya yeniden yazmaz. Mevcut sağlayıcılarınız, ajanlarınız, tuş atamalarınız, MCP girdileriniz ve göreli \`{file:…}\` referanslarınız orijinal dosyalarından çözümlenmeye devam eder.

| Katman | \`ocx opencode\` ile Davranış |
| --- | --- |
| Genel / özel / proje yapılandırması | Diskte tam olarak yazdığınız gibi bırakılır |
| Satır içi çalışma zamanı (\`OPENCODE_CONFIG_CONTENT\`) | Yalnızca oluşturulan \`provider.opencodex\` bloğunu alır |
| Göreli \`{file:…}\` yolları | İlk tanımlandıkları yapılandırma dosyasına göre çözümlenmeye devam eder |

## Bloğu Kendi Yapılandırmanıza Ekleme

\`ocx opencode\`, sağlayıcı bloğunu yalnızca tek bir başlatma için enjekte eder. Yönlendirilen modellerin doğrudan yalın \`opencode\` veya başlatıcıyı kullanmayan bir editör eklentisi tarafından kullanılabilmesini istediğinizde, \`ocx export\` aynı sağlayıcı bloğunu kendi yapılandırmanıza birleştirmeniz için yazdırır:

\`\`\`bash
ocx export --client opencode
\`\`\`

:::caution[Birleştirin, asla üzerine yazmayın]
\`provider.opencodex\` bloğunu mevcut yapılandırmanıza birleştirin. Tüm dosyanın üzerine dışa aktarılan dosyayı yazmak diğer sağlayıcılarınızı, ajanlarınızı ve MCP girdilerinizi yok eder. \`ocx export --out\` bu nedenle var olan bir dosyanın üzerine yazmayı reddeder:

\`\`\`bash
ocx export --client opencode --out ~/opencodex-opencode.json
\`\`\`

:::

Birleştirildikten sonra, proxy loopback üzerinde değilse başlatmadan önce kabul anahtarını dışa aktarın:

\`\`\`bash
export OPENCODEX_OPENCODE_API_KEY=<anahtarınız>
\`\`\`

## Kabul Anahtarı Diske Yazılmaz

Proxy bir API anahtarı gerektirdiğinde, satır içi çalışma zamanı yapılandırması gizli anahtar yerine OpenCode'un \`{env:…}\` referansını taşır.

Loopback örneği:

\`\`\`json
"options": {
  "baseURL": "http://127.0.0.1:10100/v1",
  "apiKey": "{env:OPENCODEX_OPENCODE_API_KEY}"
}
\`\`\`

Loopback harici örnek:

\`\`\`json
"options": {
  "baseURL": "http://192.168.1.10:10100/v1",
  "headers": {
    "x-opencodex-api-key": "{env:OPENCODEX_OPENCODE_API_KEY}"
  }
}
\`\`\`

## Geri Alma (Reverting)

Geri alınacak bir şey yoktur — \`~/.opencodex\` altında oluşturulmuş bir yapılandırma dosyası yazılmaz. Yalın \`opencode\` çalıştırdığınızda kendi yapılandırmanızı eskisi gibi okur.

## Gereksinimler

OpenCode kurulu ve \`PATH\` üzerinde bulunmalıdır:

\`\`\`bash
npm install -g opencode-ai
\`\`\`
