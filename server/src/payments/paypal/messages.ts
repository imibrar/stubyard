import type { GatewayCtx } from '../gateway.js';
import type { Locale } from '../kit/i18n.js';
import { amountOf, currencyOf, langOf, PROMO_RUNTIME, promoInfoReply, type PromoInfo } from '../sdk/promo.js';

/**
 * PayPal Pay Later messages (components=messages; R1 / the JS SDK reference): paypal.Messages({ amount, currency,
 * placement, style: { layout: "text" | "flex", color, logo }, onRender, onClick }).render(selector) and the
 * auto-render of [data-pp-message] elements (data-pp-amount, data-pp-placement, data-pp-currency,
 * data-pp-style-layout, data-pp-style-color) when the script loads. The message is neutral text with the TEST label;
 * "Learn more" opens the stubyard info popup (Pay in 4 every 2 weeks, simulated). Offers are not credit decisions.
 * Runs inside the SDK script (clientJs): uses SY, CFG, BASE, L and the paypal object.
 */
export const MESSAGES_JS = `${PROMO_RUNTIME}
  var MT = {
    en: { four: 'Pay in 4 interest-free payments of {a}. ', plain: 'Pay in 4 interest-free payments. ', more: 'Learn more', title: 'PayPal Pay Later (simulated)' },
    ar: { four: 'ادفع على 4 دفعات بدون فوائد بقيمة {a}. ', plain: 'ادفع على 4 دفعات بدون فوائد. ', more: 'اعرف المزيد', title: 'PayPal الدفع لاحقًا (محاكاة)' }
  };
  function ppMoney(v, cur) { return (cur === 'USD' ? '$' : cur + ' ') + v.toFixed(2); }
  function msgRender(host, o) {
    var t = MT[L], amount = PR.num(o.amount), cur = String(o.currency || CFG.currency || 'USD').toUpperCase(), style = o.style || {};
    var b = PR.box(host, 'stubyard-pp-message', L);
    b.setAttribute('data-placement', o.placement || ''); b.setAttribute('data-layout', style.layout || 'text');
    if (style.layout === 'flex') { b.style.padding = '12px'; b.style.borderRadius = '8px'; b.style.background = style.color === 'black' ? '#111' : style.color === 'white' ? '#fff' : '#eef2f7'; b.style.color = style.color === 'black' ? '#fff' : '#111'; }
    var p = document.createElement('p'); p.style.margin = '0'; p.setAttribute('data-testid', 'stubyard-promo-text');
    var mark = document.createElement('b'); mark.textContent = 'PayPal'; mark.style.marginInlineEnd = '6px';
    p.appendChild(mark);
    p.appendChild(document.createTextNode(amount ? t.four.replace('{a}', ppMoney(amount / 4, cur)) : t.plain));
    p.appendChild(PR.more(t.more, function () {
      if (o.onClick) { try { o.onClick(); } catch (e) { if (window.console) console.error(e); } }
      PR.popup(BASE + '/sdk/messages/learn-more?lang=' + L + '&currency=' + encodeURIComponent(cur) + (amount ? '&amount=' + amount : ''), t.title, L);
    }));
    b.appendChild(p);
    return b;
  }
  paypal.Messages = function (o) {
    o = o || {};
    return {
      render: function (sel) {
        var hosts = typeof sel === 'string' ? document.querySelectorAll(sel) : sel ? [sel] : [];
        if (!hosts.length) return Promise.reject(new Error('paypal.Messages: no element matches ' + sel));
        for (var i = 0; i < hosts.length; i++) msgRender(hosts[i], o);
        if (o.onRender) { try { o.onRender(); } catch (e) { if (window.console) console.error(e); } }
        return Promise.resolve();
      }
    };
  };
  function ppAuto() {
    var l = document.querySelectorAll('[data-pp-message]');
    for (var i = 0; i < l.length; i++) {
      var el = l[i];
      msgRender(el, { amount: el.getAttribute('data-pp-amount'), placement: el.getAttribute('data-pp-placement'), currency: el.getAttribute('data-pp-currency'), style: { layout: el.getAttribute('data-pp-style-layout'), color: el.getAttribute('data-pp-style-color') } });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ppAuto); else ppAuto();
`;

const TXT = {
  en: { title: 'Pay Later with PayPal', lead: 'Pay in 4 interest-free payments, every 2 weeks.', p: ['Today', 'In 2 weeks', 'In 4 weeks', 'In 6 weeks'], how: 'How it works', steps: ['Choose PayPal at checkout', 'Select Pay Later', 'Pay the first payment today', 'The rest is taken automatically'], note: 'Simulated by stubyard: no credit check, no real PayPal account. Real offers depend on the buyer country and amount.' },
  ar: { title: 'ادفع لاحقًا مع PayPal', lead: 'ادفع على 4 دفعات بدون فوائد، كل أسبوعين.', p: ['اليوم', 'بعد أسبوعين', 'بعد 4 أسابيع', 'بعد 6 أسابيع'], how: 'كيف تعمل', steps: ['اختر PayPal عند الدفع', 'اختر الدفع لاحقًا', 'ادفع الدفعة الأولى اليوم', 'تُخصم بقية الدفعات تلقائيًا'], note: 'محاكاة من stubyard: لا فحص ائتماني ولا حساب PayPal حقيقي.' },
};

function info(L: Locale, amount: number | null, currency: string): PromoInfo {
  const t = TXT[L];
  const part = amount ? (currency === 'USD' ? '$' : currency + ' ') + (amount / 4).toFixed(2) : null;
  return { provider: 'PayPal', lang: L, title: t.title, lead: t.lead, plan: part ? t.p.map((k) => [k, part] as [string, string]) : [], sections: [{ heading: t.how, items: t.steps }], note: t.note };
}

/** GET /sdk/messages/learn-more: the info popup of the Pay Later message. */
export function messagesInfo(c: GatewayCtx): unknown {
  c.resolved.endpoint = 'pay later info popup';
  return promoInfoReply(c, info(langOf(c.query.lang), amountOf(c.query.amount), currencyOf(c.query.currency, 'USD')));
}
