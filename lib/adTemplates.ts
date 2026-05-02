export interface AdContent {
  eyebrow: string
  headline: string
  bodyLine: string
  offers?: Array<{ name: string; price: string; label?: string }>
}

export function esc(s: string | undefined | null): string {
  if (!s) return ''
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}


export function buildAdHTML(
  content: AdContent,
  heroUri: string,
  iconUri: string | null,
  wordmarkUri: string | null,
): string {
  const hasOffers = Array.isArray(content.offers) && content.offers.length > 0

  const logoBar = (iconUri || wordmarkUri)
    ? `<div class="logo-bar">
        ${iconUri    ? `<img class="icon"     src="${iconUri}"     alt="">` : ''}
        ${wordmarkUri ? `<img class="wordmark" src="${wordmarkUri}" alt="">` : ''}
      </div>`
    : ''

  const bottomSection = hasOffers
    ? `<div class="offers-grid">
        ${content.offers!.map(o => `
          <div class="offer-item">
            <div class="offer-name">${esc(o.name)}</div>
            <div class="offer-price">${esc(o.price)}</div>
            <div class="offer-label">${esc(o.label ?? 'Spot Cash')}</div>
          </div>`).join('')}
      </div>`
    : `<div class="body-line">${esc(content.bodyLine)}</div>`

  const headlineSize = hasOffers ? '38px' : '48px'
  const headlineMargin = hasOffers ? '14px' : '20px'

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;1,400&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box;}
body{width:680px;height:850px;overflow:hidden;background:#07372f;}
.frame{position:relative;width:680px;height:850px;overflow:hidden;}
.hero{
  position:absolute;inset:0;
  background:url("${heroUri}") center/cover no-repeat;
}
.overlay{
  position:absolute;inset:0;
  background:linear-gradient(to bottom,
    rgba(7,55,47,0.18) 0%,
    rgba(7,55,47,0.25) 38%,
    rgba(7,55,47,0.72) 60%,
    rgba(7,55,47,0.96) 78%,
    rgba(7,55,47,1.00) 100%
  );
}
.border-outer{position:absolute;inset:16px;border:1.5px solid #b28648;pointer-events:none;z-index:10;}
.border-inner {position:absolute;inset:21px;border:0.5px solid #b28648;pointer-events:none;z-index:10;}
.logo-bar{
  position:absolute;top:38px;left:50%;transform:translateX(-50%);
  display:flex;align-items:center;gap:10px;
  background:rgba(7,55,47,0.55);backdrop-filter:blur(4px);
  padding:10px 22px 10px 14px;border-radius:4px;
  border:0.5px solid rgba(178,134,72,0.4);
  z-index:20;white-space:nowrap;
}
.logo-bar .icon    {width:88px;height:88px;object-fit:contain;}
.logo-bar .wordmark{height:72px;width:auto;object-fit:contain;filter:brightness(1.15);}
.copy{
  position:absolute;bottom:48px;left:0;right:0;
  text-align:center;padding:0 48px;z-index:20;
}
.eyebrow{
  font-family:'Cormorant Garamond','Times New Roman',Georgia,serif;
  font-size:11.5px;letter-spacing:0.32em;text-transform:uppercase;
  color:#d4a96a;font-weight:400;margin-bottom:12px;
}
.headline{
  font-family:'Cormorant Garamond','Times New Roman',Georgia,serif;
  font-size:${headlineSize};font-weight:600;color:#f7f3ee;
  line-height:1.08;margin-bottom:${headlineMargin};
}
.rule{display:flex;align-items:center;justify-content:center;gap:0;margin:0 auto 16px;}
.rule-dot{width:5px;height:5px;border-radius:50%;border:1px solid #b28648;background:#07372f;flex-shrink:0;}
.rule-line{width:48px;height:1.5px;background:#b28648;}
.body-line{
  font-family:'Cormorant Garamond','Times New Roman',Georgia,serif;
  font-size:18.5px;font-style:italic;font-weight:400;
  color:rgba(247,243,238,0.88);line-height:1.4;
}
.offers-grid{
  display:flex;gap:6px;
}
.offer-item{
  flex:1;
  background:rgba(7,55,47,0.88);
  border:1px solid rgba(178,134,72,0.45);
  border-top:2px solid #b28648;
  padding:11px 6px 10px;
  text-align:center;
}
.offer-name{
  font-family:'Cormorant Garamond','Times New Roman',Georgia,serif;
  font-size:9px;letter-spacing:0.16em;text-transform:uppercase;
  color:#d4a96a;margin-bottom:7px;line-height:1.35;
}
.offer-price{
  font-family:'Cormorant Garamond','Times New Roman',Georgia,serif;
  font-size:22px;font-weight:600;color:#f7f3ee;line-height:1;margin-bottom:4px;
}
.offer-label{
  font-family:'Cormorant Garamond','Times New Roman',Georgia,serif;
  font-size:8.5px;letter-spacing:0.12em;text-transform:uppercase;
  color:rgba(212,169,106,0.65);
}
</style>
</head>
<body>
<div class="frame">
  <div class="hero"></div>
  <div class="overlay"></div>
  <div class="border-outer"></div>
  <div class="border-inner"></div>
  ${logoBar}
  <div class="copy">
    <div class="eyebrow">${esc(content.eyebrow)}</div>
    <div class="headline">${esc(content.headline)}</div>
    <div class="rule">
      <div class="rule-dot"></div>
      <div class="rule-line"></div>
      <div class="rule-dot"></div>
    </div>
    ${bottomSection}
  </div>
</div>
</body>
</html>`
}
